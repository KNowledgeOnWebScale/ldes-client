// How long does it take before a member that is published is emitted by a client that polls? And what does it cost?
// A feed grows while a polling client (a process of its own) follows it: every member is stamped when it is
// published, and when the client emits it. The same feed is first replicated from its history, so that the price of a
// layout that has a low latency is visible: a replication that has become slow is not a gain.
// Formats: ldes1 (LDES 1.0 in TriG, unordered), ldes1o (LDES 1.0, ordered), trig (LDES 2.0 TriG messages), jelly (LDES 2.0 Jelly-RDF).
// Layouts: flat-N (a root that lists pages of N members), chain-N (the root links to the first page, every page to the next, LDES 1.0 only),
//          tiered-N / tchain-N: the history in pages of 1000, the pages that grow after that of N members.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { synthetic } from "./lib/datasets.mjs";
import { turtlePrefixes } from "./lib/fixtures.mjs";

const { values: options } = parseArgs({
    options: {
        formats: { type: "string", default: "ldes1,ldes1o,trig,jelly" },
        layouts: { type: "string", default: "flat-10,flat-100,flat-1000" },
        poll: { type: "string", default: "100" },
        history: { type: "string", default: "2000" },
        live: { type: "string", default: "150" },
        rate: { type: "string", default: "10" },
        etag: { type: "string", default: "true" },
        state: { type: "string", default: "memory" },
        config: { type: "string" },
        output: { type: "string" },
    },
});
const history = Number(options.history);
const live = Number(options.live);
const rate = Number(options.rate);
const etags = options.etag === "true";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
if (!existsSync(path.join(dist, "lib/client.js"))) throw new Error("Build the client first: npm run build");

const FORMATS = {
    ldes1: { fixture: "ldes1", ordered: "none", label: "LDES 1.0 unordered" },
    ldes1o: { fixture: "ldes1", ordered: "ascending", label: "LDES 1.0 ordered" },
    trig: { fixture: "ldes2", ordered: "none", label: "LDES 2.0 TriG" },
    jelly: { fixture: "jelly", ordered: "none", label: "LDES 2.0 Jelly" },
};
const trigPrefixes = turtlePrefixes.replace(/@prefix (\w+): (<[^>]+>) \./g, "PREFIX $1: $2");
const dataset = synthetic(history + live);
const path_ = `<${dataset.timestampPath}>`;
const sha = (body) => `"${createHash("sha1").update(body).digest("hex")}"`;

/** The pages of a feed that grows, in one of the formats. Member i is appended after member i - 1. */
class LiveFeed {
    constructor(base, name, fixture, layout) {
        this.base = base;
        this.name = name;
        this.fixture = fixture;
        this.chain = layout.chain;
        // Where the pages start: the history in pages of 1000 if the layout is tiered, then pages of `size`
        this.starts = [];
        const bigPages = layout.tiered ? Math.floor(history / 1000) : 0;
        for (let at = 0, k = 0; at < history + live; k++) {
            this.starts.push(at);
            at += k < bigPages ? 1000 : layout.size;
        }
        this.starts.push(history + live);
        this.count = 0;
        this.pages = new Map();
        this.closed = new Set();
        this.snippets = [];
        this.messages = new Map();
    }

    abs(url) {
        return `${this.base}${url}`;
    }

    pageUrl(k) {
        return `/${this.name}/page${k}`;
    }

    pageOf(i) {
        let k = 0;
        while (this.starts[k + 1] <= i) k++;
        return k;
    }

    get root() {
        return `/${this.name}/root`;
    }

    async append(i) {
        this.snippets[i] = dataset.snippet(i);
        const k = this.pageOf(i);
        const opens = i === this.starts[k];
        this.count = i + 1;
        if (opens && k > 0) this.closed.add(k - 1);
        await this.render(k);
        if (opens && k > 0) {
            // The page before closes: its content does not change, but it links to the next page in a chain
            if (this.chain) await this.render(k - 1);
            await this.renderRoot();
        }
    }

    pageCount() {
        return this.pageOf(this.count - 1) + 1;
    }

