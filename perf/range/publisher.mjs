/**
 * Publishes an LDES 2.0 that grows, in the layouts and serializations that are compared:
 *
 * - `single`: the whole LDES is one page that only grows (infinite retention). The client continues it with
 *   HTTP Range requests (`ldes:rangeRequests true`), or requests it again with its ETag.
 * - `head`: the approach of issue #118: immutable pages of `headSize` members, and a small mutable head page that is
 *   requested again with its ETag. The root page links to all of them, and changes when the head page is sealed.
 *
 * Serializations: TriG, Jelly 1.1 that can be continued (perf/range/jelly11.mjs), and Jelly 1.2 by rdfjs-jelly: appended
 * with a flush per publication (for range requests), or written again as a whole (for ETags).
 * Compression: none, Content-Encoding gzip (as a CDN would compress every new version), or a gzip file to which
 * every publication is appended as a new gzip member (incremental compression).
 */
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { Parser } from "n3";
import { RdfStreamType, Writer } from "rdfjs-jelly";
import { member } from "../lib/fixtures.mjs";
import { ResumableJellyWriter } from "./jelly11.mjs";

const PREFIXES = {
    ldes: "https://w3id.org/ldes#",
    ex: "http://example.org/",
    dcterms: "http://purl.org/dc/terms/",
    xsd: "http://www.w3.org/2001/XMLSchema#",
};
const trigPrefixes = Object.entries(PREFIXES)
    .map(([k, v]) => `PREFIX ${k}: <${v}>`)
    .join("\n");
const DESCRIPTION = "ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .";

/** The strategies that are compared. `range` pages say `ldes:rangeRequests true`. */
export const STRATEGIES = {
    "trig-etag": { layout: "single", syntax: "trig", encoding: "identity", range: false },
    "trig-etag-gzip": { layout: "single", syntax: "trig", encoding: "gzip", range: false },
    "trig-range": { layout: "single", syntax: "trig", encoding: "identity", range: true },
    "trig-range-gzmembers": { layout: "single", syntax: "trig", encoding: "members", range: true },
    "trig-head-etag-gzip": { layout: "head", syntax: "trig", encoding: "gzip", range: false },
    "jelly11-range": { layout: "single", syntax: "jelly11", encoding: "identity", range: true },
    "jelly11-range-gzmembers": { layout: "single", syntax: "jelly11", encoding: "members", range: true },
    "jelly12-range": { layout: "single", syntax: "jelly12-append", encoding: "identity", range: true },
    "jelly12-range-gzmembers": { layout: "single", syntax: "jelly12-append", encoding: "members", range: true },
    "jelly12-etag-gzip": { layout: "single", syntax: "jelly12", encoding: "gzip", range: false },
    "jelly12-head-etag-gzip": { layout: "head", syntax: "jelly12", encoding: "gzip", range: false },
};

const parsed = [];
const memberQuads = (i) => (parsed[i] ??= new Parser({ blankNodePrefix: `b${i}_` }).parse(`${trigPrefixes}\n${member(i)}`));
const memberTrig = (i) => `MESSAGE\n${member(i)}\n`;

/** A whole Jelly 1.2 stream, with the default batches of rdfjs-jelly */
async function jelly12(messages) {
    const writer = new Writer({ version: 3, streamType: RdfStreamType.MESSAGES });
    for (const message of messages) writer.addMessage(message);
    return new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes)))));
}

/**
 * Jelly 1.2 as a publisher appends it: one streaming writer with its default (shared) lookup tables, and a flush at the
 * end of every publication, so that every publication ends at a batch and message boundary
 */
class AppendingJelly12 {
    constructor() {
        this.written = [];
        this.writer = new Writer(
            {
                write: (bytes, done) => {
                    this.written.push(Buffer.from(bytes));
                    done?.();
                },
                end: (done) => done?.(),
            },
            { version: 3, streamType: RdfStreamType.MESSAGES },
        );
    }

    /** Writes the messages of one publication, and gives the bytes that it appends */
    publish(messages) {
        for (const message of messages) this.writer.addMessage(message);
        this.writer.flush();
        const chunk = Buffer.concat(this.written);
        this.written = [];
        return chunk;
    }
}

const etagOf = (body) => `"${createHash("sha1").update(body).digest("base64url")}"`;

/**
 * The pages of one strategy. `append(count)` publishes the next members; `pages` maps a path to what the server sends:
 * the body (as it is stored), its media type, ETag, and whether the server may compress it with Content-Encoding gzip.
 */
