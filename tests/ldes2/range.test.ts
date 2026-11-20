/**
 * Draft: continuing a page that opts in with `ldes:rangeRequests true`, with an HTTP Range request,
 * see https://github.com/SEMICeu/LinkedDataEventStreams/issues/119
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Writer, DataFactory as JellyFactory } from "rdfjs-jelly";
import { MemoryStorage, replicateLDES } from "../../lib/client";
import { gzipSync } from "zlib";
import { MockServer, PREFIXES } from "./server";

import type { Member } from "../../lib/types";

const server = new MockServer(3004);
const ROOT = `${server.base}/root`;
const EX = "http://example.org/";

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
    server.pages.clear();
    server.requests = [];
    server.ranges = [];
    server.sent = [];
});

async function collect(config: Record<string, unknown>): Promise<string[]> {
    const client = replicateLDES({ url: ROOT, ...config });
    const members: Member[] = [];
    for await (const member of client.stream({ highWaterMark: 10 })) members.push(member);
    return members.map((m) => m.id.value.replace(EX, ""));
}

/** The responses to Range requests: the requested range, and the number of bytes that were sent */
function rangeResponses() {
    return server.ranges.flatMap((range, i) => (range ? [{ range, path: server.requests[i], sent: server.sent[i] }] : []));
}

describe("A single-page LDES in TriG with range requests", () => {
    const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:rangeRequests true .`;
    const record = (name: string, day: number) => `ex:${name} a ex:Record ; dcterms:created "2026-01-0${day}T00:00:00Z"^^xsd:dateTime .`;

    /** Publishes the root page with the given members: each version is a byte prefix of the next one */
    function publish(names: string[], ranges = true) {
        server.trig("/root", description, ...names.map((name, i) => record(name, i + 1)));
        server.pages.get("/root")!.ranges = ranges;
        return Buffer.from(server.pages.get("/root")!.body).length;
    }

    test("the next run requests only the bytes that were appended, and emits only the new members", async () => {
        const storage = new MemoryStorage();
        const before = publish(["a1", "a2"]);
        expect(await collect({ storage })).toEqual(["a1", "a2"]);
        expect(rangeResponses()).toEqual([]);

        const after = publish(["a1", "a2", "a3"]);
        server.ranges = [];
        server.requests = [];
        server.sent = [];
        expect(await collect({ storage })).toEqual(["a3"]);
        // The page is continued at the byte where it ended, with 32 bytes of overlap to check that it is the same page.
        // That is the only request: the root page is not requested in full first.
        expect(rangeResponses()).toEqual([{ range: `bytes=${before - 32}-`, path: "/root", sent: after - before + 32 }]);
        expect(server.requests).toEqual(["/root"]);

        // Nothing was appended: only the overlap is sent, and nothing is emitted
        server.ranges = [];
        server.sent = [];
        expect(await collect({ storage })).toEqual([]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${after - 32}-`, path: "/root", sent: 32 }]);
    });

    test("a polling client continues the page in every run", async () => {
        publish(["a1"]);
        const client = replicateLDES({ url: ROOT, polling: true, pollInterval: 50 });
        const seen: string[] = [];
        for await (const member of client.stream()) {
            seen.push(member.id.value.replace(EX, ""));
            if (seen.length === 1) publish(["a1", "a2"]);
            else if (seen.length === 2) publish(["a1", "a2", "a3"]);
            else {
                await client.close();
                break;
            }
        }
        expect(seen).toEqual(["a1", "a2", "a3"]);
        expect(rangeResponses().length).toBeGreaterThanOrEqual(2);
    });

    test("a server that does not support ranges sends the whole page, of which only the new members are emitted", async () => {
        const storage = new MemoryStorage();
        const before = publish(["a1", "a2"], false);
        expect(await collect({ storage })).toEqual(["a1", "a2"]);
        server.sent = [];
        publish(["a1", "a2", "a3"], false);
        expect(await collect({ storage })).toEqual(["a3"]);
        expect(server.sent.every((bytes) => bytes > before)).toBe(true);
    });

    test("a page that was rewritten is read again from the start, when the bytes before the offset changed", async () => {
        const storage = new MemoryStorage();
        publish(["a1", "a2"]);
        expect(await collect({ storage })).toEqual(["a1", "a2"]);
        // Rewritten: the same members, but the last one is serialized differently
        server.trig("/root", description, record("a1", 1), record("a2", 2).replace(" .", " ;  a ex:Record ."), record("a3", 3));
        server.pages.get("/root")!.ranges = true;
        server.ranges = [];
        server.requests = [];
        expect(await collect({ storage })).toEqual(["a3"]);
        // A range request, and then the whole page
        expect(server.ranges.filter((range, i) => server.requests[i] === "/root").slice(-2)).toEqual([expect.stringMatching(/^bytes=/), undefined]);
    });
});