    async renderRoot() {
        const pages = Array.from({ length: this.pageCount() }, (_, k) => k);
        const collection = this.abs(`/${this.name}/collection`);
        let body;
        if (this.fixture === "ldes1") {
            body =
                turtlePrefixes +
                `<${collection}> a ldes:EventStream ; ldes:timestampPath ${path_} ; tree:view <${this.abs(this.root)}> .\n<${this.abs(this.root)}> a tree:Node .\n`;
            for (const k of this.chain ? [0] : pages) {
                body += `<${this.abs(this.root)}> tree:relation [ a tree:GreaterThanOrEqualToRelation ; tree:node <${this.abs(this.pageUrl(k))}> ; tree:path ${path_} ; tree:value "${dataset.time(this.starts[k])}"^^xsd:dateTime ] .\n`;
            }
            this.set(this.root, body, "application/trig");
            return;
        }
        const relations = pages.map((k) => {
            const closed = this.closed.has(k);
            const until = closed ? ` ; ldes:timeUntil "${dataset.time(this.starts[k + 1] - 1)}"^^xsd:dateTime` : "";
            return `[ ldes:page <${this.abs(this.pageUrl(k))}> ; ldes:timeFrom "${dataset.time(this.starts[k])}"^^xsd:dateTime${until} ]`;
        });
        const description = `ex:ES a ldes:EventStream ; ldes:timestampPath ${path_} ; ${dataset.membership} .\n<${this.abs(this.root)}> ldes:relation ${relations.join(" , ")} .\n`;
        await this.setMessages(this.root, [description]);
    }

    async render(k) {
        if (k === 0 && this.pageCount() === 1 && !this.pages.has(this.root)) await this.renderRoot();
        const from = this.starts[k];
        const to = Math.min(this.count, this.starts[k + 1]);
        if (this.fixture === "ldes1") {
            const collection = this.abs(`/${this.name}/collection`);
            let body = turtlePrefixes + `<${this.abs(this.pageUrl(k))}> a tree:Node .\n`;
            if (this.chain && k < this.pageCount() - 1) {
                body += `<${this.abs(this.pageUrl(k))}> tree:relation [ a tree:GreaterThanOrEqualToRelation ; tree:node <${this.abs(this.pageUrl(k + 1))}> ; tree:path ${path_} ; tree:value "${dataset.time(this.starts[k + 1])}"^^xsd:dateTime ] .\n`;
            }
            const ids = Array.from({ length: to - from }, (_, j) => `<${dataset.id(from + j)}>`).join(", ");
            body += `<${collection}> tree:member ${ids} .\n` + this.snippets.slice(from, to).join("\n") + "\n";
            this.set(this.pageUrl(k), body, "application/trig");
            return;
        }
        await this.setMessages(this.pageUrl(k), this.snippets.slice(from, to));
    }

    async setMessages(url, messages) {
        if (this.fixture === "ldes2") {
            this.set(url, `VERSION "1.2-messages"\n${trigPrefixes}${messages.join("\nMESSAGE\n")}`, "application/trig");
            return;
        }
        const { parseMessages } = await import("n3.js-messages");
        const { Writer } = await import("rdfjs-jelly");
        const writer = new Writer({ packMessages: false });
        for (const message of messages) {
            if (!this.messages.has(message)) this.messages.set(message, [...parseMessages(`VERSION "1.2-messages"\n${trigPrefixes}${message}`)]);
            for (const parsed of this.messages.get(message)) writer.addMessage(parsed);
        }
        const body = await new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes)))));
        this.set(url, body, "application/x-jelly-rdf");
    }

    set(url, body, type) {
        this.pages.set(url, { body, type, etag: sha(body) });
    }
}

