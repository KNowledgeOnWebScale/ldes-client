/** Helpers of the server probes: raw HTTP requests, and a page that is published to the folder the servers serve */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Publisher } from "../publisher.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WWW = path.resolve(here, "../../../reports/range-www");

/** One raw HTTP request: the body as it was sent, without decompression */
export function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on("error", reject);
        }).on("error", reject);
    });
}

/** A page of a publisher, written to the folder the servers serve, and grown by appending to the file */
export class Site {
    constructor(server, strategy, port) {
        this.publisher = new Publisher(strategy, `http://localhost:${port}/${server}`);
        this.written = 0;
        // Every run publishes the page from the start
        fs.rmSync(this.file, { force: true });
    }
    get url() {
        return this.publisher.rootUrl;
    }
    get file() {
        const base = new URL(this.url).pathname;
        return path.join(WWW, decodeURIComponent(base));
    }
    get body() {
        return this.publisher.pages.get(this.publisher.rootPath).body;
    }
    async append(count) {
        await this.publisher.append(count);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // Like a publisher that appends to a log: only the new bytes are written
        fs.appendFileSync(this.file, this.body.subarray(this.written));
        this.written = this.body.length;
    }
}