describe("A page in Jelly-RDF with range requests", () => {
    const root = `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly> ; ldes:pageNumber 0 ] .
<${server.base}/page.jelly> ldes:rangeRequests true .`;

    /**
     * A Jelly stream of which every frame is a member message (m0, m1, ...) that only uses the stream options and the
     * lookup tables of the frames before it: the prefix and the name `value` are only in the first frame, and every
     * statement gives all its terms, with explicit identifiers.
     */
    function resumableJelly(count: number): Buffer {
        const varint = (n: number) => {
            const bytes: number[] = [];
            while (n >= 0x80) {
                bytes.push((n % 128) | 0x80);
                n = Math.floor(n / 128);
            }
            bytes.push(n);
            return Buffer.from(bytes);
        };
        const num = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
        const len = (field: number, bytes: Buffer) => Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
        const text = (field: number, value: string) => len(field, Buffer.from(value));
        const row = (field: number, bytes: Buffer) => len(1, len(field, bytes));
        const iri = (prefix: number, name: number) => Buffer.concat([num(1, prefix), num(2, name)]);
        // QUADS, name table 64, prefix table 8, datatype table 8, protocol version 2 (Jelly 1.1)
        const options = Buffer.concat([num(2, 2), num(9, 64), num(10, 8), num(11, 8), num(15, 2)]);
        const frames = [];
        for (let i = 0; i < count; i++) {
            const rows: Buffer[] = [];
            if (i === 0) {
                rows.push(row(1, options), row(10, Buffer.concat([num(1, 1), text(2, EX)])), row(9, Buffer.concat([num(1, 1), text(2, "value")])));
            }
            const name = i + 2;
            rows.push(row(9, Buffer.concat([num(1, name), text(2, `m${i}`)])));
            rows.push(row(3, Buffer.concat([len(1, iri(1, name)), len(5, iri(1, 1)), len(11, text(1, String(i))), len(13, iri(1, name))])));
            const frame = Buffer.concat(rows);
            frames.push(varint(frame.length), frame);
        }
        return Buffer.concat(frames);
    }

    /** The same with the writer of rdfjs-jelly, which leaves out terms that are the same as in the statement before, also across frames */
    async function compactJelly(count: number): Promise<Buffer> {
        const { namedNode, literal, quad } = JellyFactory;
        const writer = new Writer({ packMessages: false });
        for (let i = 0; i < count; i++) {
            writer.addMessage([quad(namedNode(`${EX}m${i}`), namedNode(`${EX}value`), literal(String(i)), namedNode(`${EX}m${i}`))]);
        }
        return new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes!)))));
    }

    function publish(body: Buffer) {
        server.trig("/root", root);
        server.set("/page.jelly", { type: "application/x-jelly-rdf", body, ranges: true });
    }

    test("the appended frames are parsed with the stream options and lookup tables of the frames before them", async () => {
        const storage = new MemoryStorage();
        const before = resumableJelly(2);
        publish(before);
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        const after = resumableJelly(4);
        expect(after.subarray(0, before.length).equals(before)).toBe(true);
        publish(after);
        expect(await collect({ storage })).toEqual(["m2", "m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${before.length - 32}-`, path: "/page.jelly", sent: after.length - before.length + 32 }]);
    });

    test("a frame that depends on the statement before it cannot be continued: the page is read from the start", async () => {
        const storage = new MemoryStorage();
        const before = await compactJelly(2);
        publish(before);
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        const after = await compactJelly(3);
        expect(after.subarray(0, before.length).equals(before)).toBe(true);
        publish(after);
        expect(await collect({ storage })).toEqual(["m2"]);
        const page = server.ranges.filter((_, i) => server.requests[i] === "/page.jelly");
        expect(page.slice(-2)).toEqual([expect.stringMatching(/^bytes=/), undefined]);
    });

    test("a gzip file to which gzip members are appended is continued at the end of the last member", async () => {
        const storage = new MemoryStorage();
        const rootGz = `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly.gz> ; ldes:pageNumber 0 ] .
<${server.base}/page.jelly.gz> ldes:rangeRequests true .`;
        const before = resumableJelly(2);
        const after = resumableJelly(4);
        const first = gzipSync(before);
        server.trig("/root", rootGz);
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: first, ranges: true });
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        const appended = gzipSync(after.subarray(before.length));
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: Buffer.concat([first, appended]), ranges: true });
        expect(await collect({ storage })).toEqual(["m2", "m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length - 32}-`, path: "/page.jelly.gz", sent: appended.length + 32 }]);

        // Compressed again as a whole: the bytes before the offset are not the same, so the file is read from the start
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: gzipSync(resumableJelly(5)), ranges: true });
        expect(await collect({ storage })).toEqual(["m4"]);
    });
});

describe("A single-page LDES in TriG, as a gzip file with appended members", () => {
    const url = `${server.base}/log.trig.gz`;
    const header = `VERSION "1.2-messages"\n${PREFIXES}\nex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<${url}> ldes:rangeRequests true .\n`;
    const record = (name: string, day: number) => `MESSAGE\nex:${name} a ex:Record ; dcterms:created "2026-01-0${day}T00:00:00Z"^^xsd:dateTime .\n`;

    test("every publication is a new gzip member, which is all that the next run requests", async () => {
        const storage = new MemoryStorage();
        const members = [gzipSync(header), gzipSync(record("a1", 1) + record("a2", 2))];
        server.set("/log.trig.gz", { type: "application/octet-stream", body: Buffer.concat(members), ranges: true });
        expect(await collect({ storage, url })).toEqual(["a1", "a2"]);
        const before = Buffer.concat(members).length;

        members.push(gzipSync(record("a3", 3)));
        server.set("/log.trig.gz", { type: "application/octet-stream", body: Buffer.concat(members), ranges: true });
        server.ranges = [];
        server.requests = [];
        server.sent = [];
        expect(await collect({ storage, url })).toEqual(["a3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${before - 32}-`, path: "/log.trig.gz", sent: members[2].length + 32 }]);
        expect(server.requests).toEqual(["/log.trig.gz"]);
    });
});
