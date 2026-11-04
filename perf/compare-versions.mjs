/**
 * A quick performance check that replicates the same members with
 *   1. a baseline build of the client (for example `main`) over an LDES 1.0,
 *   2. this build over the same LDES 1.0,
 *   3. this build over the same members as an LDES 2.0.
 *
 * Every case runs in a fresh child process (clean heap, own copy of the modules) against a local server, and is
 * measured on: time, members per second, peak memory (RSS) and the longest time that the event loop was blocked.
 * Two layouts of the same members are used: a paged one, and everything in one very large page.
 *
 * Usage (after `npm run build`):
 *   node perf/compare-versions.mjs --baseline ../ldes-client-main [--members 10000] [--page-size 1000]
 *
 * The baseline is a checkout of the client of which `dist` has been built, for example:
 *   git worktree add ../ldes-client-main origin/main && (cd ../ldes-client-main && npm ci && npm run build)
 * Without --baseline, only this build is measured. The baseline cannot read an LDES 2.0, so that case is skipped for it.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const PORT = 3097;
const BASE = `http://localhost:${PORT}`;

/* ------------------------------------------------------------------ child: one replication, one measurement */
if (process.argv[2] === "--child") {
    const [, , , dist, url, ordered] = process.argv;
    const { replicateLDES } = await import(pathToFileURL(path.join(dist, "lib/client.js")).href);

    let last = performance.now();
    let maxBlocked = 0;
    let peakRss = 0;
    const sampler = setInterval(() => {
        const now = performance.now();
        maxBlocked = Math.max(maxBlocked, now - last - 10);
        last = now;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);

    const started = performance.now();
    // Extra configuration of the client, as JSON (for example {"concurrentFetches": 2}), for experiments
    const extra = process.env.LDES_CLIENT_CONFIG ? JSON.parse(process.env.LDES_CLIENT_CONFIG) : {};
    const client = replicateLDES({ url, ...extra }, ordered);
    let members = 0;
    for await (const _ of client.stream({ highWaterMark: 100 })) members++;
    const seconds = (performance.now() - started) / 1000;
    clearInterval(sampler);
    console.log(JSON.stringify({ members, seconds, maxBlocked, peakRss }));
    process.exit(0);
}

/* ------------------------------------------------------------------ parent: data, server and report */
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};
const MEMBERS = Number(option("--members", 10000));
const PAGE_SIZE = Number(option("--page-size", 1000));
const ORDERED = option("--ordered", "none");
const TIMEOUT_MS = Number(option("--timeout", 600) * 1000);
const here = path.dirname(fileURLToPath(import.meta.url));
const current = path.resolve(here, "../dist");
const baseline = option("--baseline") && path.resolve(option("--baseline"), "dist");

const time = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const member = (i) =>
    `ex:m${i} a ex:Record ; dcterms:created "${time(i)}"^^xsd:dateTime ; ex:a "v${i}" ; ex:b ${i} ; ` +
    `ex:c [ ex:d "x${i}" ; ex:e ex:o${i % 50} ] ; ex:f "text text text ${i}" .`;
const PREFIXES = {
    ldes: "https://w3id.org/ldes#",
    tree: "https://w3id.org/tree#",
    ex: "http://example.org/",
    dcterms: "http://purl.org/dc/terms/",
    xsd: "http://www.w3.org/2001/XMLSchema#",
};
const turtlePrefixes = Object.entries(PREFIXES).map(([k, v]) => `@prefix ${k}: <${v}> .`).join("\n") + "\n";
const trigPrefixes = Object.entries(PREFIXES).map(([k, v]) => `PREFIX ${k}: <${v}>`).join("\n") + "\n";
const ranges = (members, size) =>
    Array.from({ length: Math.ceil(members / size) }, (_, p) => [p * size, Math.min(members, (p + 1) * size)]);

const pages = new Map();

/** LDES 1.0: a collection with a view; the members are in the pages the view relates to, or in the view itself */
function ldes1(name, members, size) {
    const root = `${BASE}/${name}/root`;
    const collection = `${BASE}/${name}/collection`;
    const list = (from, to) => `<${collection}> tree:member ${Array.from({ length: to - from }, (_, k) => `ex:m${from + k}`).join(", ")} .\n` +
        Array.from({ length: to - from }, (_, k) => member(from + k)).join("\n") + "\n";
    const head = `<${collection}> a ldes:EventStream ; ldes:timestampPath dcterms:created ; tree:view <${root}> .\n<${root}> a tree:Node .\n`;
    if (size >= members) {
        pages.set(`/${name}/root`, turtlePrefixes + head + list(0, members));
    } else {
        const parts = ranges(members, size);
        pages.set(`/${name}/root`, turtlePrefixes + head + parts.map(([from], p) =>
            `<${root}> tree:relation [ a tree:GreaterThanOrEqualToRelation ; tree:node <${BASE}/${name}/page${p}> ; tree:path dcterms:created ; tree:value "${time(from)}"^^xsd:dateTime ] .`).join("\n") + "\n");
        parts.forEach(([from, to], p) => pages.set(`/${name}/page${p}`, turtlePrefixes + `<${BASE}/${name}/page${p}> a tree:Node .\n` + list(from, to)));
    }
    return root;
}