export class Publisher {
    constructor(name, base, { headSize = 1000 } = {}) {
        this.strategy = STRATEGIES[name];
        if (!this.strategy) throw new Error(`Unknown strategy ${name}`);
        this.name = name;
        this.base = base;
        this.headSize = headSize;
        this.count = 0;
        this.pages = new Map();
        const ext = { trig: "trig", jelly11: "jelly", jelly12: "jelly", "jelly12-append": "jelly" }[this.strategy.syntax];
        this.type = ext === "trig" ? "application/trig" : "application/x-jelly-rdf";
        const gz = this.strategy.encoding === "members" ? ".gz" : "";
        this.rootPath = this.strategy.layout === "single" ? `/${name}/log.${ext}${gz}` : `/${name}/root.trig`;
        this.ext = ext;
        // single page, appended: its chunks (one per publication), and the writer that keeps the Jelly lookup tables
        this.chunks = [];
        this.jellyWriter = new ResumableJellyWriter();
        this.jelly12Writer = new AppendingJelly12();
        // head layout: sealed pages, and the members of the head page
        this.sealed = 0;
    }

    get rootUrl() {
        return this.base + this.rootPath;
    }

    /** The description message, with the page that the client should continue with range requests */
    descriptionTrig(pageUrl, extra = "") {
        return `${DESCRIPTION}\n${this.strategy.range ? `<${pageUrl}> ldes:rangeRequests true .\n` : ""}${extra}`;
    }

    async append(count) {
        const from = this.count;
        this.count += count;
        if (this.strategy.layout === "single") await this.appendSingle(from, this.count);
        else await this.publishHead();
    }

    async appendSingle(from, to) {
        const { syntax, encoding } = this.strategy;
        const url = this.rootUrl;
        let chunk;
        if (syntax === "trig") {
            const head = from === 0 ? `VERSION "1.2-messages"\n${trigPrefixes}\n${this.descriptionTrig(url)}` : "";
            let text = head;
            for (let i = from; i < to; i++) text += memberTrig(i);
            chunk = Buffer.from(text);
        } else if (syntax === "jelly11") {
            const frames = [];
            if (from === 0) frames.push(this.jellyWriter.frame(new Parser({ baseIRI: url }).parse(`${trigPrefixes}\n${this.descriptionTrig(url)}`)));
            for (let i = from; i < to; i++) frames.push(this.jellyWriter.frame(memberQuads(i)));
            chunk = Buffer.concat(frames);
        } else if (syntax === "jelly12-append") {
            const messages = [];
            if (from === 0) messages.push(new Parser({ baseIRI: url }).parse(`${trigPrefixes}\n${this.descriptionTrig(url)}`));
            for (let i = from; i < to; i++) messages.push(memberQuads(i));
            chunk = this.jelly12Writer.publish(messages);
        } else {
            // Jelly 1.2 for ETags: written again as a whole for every version, with the default batches
            const messages = [new Parser({ baseIRI: url }).parse(`${trigPrefixes}\n${this.descriptionTrig(url)}`)];
            for (let i = 0; i < to; i++) messages.push(memberQuads(i));
            this.chunks = [];
            chunk = await jelly12(messages);
        }
        // Incremental compression: every publication is a gzip member of its own
        this.chunks.push(encoding === "members" ? gzipSync(chunk) : chunk);
        const body = Buffer.concat(this.chunks);
        this.pages.set(this.rootPath, {
            body,
            type: encoding === "members" ? "application/octet-stream" : this.type,
            etag: etagOf(body),
            compress: encoding === "gzip",
        });
    }

    /** Head layout: seals full head pages, and publishes the root page and the head page again */
    async publishHead() {
        const H = this.headSize;
        const page = (p) => `${this.base}/${this.name}/page${p}.${this.ext}`;
        const pagePath = (p) => `/${this.name}/page${p}.${this.ext}`;
        const write = async (p, from, to) => {
            let body;
            if (this.strategy.syntax === "trig") {
                let text = `VERSION "1.2-messages"\n${trigPrefixes}\n`;
                for (let i = from; i < to; i++) text += memberTrig(i);
                body = Buffer.from(text.replace(/\nMESSAGE\n/, "\n"));
            } else {
                const messages = [];
                for (let i = from; i < to; i++) messages.push(memberQuads(i));
                body = await jelly12(messages);
            }
            this.pages.set(pagePath(p), { body, type: this.type, etag: etagOf(body), compress: true });
        };
        while ((this.sealed + 1) * H <= this.count) {
            await write(this.sealed, this.sealed * H, (this.sealed + 1) * H);
            this.sealed++;
        }
        const headFrom = this.sealed * H;
        await write(this.sealed, headFrom, this.count);
        const pages = this.sealed + 1;
        const relations = Array.from({ length: pages }, (_, p) => `[ ldes:page <${page(p)}> ; ldes:pageNumber ${p} ]`).join(" ,\n  ");
        const immutable = Array.from({ length: this.sealed }, (_, p) => `<${page(p)}> ldes:immutable true .`).join("\n");
        const rootUrl = this.rootUrl;
        const root = `VERSION "1.2-messages"\n${trigPrefixes}\n${DESCRIPTION.replace("ldes:timestampPath dcterms:created ; ", "")}\n<${rootUrl}> ldes:relation\n  ${relations} .\n${immutable}\n`;
        const body = Buffer.from(root);
        this.pages.set(this.rootPath, { body, type: "application/trig", etag: etagOf(body), compress: true });
    }
}
