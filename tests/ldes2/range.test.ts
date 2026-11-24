/**
 * Draft: continuing a page that opts in with `ldes:rangeRequests true`, with an HTTP Range request,
 * see https://github.com/SEMICeu/LinkedDataEventStreams/issues/119
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { RdfStreamType, Writer, DataFactory as JellyFactory } from "rdfjs-jelly";
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

        // A sync that found nothing new keeps the range state: the next one continues the page too
        // (a cache that still serves the old version answers exactly like this)
        const later = publish(["a1", "a2", "a3", "a4"]);
        server.ranges = [];
        server.requests = [];
        server.sent = [];
        expect(await collect({ storage })).toEqual(["a4"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${after - 32}-`, path: "/root", sent: later - after + 32 }]);
        expect(server.requests).toEqual(["/root"]);
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

    const ex = (name: string) => EX + name;

    /**
     * Jelly as a publisher appends it: one streaming writer of rdfjs-jelly with its defaults (shared lookup tables, and for
     * Jelly 1.1 terms that are left out when they are the same as in the statement before, also across frames), and a
     * flush at the end of every publication. Gives the bytes that every publication appends.
     * Every message is a member m<i>: (m<i>, ex:value, "i") in the graph m<i>.
     * @param version 2 (Jelly 1.1) or 3 (Jelly 1.2)
     */
    function jellyParts(version: 2 | 3, publications: number[][]): Buffer[] {
        const { namedNode, literal, quad } = JellyFactory;
        const chunks: Buffer[] = [];
        let current: Buffer[] = [];
        const writer = new Writer(
            {
                write: (bytes: Uint8Array, done?: (error?: Error | null) => void) => {
                    current.push(Buffer.from(bytes));
                    done?.();
                },
                end: (done?: (error?: Error | null) => void) => done?.(),
            },
            { version, streamType: RdfStreamType.MESSAGES },
        );
        for (const publication of publications) {
            for (const i of publication) {
                writer.addMessage([quad(namedNode(ex(`m${i}`)), namedNode(ex("value")), literal(String(i)), namedNode(ex(`m${i}`)))]);
            }
            writer.flush();
            chunks.push(Buffer.concat(current));
            current = [];
        }
        return chunks;
    }

    function publish(body: Buffer) {
        server.trig("/root", root);
        server.set("/page.jelly", { type: "application/x-jelly-rdf", body, ranges: true });
    }

    test("Jelly 1.1 is continued with the decoder state of the frames before it", async () => {
        const storage = new MemoryStorage();
        const [first, second, third] = jellyParts(2, [[0, 1], [2], [3]]);
        publish(first);
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        // The appended frame uses the lookup tables of the first one, and leaves out the predicate, which is the same as
        // in the last statement before it
        publish(Buffer.concat([first, second]));
        expect(await collect({ storage })).toEqual(["m2"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length - 32}-`, path: "/page.jelly", sent: second.length + 32 }]);

        // Nothing appended (as a cache with the old version answers): the decoder state is kept for the next sync
        server.ranges = [];
        server.requests = [];
        server.sent = [];
        expect(await collect({ storage })).toEqual([]);
        publish(Buffer.concat([first, second, third]));
        server.ranges = [];
        server.requests = [];
        server.sent = [];
        expect(await collect({ storage })).toEqual(["m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length + second.length - 32}-`, path: "/page.jelly", sent: third.length + 32 }]);
    });

    test("a gzip file to which gzip members are appended is continued at the end of the last member", async () => {
        const storage = new MemoryStorage();
        const rootGz = `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly.gz> ; ldes:pageNumber 0 ] .
<${server.base}/page.jelly.gz> ldes:rangeRequests true .`;
        const parts = jellyParts(2, [
            [0, 1],
            [2, 3],
        ]);
        const first = gzipSync(parts[0]);
        server.trig("/root", rootGz);
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: first, ranges: true });
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        const appended = gzipSync(parts[1]);
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: Buffer.concat([first, appended]), ranges: true });
        expect(await collect({ storage })).toEqual(["m2", "m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length - 32}-`, path: "/page.jelly.gz", sent: appended.length + 32 }]);

        // Compressed again as a whole: the bytes before the offset are not the same, so the file is read from the start
        const whole = gzipSync(Buffer.concat(jellyParts(2, [[0, 1, 2, 3, 4]])));
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: whole, ranges: true });
        expect(await collect({ storage })).toEqual(["m4"]);
    });

    test("Jelly 1.2 is continued with the lookup tables of the batches before it", async () => {
        const storage = new MemoryStorage();
        const [first, second, third] = jellyParts(3, [[0, 1], [2, 3], [4]]);
        publish(first);
        expect(await collect({ storage })).toEqual(["m0", "m1"]);

        // The appended batches use the IRIs of the first one (ex:value, the graph names' prefix) from the lookup tables
        publish(Buffer.concat([first, second]));
        expect(await collect({ storage })).toEqual(["m2", "m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length - 32}-`, path: "/page.jelly", sent: second.length + 32 }]);

        server.ranges = [];
        server.sent = [];
        server.requests = [];
        publish(Buffer.concat([first, second, third]));
        expect(await collect({ storage })).toEqual(["m4"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${first.length + second.length - 32}-`, path: "/page.jelly", sent: third.length + 32 }]);
    });

    test("Jelly 1.2 in a gzip file with appended gzip members is continued too", async () => {
        const storage = new MemoryStorage();
        const members = jellyParts(3, [
            [0, 1],
            [2, 3],
        ]).map((chunk) => gzipSync(chunk));
        server.trig(
            "/root",
            `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly.gz> ; ldes:pageNumber 0 ] .
<${server.base}/page.jelly.gz> ldes:rangeRequests true .`,
        );
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: members[0], ranges: true });
        expect(await collect({ storage })).toEqual(["m0", "m1"]);
        server.set("/page.jelly.gz", { type: "application/octet-stream", body: Buffer.concat(members), ranges: true });
        expect(await collect({ storage })).toEqual(["m2", "m3"]);
        expect(rangeResponses()).toEqual([{ range: `bytes=${members[0].length - 32}-`, path: "/page.jelly.gz", sent: members[1].length + 32 }]);
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