/** LDES 2.0: the same members, one message per member */
function ldes2(name, members, size) {
    const root = `${BASE}/${name}/root`;
    const messages = (from, to) => Array.from({ length: to - from }, (_, k) => "MESSAGE\n" + member(from + k)).join("\n") + "\n";
    const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .\n`;
    const body = (text) => `VERSION "1.2-messages"\n${trigPrefixes}${text}`;
    if (size >= members) {
        pages.set(`/${name}/root`, { type: "application/trig", body: body(description + messages(0, members)) });
    } else {
        const parts = ranges(members, size);
        pages.set(`/${name}/root`, { type: "application/trig", body: body(description + `<> ldes:relation ${parts.map(([from, to], p) =>
            `[ ldes:page <${BASE}/${name}/page${p}> ; ldes:timeFrom "${time(from)}"^^xsd:dateTime ; ldes:timeUntil "${time(to)}"^^xsd:dateTime ]`).join(" , ")} .\n`.replaceAll("<>", `<${root}>`)) });
        parts.forEach(([from, to], p) => pages.set(`/${name}/page${p}`, { type: "application/trig", body: body(messages(from, to).replace(/^MESSAGE\n/, "")) }));
    }
    return root;
}

const layouts = [
    { name: `paged (${Math.ceil(MEMBERS / PAGE_SIZE)} pages of ${PAGE_SIZE})`, size: PAGE_SIZE },
    { name: `one page of ${MEMBERS}`, size: MEMBERS },
];
const cases = [];
for (const [i, layout] of layouts.entries()) {
    cases.push({ layout: layout.name, label: "baseline, LDES 1.0", dist: baseline, url: ldes1(`v1-${i}`, MEMBERS, layout.size) });
    cases.push({ layout: layout.name, label: "this branch, LDES 1.0", dist: current, url: ldes1(`v1-${i}`, MEMBERS, layout.size) });
    cases.push({ layout: layout.name, label: "this branch, LDES 2.0", dist: current, url: ldes2(`v2-${i}`, MEMBERS, layout.size) });
}

const server = http.createServer((request, response) => {
    const page = pages.get(request.url.split("?")[0]);
    if (!page) return response.writeHead(404).end();
    const { body, type } = typeof page === "string" ? { body: page, type: "text/turtle" } : page;
    response.writeHead(200, { "content-type": type }).end(body);
});
await new Promise((resolve) => server.listen(PORT, resolve));

function measure(dist, url) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", dist, url, ORDERED], {
            env: { ...process.env, LOG_LEVEL: "error" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ failed: `timeout after ${TIMEOUT_MS / 1000}s` }); }, TIMEOUT_MS);
        child.on("exit", () => {
            clearTimeout(timer);
            try { resolve(JSON.parse(out.trim().split("\n").pop())); }
            catch { resolve({ failed: (err || out).trim().split("\n").filter((l) => !l.includes("rdf-lens")).slice(-1)[0] || "failed" }); }
        });
    });
}

console.log(`${MEMBERS} members, ordered: ${ORDERED}${baseline ? `, baseline: ${baseline}` : ", no baseline"}\n`);
const rows = [];
for (const c of cases) {
    if (!c.dist) continue;
    process.stderr.write(`running: ${c.layout} / ${c.label} ...\n`);
    const result = await measure(c.dist, c.url);
    rows.push({ ...c, ...result });
}
server.close();

const fmt = (n, digits = 1) => Number(n).toFixed(digits);
console.log(["layout".padEnd(26), "client".padEnd(24), "members".padStart(8), "time (s)".padStart(9), "members/s".padStart(10), "peak RSS".padStart(10), "longest block".padStart(14)].join("  "));
for (const r of rows) {
    console.log([
        r.layout.padEnd(26), r.label.padEnd(24),
        r.failed ? `FAILED: ${r.failed}` : [
            String(r.members).padStart(8), fmt(r.seconds).padStart(9), fmt(r.members / r.seconds, 0).padStart(10),
            `${fmt(r.peakRss / 1048576, 0)} MB`.padStart(10), `${fmt(r.maxBlocked, 0)} ms`.padStart(14),
        ].join("  "),
    ].join("  "));
}
for (const layout of layouts) {
    const get = (label) => rows.find((r) => r.layout === layout.name && r.label === label && !r.failed);
    const base = get("baseline, LDES 1.0");
    const now = get("this branch, LDES 1.0");
    const two = get("this branch, LDES 2.0");
    const notes = [];
    if (base && now) notes.push(`1.0: this branch is ${fmt(base.seconds / now.seconds)}x as fast as the baseline`);
    if (now && two) notes.push(`2.0 is ${fmt(now.seconds / two.seconds)}x as fast as 1.0 on this branch`);
    if (notes.length) console.log(`\n${layout.name}: ${notes.join("; ")}`);
}
process.exit(0);
