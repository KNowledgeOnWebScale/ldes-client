/**
 * Tests HTTP Range requests on growing LDES pages against real static file servers (see docker-compose.yml).
 *
 * Layer 1, HTTP: what each server answers to the requests the client makes, with raw requests (no decompression):
 * Range on a file, a range past the end, a range while gzip is accepted, a range right after the file grew, a .gz file,
 * and If-None-Match.
 * Layer 2, end to end: the client (dist/) replicates a page, the page grows, and a new client with the saved state
 * synchronizes again; it must emit exactly the new members, and should do so with a 206 (not a fallback to a full read).
 *
 *   docker compose -f perf/range/servers/docker-compose.yml up -d
 *   npm run build
 *   LOG_LEVEL=error node perf/range/servers/probe.mjs [--output reports/range-servers.json]
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Site, get } from "./site.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const SERVERS = { "nginx-plain": 8081, "nginx-gzip": 8082, "httpd-plain": 8083, "httpd-deflate": 8084, "caddy-gzip": 8085, python: 8086 };
const only = process.argv.includes("--servers") ? process.argv[process.argv.indexOf("--servers") + 1].split(",") : Object.keys(SERVERS);
const output = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : undefined;
const { replicateLDES, MemoryStorage } = await import(pathToFileURL(path.join(root, "dist/lib/client.js")).href);

const decoded = (res) => (res.headers["content-encoding"] === "gzip" ? gunzipSync(res.body) : res.body);

async function layer1(server, port) {
    const site = new Site(`${server}/probe`, "trig-range", port);
    await site.append(100);
    const gz = new Site(`${server}/probe`, "trig-range-gzmembers", port);
    await gz.append(100);
    const r = {};
    const identity = { "accept-encoding": "identity" };
    const gzip = { "accept-encoding": "gzip, deflate, br" };

    const full = await get(site.url, identity);
    r.get = {
        status: full.status,
        acceptRanges: full.headers["accept-ranges"] ?? null,
        etag: full.headers.etag ?? null,
        type: full.headers["content-type"],
    };
    r.get.sameBytes = full.body.equals(site.body);
    const zipped = await get(site.url, gzip);
    r.getGzip = {
        status: zipped.status,
        contentEncoding: zipped.headers["content-encoding"] ?? null,
        acceptRanges: zipped.headers["accept-ranges"] ?? null,
    };

    const length = site.body.length;
    const start = length - 32;
    const range = await get(site.url, { ...identity, range: `bytes=${start}-` });
    r.range = {
        status: range.status,
        contentRange: range.headers["content-range"] ?? null,
        contentEncoding: range.headers["content-encoding"] ?? null,
        correct: range.status === 206 && range.body.equals(site.body.subarray(start)),
    };
    const rangeGzip = await get(site.url, { ...gzip, range: `bytes=${start}-` });
    r.rangeWithGzipAccepted = {
        status: rangeGzip.status,
        contentRange: rangeGzip.headers["content-range"] ?? null,
        contentEncoding: rangeGzip.headers["content-encoding"] ?? null,
        bytes: rangeGzip.body.length,
        // 206 over the identity bytes is what the client needs; anything else makes it fall back
        identityBytes: rangeGzip.status === 206 && !rangeGzip.headers["content-encoding"] && rangeGzip.body.equals(site.body.subarray(start)),
    };
    const past = await get(site.url, { ...identity, range: `bytes=${length}-` });
    r.rangePastEnd = { status: past.status, contentRange: past.headers["content-range"] ?? null };

    const etag = full.headers.etag;
    if (etag) {
        const unchanged = await get(site.url, { ...identity, "if-none-match": etag });
        r.ifNoneMatch = { status: unchanged.status };
    }

    // The file grows: is the range answered from the new file right away, and does the ETag change?
    await site.append(10);
    const grown = await get(site.url, { ...identity, range: `bytes=${start}-` });
    r.rangeAfterAppend = {
        status: grown.status,
        contentRange: grown.headers["content-range"] ?? null,
        correct: grown.status === 206 && grown.body.equals(site.body.subarray(start)),
        etagChanged: (grown.headers.etag ?? null) !== (etag ?? null),
    };

    // A file that is compressed itself: it must not get a Content-Encoding (fetch would decompress it)
    const file = await get(gz.url, identity);
    const fileGzip = await get(gz.url, gzip);
    r.gzFile = {
        status: file.status,
        type: file.headers["content-type"],
        contentEncoding: file.headers["content-encoding"] ?? null,
        contentEncodingWhenGzipAccepted: fileGzip.headers["content-encoding"] ?? null,
        sameBytes: file.body.equals(gz.body) && decoded(fileGzip).equals(gz.body),
    };
    const gzRange = await get(gz.url, { ...identity, range: `bytes=${gz.body.length - 32}-` });
    r.gzFileRange = { status: gzRange.status, correct: gzRange.status === 206 && gzRange.body.equals(gz.body.subarray(-32)) };
    return r;
}

/** The client replicates, the page grows twice, and a new client with the saved state synchronizes each time */
async function layer2(server, port, strategy) {
    const site = new Site(`${server}/e2e`, strategy, port);
    await site.append(100);
    const storage = new MemoryStorage();
    const syncs = [];
    for (const appended of [0, 10, 25]) {
        if (appended) await site.append(appended);
        const requests = [];
        const recording = async (input, init) => {
            const response = await fetch(input, init);
            const headers = new Headers(init?.headers);
            requests.push({ range: headers.get("range"), status: response.status, encoding: response.headers.get("content-encoding") });
            return response;
        };
        const client = replicateLDES({ url: site.url, storage, fetch: recording });
        let members = 0;
        for await (const _member of client.stream({ highWaterMark: 1000 })) members++;
        const expected = appended || 100;
        syncs.push({
            expected,
            members,
            correct: members === expected,
            requests,
            // A later sync is resumed when it was answered with 206 or 416, and nothing was requested in full
            resumed: appended ? requests.length > 0 && requests.every((req) => req.range && (req.status === 206 || req.status === 416)) : undefined,
        });
    }
    return syncs;
}

