/**
 * Quantifies the effort to stay in sync with a growing LDES 2.0, for the strategies of perf/range/publisher.mjs.
 *
 * For every strategy: the LDES starts with `--initial` members, and the client replicates it (cycle 0). Then, for
 * `--cycles` cycles, `--append` members are published and a new client with the saved state of the previous one
 * synchronizes again (the "yesterday / today" scenario: a restart with a saved bookmark).
 *
 * Measured per cycle: the requests and response body bytes on the wire (after Content-Encoding), HTTP statuses, the
 * CPU time of the client and of the server (including the compression a CDN does for every new version), the wall time,
 * and the number of members emitted, which must be exactly the number that was published.
 *
 *   npm run build
 *   LOG_LEVEL=error node perf/range/bench.mjs --initial 10000 --append 10 --cycles 20 --output reports/perf/range.json
 */
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { STRATEGIES } from "./publisher.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
    process.argv
        .slice(2)
        .join(" ")
        .split("--")
        .filter(Boolean)
        .map((part) => {
            const [key, ...value] = part.trim().split(/\s+/);
            return [key, value.join(" ") || "true"];
        }),
);
const initial = Number(args.initial ?? 10_000);
const append = Number(args.append ?? 10);
const cycles = Number(args.cycles ?? 20);
const headSize = Number(args["head-size"] ?? 1000);
const delay = Number(args.delay ?? 0);
const strategies = args.strategies ? args.strategies.split(",") : Object.keys(STRATEGIES);
const dist = path.resolve(args.dist ?? path.join(here, "../../dist"));
const { replicateLDES, MemoryStorage } = await import(pathToFileURL(path.join(dist, "lib/client.js")).href);

function startServer(port) {
    const child = fork(path.join(here, "server.mjs"), [String(port), String(delay)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let next = 0;
    const pending = new Map();
    const ready = new Promise((resolve) => {
        child.on("message", (message) => {
            if (message.ready) return resolve();
            const { id, result, error } = message;
            const callbacks = pending.get(id);
            pending.delete(id);
            if (error) callbacks.reject(new Error(error));
            else callbacks.resolve(result);
        });
    });
    const call = (cmd, callArgs) =>
        new Promise((resolve, reject) => {
            const id = next++;
            pending.set(id, { resolve, reject });
            child.send({ id, cmd, args: callArgs });
        });
    return { ready, call, stop: () => child.kill() };
}

async function sync(url, storage) {
    const cpu = process.cpuUsage();
    const started = performance.now();
    const client = replicateLDES({ url, storage, fetch: globalThis.fetch });
    let members = 0;
    for await (const _member of client.stream({ highWaterMark: 1000 })) members++;
    const used = process.cpuUsage(cpu);
    // The state that the client keeps between runs: the bookmark, with the ETags and range states of the pages
    const saved = await storage.store("ldes2").get(url);
    // The parser states in it (ldfetch's parserState), as JSON
    const parserStateBytes = Object.values(saved?.pages ?? {}).reduce(
        (sum, page) => sum + (page.range?.parserState ? JSON.stringify(page.range.parserState).length : 0),
        0,
    );
    return {
        members,
        wallMs: performance.now() - started,
        clientCpuMs: (used.user + used.system) / 1000,
        stateBytes: JSON.stringify(saved ?? {}).length,
        parserStateBytes,
    };
}

const results = [];
let port = 3110;
for (const strategy of strategies) {
    const server = startServer(port++);
    await server.ready;
    const { rootUrl, sizes: initialSizes } = await server.call("init", { strategy, initial, headSize });
    await server.call("stats");
    const storage = new MemoryStorage();
    const rows = [];
    // A head page goes through a whole period, from empty to sealed: its cost depends on how full it is
    const strategyCycles = STRATEGIES[strategy].layout === "head" ? Math.max(cycles, Math.ceil(headSize / append)) : cycles;
    for (let cycle = 0; cycle <= strategyCycles; cycle++) {
        let sizes = initialSizes;
        if (cycle > 0) {
            ({ sizes } = await server.call("append", { strategy, count: append }));
            await server.call("stats"); // the work of publishing is not part of the synchronization
        }
        const expected = cycle === 0 ? initial : append;
        const client = await sync(rootUrl, storage);
        const server_ = await server.call("stats");
        if (client.members !== expected) {
            console.error(`${strategy} cycle ${cycle}: emitted ${client.members} members, expected ${expected}`);
        }
        rows.push({ cycle, expected, ...client, ...server_, storedBytes: sizes.storedBytes, pages: sizes.pages });
    }
    server.stop();
    const later = rows.slice(1);
    const sum = (key) => later.reduce((total, row) => total + row[key], 0);
    const summary = {
        strategy,
        ...STRATEGIES[strategy],
        initialBytes: rows[0].bodyBytes,
        initialRequests: rows[0].requests,
        initialClientCpuMs: rows[0].clientCpuMs,
        initialWallMs: rows[0].wallMs,
        storedBytes: rows.at(-1).storedBytes,
        bytesPerCycle: sum("bodyBytes") / later.length,
        requestsPerCycle: sum("requests") / later.length,
        clientCpuMsPerCycle: sum("clientCpuMs") / later.length,
        serverCpuMsPerCycle: sum("serverCpuMs") / later.length,
        compressMsPerCycle: sum("compressMs") / later.length,
        wallMsPerCycle: sum("wallMs") / later.length,
        bytesPerMember: sum("bodyBytes") / sum("expected"),
        wireBytesPerCycle: sum("wireBytes") / later.length,
        stateBytes: rows.at(-1).stateBytes,
        parserStateBytes: rows.at(-1).parserStateBytes,
        correct: rows.every((row) => row.members === row.expected),
        statuses: later.reduce((all, row) => {
            for (const [status, n] of Object.entries(row.status)) all[status] = (all[status] ?? 0) + n;
            return all;
        }, {}),
    };
    results.push({ summary, rows });
    console.error(`done ${strategy}`);
}

const table = results.map(({ summary: s }) => ({
    strategy: s.strategy,
    "stored KB": (s.storedBytes / 1024).toFixed(0),
    "initial KB": (s.initialBytes / 1024).toFixed(0),
    "bytes/cycle": s.bytesPerCycle.toFixed(0),
    "bytes/member": s.bytesPerMember.toFixed(0),
    "wire bytes/cycle": s.wireBytesPerCycle.toFixed(0),
    "req/cycle": s.requestsPerCycle.toFixed(1),
    "client CPU ms/cycle": s.clientCpuMsPerCycle.toFixed(1),
    "server CPU ms/cycle": s.serverCpuMsPerCycle.toFixed(1),
    "gzip ms/cycle": s.compressMsPerCycle.toFixed(1),
    "wall ms/cycle": s.wallMsPerCycle.toFixed(1),
    "state KB": (s.stateBytes / 1024).toFixed(1),
    statuses: Object.entries(s.statuses)
        .map(([k, v]) => `${k}:${v}`)
        .join(" "),
    correct: s.correct,
}));
console.table(table);
if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify({ params: { initial, append, cycles, headSize, delay }, results }, null, 2));
}
