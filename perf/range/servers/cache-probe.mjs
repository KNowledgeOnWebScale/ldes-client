/**
 * Tests HTTP Range requests on growing LDES pages through caching proxies (CDN-like, see docker-compose.yml).
 *
 * A cache may serve an old version of a page for a while: a sync that finds no new members is not an error. What must
 * hold is that no member is missed or emitted twice over a series of syncs, and that the client is not broken by what
 * the cache answers. Per proxy and page:
 *   1. the client replicates 100 members (the cache is filled);
 *   2. 10 members are appended, and a new client with the saved state syncs right away (the cache is still fresh, i.e. stale);
 *   3. after the cache time (5 s) it syncs again;
 *   4. 25 more members are appended, and after the cache time it syncs again;
 *   5. after another cache time, without new members, it syncs once more.
 * Expected: 35 new members in total over the syncs 2-5, each exactly once.
 *
 *   docker compose -f perf/range/servers/docker-compose.yml up -d
 *   npm run build
 *   LOG_LEVEL=error node perf/range/servers/cache-probe.mjs [--output reports/range-caches.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Site, get } from "./site.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const PROXIES = { "cache-plain": 8091, "cache-gzip-gunzip": 8092, "cache-gzip": 8093, "cache-slice": 8094, varnish: 8095, "cache-edge-gzip": 8096 };
const arg = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const only = arg("proxies")?.split(",") ?? Object.keys(PROXIES);
const TTL = 5_000;
const { replicateLDES, MemoryStorage } = await import(pathToFileURL(path.join(root, "dist/lib/client.js")).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the proxy answers to the raw requests of the client, right after the page grew (while its copy is fresh) */
async function http(proxy, port) {
    const site = new Site(`${proxy}/probe`, "trig-range", port);
    await site.append(100);
    const identity = { "accept-encoding": "identity" };
    const first = await get(site.url, { "accept-encoding": "gzip" });
    const start = site.body.length - 32;
    const r = { firstGet: { status: first.status, encoding: first.headers["content-encoding"] ?? null, cache: first.headers["x-cache-status"] } };
    const range = await get(site.url, { ...identity, range: `bytes=${start}-` });
    r.range = {
        status: range.status,
        encoding: range.headers["content-encoding"] ?? null,
        contentRange: range.headers["content-range"] ?? null,
        cache: range.headers["x-cache-status"],
        correct: range.status === 206 && range.body.equals(site.body.subarray(start)),
    };
    await site.append(10);
    const stale = await get(site.url, { ...identity, range: `bytes=${start}-` });
    r.rangeWhileStale = {
        status: stale.status,
        contentRange: stale.headers["content-range"] ?? null,
        cache: stale.headers["x-cache-status"],
        // A fresh copy of the old version: the overlap only, so the client finds nothing new yet
        oldVersion: stale.status === 206 && stale.body.length === 32,
        newVersion: stale.status === 206 && stale.body.equals(site.body.subarray(start)),
    };
    await sleep(TTL + 1000);
    const later = await get(site.url, { ...identity, range: `bytes=${start}-` });
    r.rangeAfterExpiry = {
        status: later.status,
        encoding: later.headers["content-encoding"] ?? null,
        cache: later.headers["x-cache-status"],
        newVersion: later.status === 206 && later.body.equals(site.body.subarray(start)),
    };
    return r;
}

async function e2e(proxy, port, strategy) {
    const site = new Site(`${proxy}/e2e`, strategy, port);
    await site.append(100);
    const storage = new MemoryStorage();
    const seen = new Map();
    const syncs = [];
    const steps = [
        { append: 0, wait: 0, label: "initial" },
        { append: 10, wait: 0, label: "right after append" },
        { append: 0, wait: TTL + 1000, label: "after cache time" },
        { append: 25, wait: TTL + 1000, label: "append, after cache time" },
        { append: 0, wait: TTL + 1000, label: "again after cache time" },
    ];
    for (const step of steps) {
        if (step.append) await site.append(step.append);
        if (step.wait) await sleep(step.wait);
        const requests = [];
        const recording = async (input, init) => {
            const response = await fetch(input, init);
            requests.push({
                range: new Headers(init?.headers).get("range"),
                status: response.status,
                encoding: response.headers.get("content-encoding"),
                cache: response.headers.get("x-cache-status"),
                length: Number(response.headers.get("content-length") ?? NaN),
            });
            return response;
        };
        let members = 0;
        let error;
        try {
            const client = replicateLDES({ url: site.url, storage, fetch: recording });
            for await (const member of client.stream({ highWaterMark: 1000 })) {
                members++;
                seen.set(member.id.value, (seen.get(member.id.value) ?? 0) + 1);
            }
        } catch (ex) {
            error = String(ex?.message ?? ex);
        }
        syncs.push({ step: step.label, members, requests, error });
    }
    const duplicates = [...seen.values()].filter((n) => n > 1).length;
    return { syncs, total: seen.size, duplicates, correct: seen.size === 135 && duplicates === 0 && syncs.every((s) => !s.error) };
}

const results = {};
for (const proxy of only) {
    const port = PROXIES[proxy];
    try {
        results[proxy] = { http: await http(proxy, port), e2e: {} };
        for (const strategy of ["trig-range", "trig-range-gzmembers", "jelly11-range"]) {
            results[proxy].e2e[strategy] = await e2e(proxy, port, strategy);
        }
    } catch (error) {
        results[proxy] = { error: String(error?.stack ?? error) };
    }
    console.error(`done ${proxy}`);
}

const how = (sync) =>
    sync.error
        ? `error`
        : `${sync.members} (${sync.requests.map((r) => `${r.range ? "range " : ""}${r.status}${r.encoding ? " " + r.encoding : ""}`).join(", ")})`;
console.table(
    Object.fromEntries(
        Object.entries(results).flatMap(([proxy, r]) => {
            if (r.error) return [[proxy, { error: r.error.split("\n")[0] }]];
            return Object.entries(r.e2e).map(([strategy, e]) => [
                `${proxy} ${strategy}`,
                {
                    "right after append": how(e.syncs[1]),
                    "after cache time": how(e.syncs[2]),
                    "append + cache time": how(e.syncs[3]),
                    "again after cache time": how(e.syncs[4]),
                    "each member once": e.correct ? "yes" : `NO (${e.total} seen, ${e.duplicates} twice)`,
                },
            ]);
        }),
    ),
);
const output = arg("output");
if (output) fs.writeFileSync(output, JSON.stringify(results, null, 2));