const results = {};
for (const server of only) {
    const port = SERVERS[server];
    try {
        results[server] = { http: await layer1(server, port), e2e: {} };
        for (const strategy of ["trig-range", "trig-range-gzmembers", "jelly11-range"]) {
            results[server].e2e[strategy] = await layer2(server, port, strategy);
        }
    } catch (error) {
        results[server] = { error: String(error?.stack ?? error) };
    }
}

// Summary: one row per server
const yes = (value) => (value ? "yes" : "no");
console.table(
    Object.fromEntries(
        Object.entries(results).map(([server, r]) => {
            if (r.error) return [server, { error: r.error.split("\n")[0] }];
            const h = r.http;
            const e2e = (s) => {
                const [, ...later] = r.e2e[s];
                const ok = r.e2e[s].every((sync) => sync.correct);
                return `${ok ? "correct" : "WRONG"}, ${later.every((sync) => sync.resumed) ? "resumed" : "full read"}`;
            };
            return [
                server,
                {
                    "Range 206": yes(h.range.correct),
                    "416 past end": h.rangePastEnd.status === 416 ? "yes" : String(h.rangePastEnd.status),
                    "range + gzip accepted": `${h.rangeWithGzipAccepted.status}${h.rangeWithGzipAccepted.contentEncoding ? " " + h.rangeWithGzipAccepted.contentEncoding : ""}`,
                    "after append": yes(h.rangeAfterAppend.correct),
                    ".gz Content-Encoding": h.gzFile.contentEncoding ?? h.gzFile.contentEncodingWhenGzipAccepted ?? "none",
                    "e2e TriG": e2e("trig-range"),
                    "e2e .gz members": e2e("trig-range-gzmembers"),
                    "e2e Jelly 1.1": e2e("jelly11-range"),
                },
            ];
        }),
    ),
);
if (output) fs.writeFileSync(output, JSON.stringify(results, null, 2));
