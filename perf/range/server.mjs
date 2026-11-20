/**
 * The HTTP server of the benchmark, in a process of its own so that its CPU time is not counted as the client's.
 * It is controlled by its parent over IPC: { id, cmd: "init" | "append" | "stats" }.
 *
 * It answers like a static file server or CDN would:
 * - ETag and If-None-Match (304);
 * - Range: bytes=N- (206, or 416 when N is at or past the end);
 * - Content-Encoding gzip for pages that may be compressed, when the client accepts it and asks no range. The compressed
 *   body is cached per ETag, as a CDN does: it is compressed once for every new version of a page.
 */
import http from "http";
import { gzipSync } from "zlib";
import { Publisher } from "./publisher.mjs";

const port = Number(process.argv[2] ?? 3110);
const base = `http://localhost:${port}`;
const delay = Number(process.argv[3] ?? 0);
let publishers = new Map();
const compressed = new Map(); // etag -> gzip body
let stats;
const resetStats = () => {
    stats = { requests: 0, bodyBytes: 0, wireBytes: 0, status: {}, compressMs: 0, compressions: 0, serverCpuMs: 0 };
};
resetStats();
let cpuStart = process.cpuUsage();

function lookup(path) {
    for (const publisher of publishers.values()) {
        const page = publisher.pages.get(path);
        if (page) return page;
    }
    return undefined;
}

const server = http.createServer(async (req, res) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const page = lookup(req.url.split("?")[0]);
    stats.requests++;
    // Everything the server writes for this response, status line and headers included
    const written = req.socket.bytesWritten;
    res.on("finish", () => (stats.wireBytes += req.socket.bytesWritten - written));
    const send = (status, body = Buffer.alloc(0), headers = {}) => {
        stats.status[status] = (stats.status[status] ?? 0) + 1;
        stats.bodyBytes += body.length;
        res.writeHead(status, { "content-length": body.length, ...headers });
        res.end(body);
    };
    if (!page) return send(404);
    const common = { "content-type": page.type, etag: page.etag, "accept-ranges": page.compress ? "none" : "bytes" };
    if (req.headers["if-none-match"] === page.etag) return send(304, undefined, { etag: page.etag });
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range && !page.compress) {
        const start = Number(range[1]);
        if (start >= page.body.length) return send(416, undefined, { "content-range": `bytes */${page.body.length}` });
        return send(206, page.body.subarray(start), { ...common, "content-range": `bytes ${start}-${page.body.length - 1}/${page.body.length}` });
    }
    if (page.compress && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
        let body = compressed.get(page.etag);
        if (!body) {
            const t = performance.now();
            body = gzipSync(page.body);
            stats.compressMs += performance.now() - t;
            stats.compressions++;
            compressed.set(page.etag, body);
        }
        return send(200, body, { ...common, "content-encoding": "gzip", vary: "accept-encoding" });
    }
    return send(200, page.body, common);
});

process.on("message", async ({ id, cmd, args }) => {
    try {
        let result;
        if (cmd === "init") {
            publishers = new Map();
            compressed.clear();
            const publisher = new Publisher(args.strategy, base, { headSize: args.headSize });
            publishers.set(args.strategy, publisher);
            await publisher.append(args.initial);
            result = { rootUrl: publisher.rootUrl, sizes: sizes(publisher) };
        } else if (cmd === "append") {
            const publisher = publishers.get(args.strategy);
            await publisher.append(args.count);
            result = { sizes: sizes(publisher) };
        } else if (cmd === "stats") {
            const cpu = process.cpuUsage(cpuStart);
            result = { ...stats, serverCpuMs: (cpu.user + cpu.system) / 1000 };
            resetStats();
            cpuStart = process.cpuUsage();
        }
        process.send({ id, result });
    } catch (error) {
        process.send({ id, error: String(error?.stack ?? error) });
    }
});

function sizes(publisher) {
    let total = 0;
    for (const page of publisher.pages.values()) total += page.body.length;
    return { pages: publisher.pages.size, storedBytes: total };
}

server.listen(port, () => process.send({ ready: true }));