let feed;
let requests = 0;
const perUrl = new Map();
let bytes = 0;
const server = http.createServer((request, response) => {
    const page = feed?.pages.get(request.url.split("?")[0]);
    if (!page) return response.writeHead(404).end();
    requests++;
    perUrl.set(request.url, (perUrl.get(request.url) ?? 0) + 1);
    const closed = [...feed.closed].some((k) => feed.pageUrl(k) === request.url.split("?")[0]);
    const headers = { "content-type": page.type, "cache-control": closed ? "public, max-age=31536000, immutable" : "no-cache" };
    if (etags) {
        headers.etag = page.etag;
        if (request.headers["if-none-match"] === page.etag) return response.writeHead(304, headers).end();
    }
    bytes += page.body.length;
    response.writeHead(200, headers).end(page.body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function scenario(formatKey, layoutKey, pollMs) {
    const format = FORMATS[formatKey];
    const [kind, sizeText] = layoutKey.split("-");
    const layout = { size: Number(sizeText), chain: kind === "chain" || kind === "tchain", tiered: kind === "tiered" || kind === "tchain" };
    feed = new LiveFeed(base, `${formatKey}-${layoutKey}`, format.fixture, layout);
    if (layout.chain && format.fixture !== "ldes1") return { skipped: "a chain is an LDES 1.0 layout" };

    // The history is there before the client starts
    for (let i = 0; i < history; i++) {
        feed.snippets[i] = dataset.snippet(i);
    }
    feed.count = history;
    for (let k = 0; k < feed.pageOf(history - 1); k++) feed.closed.add(k);
    await feed.renderRoot();
    for (let k = 0; k < feed.pageCount(); k++) await feed.render(k);

    const indexOf = new Map(Array.from({ length: history + live }, (_, i) => [dataset.id(i), i]));
    const emittedAt = new Array(history + live);
    let received = 0;
    let readyAt;
    const child = spawn(
        process.execPath,
        [
            path.join(here, "lib/live-client.mjs"),
            dist,
            base + feed.root,
            format.ordered,
            String(pollMs),
            options.state,
            ...(options.config ? [options.config] : []),
        ],
        {
            env: { ...process.env, LOG_LEVEL: "error" },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
            const [id, time] = buffer.slice(0, at).split("\t");
            buffer = buffer.slice(at + 1);
            if (id === "ready") readyAt = Number(time);
            else if (indexOf.has(id) && emittedAt[indexOf.get(id)] === undefined) {
                emittedAt[indexOf.get(id)] = Number(time);
                received++;
            }
        }
    });
    const waitFor = async (predicate, ms) => {
        for (const deadline = Date.now() + ms; Date.now() < deadline;) {
            if (predicate()) return true;
            await sleep(5);
        }
        return false;
    };
    try {
        // 1. Replicate the history
        if (!(await waitFor(() => received >= history, 120_000))) throw new Error(`replication did not finish: ${received}/${history} ${stderr}`);
        const lastHistory = Math.max(...emittedAt.slice(0, history));
        const syncSeconds = (lastHistory - readyAt) / 1000;
        await sleep(Math.max(500, pollMs * 3));

        // 2. Publish, one member at a time, while the client polls
        requests = 0;
        bytes = 0;
        perUrl.clear();
        const publishedAt = [];
        const started = Date.now();
        for (let j = 0; j < live; j++) {
            const i = history + j;
            await feed.append(i);
            publishedAt[i] = Date.now();
            const wait = started + ((j + 1) * 1000) / rate - Date.now();
            if (wait > 0) await sleep(wait);
        }
        await waitFor(() => received >= history + live, 15_000);
        if (process.env.DEBUG_URLS)
            process.stderr.write(
                `  requests per url: ${[...perUrl]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([u, n]) => `${u.split("/").pop()}=${n}`)
                    .join(" ")} (${perUrl.size} urls)\n`,
            );
        const latencies = [];
        for (let i = history; i < history + live; i++) if (emittedAt[i] !== undefined) latencies.push(emittedAt[i] - publishedAt[i]);
        latencies.sort((a, b) => a - b);
        return {
            format: formatKey,
            layout: layoutKey,
            pollMs,
            pages: feed.pageCount(),
            syncSeconds,
            syncRate: history / syncSeconds,
            missing: live - latencies.length,
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            max: latencies.at(-1),
            requestsPerMember: requests / live,
            kibPerMember: bytes / 1024 / live,
        };
    } finally {
        child.kill("SIGKILL");
    }
}

const results = [];
try {
    for (const layoutKey of options.layouts.split(","))
        for (const formatKey of options.formats.split(",")) {
            for (const pollText of options.poll.split(",")) {
                process.stderr.write(`${formatKey} ${layoutKey} poll ${pollText} ms\n`);
                try {
                    const result = await scenario(formatKey, layoutKey, Number(pollText));
                    if (result.skipped) continue;
                    results.push(result);
                    process.stderr.write(
                        `  sync ${result.syncRate.toFixed(0)}/s  latency p50 ${result.p50} p95 ${result.p95} max ${result.max} ms  ${result.requestsPerMember.toFixed(1)} req/member  ${result.kibPerMember.toFixed(1)} KiB/member${result.missing ? `  MISSING ${result.missing}` : ""}\n`,
                    );
                } catch (error) {
                    process.stderr.write(`  FAILED: ${error.message}\n`);
                    results.push({ format: formatKey, layout: layoutKey, pollMs: Number(pollText), failed: error.message });
                }
            }
        }
} finally {
    server.close();
    server.closeAllConnections();
}

const meta = {
    node: process.version,
    cpu: os.cpus()[0].model,
    history,
    live,
    rate,
    etags,
    state: options.state,
    config: options.config ?? "defaults",
};
console.log(JSON.stringify(meta));
const fmt = (n) => (n >= 100 ? Math.round(n).toLocaleString("en") : n.toFixed(1));
console.log(
    "\n| Layout | Format | poll ms | pages | replication members/s | latency p50 ms | p95 ms | max ms | requests/member | KiB/member |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const r of results) {
    console.log(
        r.failed
            ? `| ${r.layout} | ${FORMATS[r.format].label} | ${r.pollMs} | | ✗ ${r.failed} | | | | | |`
            : `| ${r.layout} | ${FORMATS[r.format].label} | ${r.pollMs} | ${r.pages} | ${fmt(r.syncRate)} | ${r.p50} | ${r.p95} | ${r.max} | ${r.requestsPerMember.toFixed(1)} | ${r.kibPerMember.toFixed(1)} |`,
    );
}
if (options.output) {
    mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    writeFileSync(options.output, JSON.stringify({ meta, results }, null, 2) + "\n");
}
process.exit(0);
