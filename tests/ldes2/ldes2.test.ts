/**
 * The start of a conformance test suite for LDES 2.0 clients.
 * The tests follow the structure of https://w3id.org/ldes/specification (draft for LDES 2.0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import fs from "fs";
import { Writer, DataFactory as JellyFactory } from "rdfjs-jelly";
import { MessageWriter, parseMessages } from "n3.js-messages";
import { replicateLDES } from "../../lib/client";
import { ldfetchDereferencer } from "../../lib/fetcher/ldfetchDereferencer";
import { MockServer, PREFIXES } from "./server";

import type { Member } from "../../lib/fetcher";

const server = new MockServer(3002);
const ROOT = `${server.base}/root`;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
    server.pages.clear();
    server.requests = [];
    server.inFlight = 0;
    server.maxInFlight = 0;
});
afterEach(() => {
    fs.rmSync("client-state-ldes2", { recursive: true, force: true });
});

async function collect(url = ROOT, config: Record<string, unknown> = {}): Promise<Member[]> {
    const client = replicateLDES({ url, ...config });
    const members: Member[] = [];
    for await (const member of client.stream({ highWaterMark: 10 })) {
        members.push(member);
    }
    return members;
}

const ids = (members: Member[]) => members.map((m) => m.id.value.replace("http://example.org/", ""));

/** A member message: a record with a timestamp */
const record = (name: string, time: string, extra = "") =>
    `ex:${name} a ex:Record ; dcterms:created "${time}"^^xsd:dateTime ${extra}.`;

describe("Timestamp ordered LDES", () => {
    const description = `ex:ES a ldes:EventStream ;
    ldes:timestampPath dcterms:created ;
    ldes:memberType ex:Record .`;

    test("a client emits the members of all pages in ascending order, as a merge of the logs", async () => {
        // The relations of the root overlap in time, the members have to be interleaved
        server.trig("/root", `${description}
<> ldes:relation
   [ ldes:page <${server.base}/a> ; ldes:timeFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ; ldes:timeUntil "2026-01-10T00:00:00Z"^^xsd:dateTime ] ,
   [ ldes:page <${server.base}/b> ; ldes:timeFrom "2026-01-02T00:00:00Z"^^xsd:dateTime ; ldes:timeUntil "2026-01-10T00:00:00Z"^^xsd:dateTime ] .`);
        server.trig("/a",
            record("a1", "2026-01-01T00:00:00Z"),
            record("a2", "2026-01-03T00:00:00Z"),
            record("a3", "2026-01-05T00:00:00Z"),
        );
        server.trig("/b",
            record("b1", "2026-01-02T00:00:00Z"),
            record("b2", "2026-01-04T00:00:00Z"),
        );

        const members = await collect();
        expect(ids(members)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
        expect(members.every((m) => m.quads.length > 0)).toBe(true);
        expect(members[0].timestamp).toEqual(new Date("2026-01-01T00:00:00Z"));
    });

    test("the description event gives the context information of the LDES", async () => {
        server.trig("/root", `${description}
ex:ES ldes:pollingInterval 60 ; ldes:retentionPolicy [ ldes:fullLogDuration "P1Y"^^xsd:duration ] .
<> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));

        const client = replicateLDES({ url: ROOT });
        let described = false;
        client.on("description", (info) => {
            described = true;
            expect(info.ldesVersion).toBe(2);
            expect(info.timestampPath?.value).toBe("http://purl.org/dc/terms/created");
            expect(info.pollingInterval).toBe(60);
            expect(info.retentionPolicies).toHaveLength(1);
            expect(client.streamId?.value).toBe("http://example.org/ES");
        });
        const members: Member[] = [];
        for await (const member of client.stream()) members.push(member);
        expect(described).toBe(true);
        expect(members).toHaveLength(1);
    });

    test("the root page can contain members itself", async () => {
        server.trig("/root", `${description}`, record("r1", "2026-01-01T00:00:00Z"), record("r2", "2026-01-02T00:00:00Z"));
        expect(ids(await collect())).toEqual(["r1", "r2"]);
    });

    test("members with the same timestamp are ordered by the sequence path", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:sequencePath ex:seq ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        const t = "2026-01-01T00:00:00Z";
        server.trig("/a",
            record("a1", t, "; ex:seq 2 "),
            record("a2", t, "; ex:seq 10 "),
        );
        const members = await collect();
        expect(ids(members)).toEqual(["a1", "a2"]);
        expect(members[1].sequence).toEqual({ type: "numeric", value: "10" });
    });

    test("a relation with only a lower bound and a relation with an unknown type are followed", async () => {
        server.trig("/root", `${description}
<> ldes:relation
   [ a tree:PrefixRelation ; tree:path ex:name ; tree:value "a" ; ldes:page <${server.base}/a> ] ,
   [ ldes:page <${server.base}/b> ; ldes:timeFrom "2026-02-01T00:00:00Z"^^xsd:dateTime ] .`);
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));
        server.trig("/b", record("b1", "2026-02-02T00:00:00Z"));
        expect(ids(await collect())).toEqual(["a1", "b1"]);
    });

    test("a page can be a member-less page that only links to other pages", async () => {
        server.trig("/root", `${description}
<> ldes:relation [ ldes:page <${server.base}/index> ] .`);
        server.trig("/index", `<> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));
        expect(ids(await collect())).toEqual(["a1"]);
    });

    test("a page in Turtle, which has no notion of messages, is read as only a description message", async () => {
        server.set("/root", {
            type: "text/turtle",
            body: `${PREFIXES}
ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<${server.base}/root> ldes:relation [ ldes:page <${server.base}/a> ] .`,
        });
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));
        expect(ids(await collect())).toEqual(["a1"]);
    });

    test("a 410 Gone is a page without members and relations", async () => {
        server.trig("/root", `${description}
<> ldes:relation [ ldes:page <${server.base}/gone> ] , [ ldes:page <${server.base}/a> ] .`);
        server.set("/gone", { status: 410, body: "gone" });
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));
        expect(ids(await collect())).toEqual(["a1"]);
    });
});

describe("LDES ordered by only a sequence", () => {
    test("members are ordered by an xsd:dateTime sequence, also without timezone and with microseconds", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true ; ldes:sequencePath ex:at .
<> ldes:relation [ ldes:page <${server.base}/a> ;
    ldes:sequenceFrom "2023-01-01T00:00:00.000001"^^xsd:dateTime ; ldes:sequenceUntil "2023-01-02T00:00:00"^^xsd:dateTime ] .`);
        server.trig("/a",
            `ex:g1 ex:at "2023-01-01T00:00:00.000001"^^xsd:dateTime . ex:g1 { ex:x ex:p 1 . }`,
            `ex:g2 ex:at "2023-01-01T00:00:00.000002"^^xsd:dateTime . ex:g2 { ex:x ex:p 2 . }`,
        );
        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["g1", "g2"]);

        // The relation is skipped when its upper bound is before the bookmark: a growing page is fetched again
        server.requests = [];
        server.trig("/a",
            `ex:g1 ex:at "2023-01-01T00:00:00.000001"^^xsd:dateTime . ex:g1 { ex:x ex:p 1 . }`,
            `ex:g2 ex:at "2023-01-01T00:00:00.000002"^^xsd:dateTime . ex:g2 { ex:x ex:p 2 . }`,
            `ex:g3 ex:at "2023-01-01T00:00:00.000003"^^xsd:dateTime . ex:g3 { ex:x ex:p 3 . }`,
        );
        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["g3"]);
    });

    test("members that are not in ascending order of their sequence is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true ; ldes:sequencePath ex:at .
<> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        server.trig("/a",
            `ex:g2 ex:at "2023-01-01T00:00:00.000002"^^xsd:dateTime . ex:g2 { ex:x ex:p 2 . }`,
            `ex:g1 ex:at "2023-01-01T00:00:00.000001"^^xsd:dateTime . ex:g1 { ex:x ex:p 1 . }`,
        );
        await expect(collect()).rejects.toThrow(/ordering/);
    });
});

describe("LDES in implicit order", () => {
    test("pages are ordered by their page number, and the members by their index in the page", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation
   [ ldes:page <${server.base}/p1> ; ldes:pageNumber 1 ] ,
   [ ldes:page <${server.base}/p0> ; ldes:pageNumber 0 ] .`);
        server.trig("/p0",
            "ex:m0 { ex:m0 ex:value 0 . }",
            "ex:m1 { ex:m1 ex:value 1 . }",
        );
        server.trig("/p1", "ex:m2 { ex:m2 ex:value 2 . }");

        const members = await collect();
        expect(ids(members)).toEqual(["m0", "m1", "m2"]);
        // The member is the message: the quads keep their graph
        expect(members[0].quads[0].graph.value).toBe("http://example.org/m0");
    });

    test("a page of which the number cannot be determined is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/p0> ] .`);
        server.trig("/p0", "ex:m0 { ex:m0 ex:value 0 . }");
        await expect(collect()).rejects.toThrow(/page number/);
    });

    test("a client skips the pages that are before the bookmark, and does not need to remember pages", async () => {
        const root = `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation
   [ ldes:page <${server.base}/p0> ; ldes:pageNumber 0 ] ,
   [ ldes:page <${server.base}/p1> ; ldes:pageNumber 1 ] ,
   [ ldes:page <${server.base}/p2> ; ldes:pageNumber 2 ] .`;
        server.trig("/root", root);
        server.trig("/p0", "ex:m0 { ex:m0 ex:value 0 . }");
        server.trig("/p1", "ex:m1 { ex:m1 ex:value 1 . }");
        server.trig("/p2", "ex:m2 { ex:m2 ex:value 2 . }");

        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["m0", "m1", "m2"]);

        // The latest page grows, a new page is added
        server.requests = [];
        server.trig("/root", root.replace("p2> ; ldes:pageNumber 2 ]", "p2> ; ldes:pageNumber 2 ] , [ ldes:page <" + server.base + "/p3> ; ldes:pageNumber 3 ]"));
        server.trig("/p2", "ex:m2 { ex:m2 ex:value 2 . }", "ex:m2b { ex:m2b ex:value 2 . }");
        server.trig("/p3", "ex:m3 { ex:m3 ex:value 3 . }");

        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["m2b", "m3"]);
        expect(server.requests).toEqual(["/root", "/p2", "/p3"]);
    });
});

describe("Membership", () => {
    const relation = `<> ldes:relation [ ldes:page <${server.base}/a> ; ldes:pageNumber 0 ] .`;

    test("direct membership: <ES> ldes:member ?m", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream . ${relation}`);
        server.trig("/a",
            "ex:ES ldes:member ex:m0 . ex:m0 ex:value 0 ; ex:detail [ ex:deeper 1 ] .",
        );
        const members = await collect();
        expect(ids(members)).toEqual(["m0"]);
        // The member is the full message, including the triple that identifies the member
        expect(members[0].quads).toHaveLength(4);
    });

    test("indirect membership by ldes:memberType, with the member data in blank nodes and other graphs", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberType ex:Record . ${relation}`);
        server.trig("/a", `ex:m0 a ex:Record ; ex:detail _:b .
_:b ex:value 5 .
ex:graph { _:c ex:value 6 . }`);
        const members = await collect();
        expect(ids(members)).toEqual(["m0"]);
        expect(members[0].quads).toHaveLength(4);
    });

    test("indirect membership by ldes:memberPath, with a SHACL property path", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberPath ( ex:a ex:b ) . ${relation}`);
        server.trig("/a", `ex:m0 ex:a [ ex:b 1 ] . ex:other ex:c 2 .`);
        expect(ids(await collect())).toEqual(["m0"]);
    });

    test("a message in which the member cannot be identified is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberType ex:Record . ${relation}`);
        server.trig("/a", `ex:m0 a ex:Record . ex:m1 a ex:Record .`);
        await expect(collect()).rejects.toThrow(/exactly one/);
    });

    test("setting more than one indirect membership property is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberType ex:Record ; ldes:memberGraph true . ${relation}`);
        server.trig("/a", `ex:m0 a ex:Record .`);
        await expect(collect()).rejects.toThrow(/more than one/);
    });
});

describe("Errors", () => {
    const record1 = record("a1", "2026-01-01T00:00:00Z");
    const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/a> ] .`;

    test("an empty message is an error", async () => {
        server.trig("/root", description);
        server.trig("/a", record1, "", record("a2", "2026-01-02T00:00:00Z"));
        await expect(collect()).rejects.toThrow(/empty message/i);
    });

    test("members that are not ordered in a page is an error", async () => {
        server.trig("/root", description);
        server.trig("/a", record("a2", "2026-01-02T00:00:00Z"), record1);
        await expect(collect()).rejects.toThrow(/ordering/);
    });

    test("a timestamp that is not an xsd:dateTime is an error", async () => {
        server.trig("/root", description);
        server.trig("/a", record("a1", "yesterday"));
        await expect(collect()).rejects.toThrow(/xsd:dateTime/);
    });

    test("a relation with a sequence bound without a timestamp bound is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:sequencePath ex:seq ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/a> ; ldes:sequenceFrom 1 ] .`);
        server.trig("/a", record1);
        await expect(collect()).rejects.toThrow(/sequenceFrom/);
    });

    test("a relation must have exactly one ldes:page", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:timeFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ] .`);
        await expect(collect()).rejects.toThrow(/exactly one ldes:page/);
    });

    test("a root page without a description of the LDES is an error", async () => {
        server.trig("/root", `<> ldes:relation [ ldes:page <${server.base}/a> ] .`, record1);
        await expect(collect()).rejects.toThrow(/does not describe an ldes:EventStream/);
    });

    test("more than one ldes:EventStream in the root page is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream . ex:ES2 a ldes:EventStream .`);
        await expect(collect()).rejects.toThrow(/exactly one ldes:EventStream/);
    });

    test("another 4xx or 5xx status code is an error", async () => {
        server.trig("/root", description);
        await expect(collect()).rejects.toThrow(/404/);
    });
});

describe("Jelly-RDF", () => {
    /** Writes the messages as a Jelly stream, in which every frame is a message */
    async function jelly(messages: Array<Array<[string, string, string, string?]>>): Promise<Buffer> {
        const { namedNode, literal, quad } = JellyFactory;
        const writer = new Writer({ packMessages: false });
        for (const message of messages) {
            writer.addMessage(
                message.map(([s, p, o, g]) =>
                    quad(
                        namedNode(s),
                        namedNode(p),
                        o.startsWith("http") ? namedNode(o) : literal(o),
                        g ? namedNode(g) : undefined,
                    ),
                ),
            );
        }
        return new Promise((resolve, reject) =>
            writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes!)))),
        );
    }

    const ex = (name: string) => "http://example.org/" + name;

    test("a client reads a page in Jelly-RDF, in which every frame is a member message", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly> ; ldes:pageNumber 0 ] .`);
        server.set("/page.jelly", {
            type: "application/x-jelly-rdf",
            body: await jelly([
                [[ex("m0"), ex("value"), "0", ex("m0")], [ex("m0"), ex("other"), "x", ex("m0")]],
                [[ex("m1"), ex("value"), "1", ex("m1")]],
            ]),
        });
        const members = await collect();
        expect(ids(members)).toEqual(["m0", "m1"]);
        expect(members[0].quads).toHaveLength(2);
    });

    test("a client reads a gzipped Jelly-RDF page of which the media type is not helpful", async () => {
        const { gzipSync } = await import("zlib");
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly.gz> ; ldes:pageNumber 0 ] .`);
        server.set("/page.jelly.gz", {
            type: "application/octet-stream",
            body: gzipSync(await jelly([[[ex("m0"), ex("value"), "0", ex("m0")]]])),
        });
        expect(ids(await collect())).toEqual(["m0"]);
    });

    test("an empty frame is an empty message, which is an error", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/page.jelly> ; ldes:pageNumber 0 ] .`);
        server.set("/page.jelly", {
            type: "application/x-jelly-rdf",
            body: await jelly([[[ex("m0"), ex("value"), "0", ex("m0")]], [], [[ex("m1"), ex("value"), "1", ex("m1")]]]),
        });
        await expect(collect()).rejects.toThrow(/empty message/i);
    });
});

describe("Other serializations", () => {
    test("a client reads pages in N-Quads with message delimiters", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:memberGraph true .
<> ldes:relation [ ldes:page <${server.base}/p0.nq> ; ldes:pageNumber 0 ] .`);
        server.set("/p0.nq", {
            type: "application/n-quads",
            body: `VERSION "1.2-messages"
<http://example.org/m0> <http://example.org/value> "0" <http://example.org/m0> .
MESSAGE
<http://example.org/m1> <http://example.org/value> "1" <http://example.org/m1> .
`,
        });
        expect(ids(await collect())).toEqual(["m0", "m1"]);
    });
});

describe("LDES 1.0 and LDES 2.0", () => {
    test("an LDES 1.0 is still replicated as an LDES 1.0", async () => {
        const base = server.base;
        server.set("/root", {
            type: "text/turtle",
            body: `${PREFIXES}
<${base}/root#ES> a ldes:EventStream ; tree:view <${base}/root> ; tree:member ex:m0 .
ex:m0 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime .`,
        });
        const client = replicateLDES({ url: ROOT });
        let version: number | undefined;
        client.on("description", (info) => (version = info.ldesVersion));
        const members: Member[] = [];
        for await (const member of client.stream()) members.push(member);
        expect(ids(members)).toEqual(["m0"]);
        expect(version).not.toBe(2);
    });
});

describe("State management", () => {
    const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/a> ] .`;

    test("members that share the timestamp of the bookmark are emitted exactly once", async () => {
        server.trig("/root", description);
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"), record("a2", "2026-01-02T00:00:00Z"));
        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["a1", "a2"]);

        server.trig("/a",
            record("a1", "2026-01-01T00:00:00Z"),
            record("a2", "2026-01-02T00:00:00Z"),
            record("a3", "2026-01-02T00:00:00Z"),
            record("a4", "2026-01-03T00:00:00Z"),
        );
        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual(["a3", "a4"]);
        expect(ids(await collect(ROOT, { statePath: "client-state-ldes2" }))).toEqual([]);
    });

    test("a polling client emits members that are published later", async () => {
        server.trig("/root", description);
        server.trig("/a", record("a1", "2026-01-01T00:00:00Z"));
        const client = replicateLDES({ url: ROOT, polling: true, pollInterval: 50 });
        const seen: string[] = [];
        for await (const member of client.stream()) {
            seen.push(member.id.value.replace("http://example.org/", ""));
            if (seen.length === 1) {
                server.trig("/a", record("a1", "2026-01-01T00:00:00Z"), record("a2", "2026-01-02T00:00:00Z"));
            } else {
                await client.close();
                break;
            }
        }
        expect(seen).toEqual(["a1", "a2"]);
    });
});

describe("Ordering keys and version detection", () => {
    test("sequences are compared as numbers, dates and strings", async () => {
        const { compareSequences } = await import("../../lib/ldes2/key");
        const xsd = (name: string) => "http://www.w3.org/2001/XMLSchema#" + name;
        expect(compareSequences({ value: "9", datatype: xsd("integer") }, { value: "10", datatype: xsd("integer") })).toBe(-1);
        expect(compareSequences({ value: "9", datatype: xsd("string") }, { value: "10", datatype: xsd("string") })).toBe(1);
        expect(compareSequences(
            { value: "2026-01-01T01:00:00+01:00", datatype: xsd("dateTime") },
            { value: "2026-01-01T00:00:00Z", datatype: xsd("dateTime") },
        )).toBe(0);
    });

    test("timestamps without a timezone are local, or get the default timezone", async () => {
        const { parseTimestamp, isOffset } = await import("../../lib/ldes2/key");
        expect(parseTimestamp("2026-01-01T00:00:00Z")?.local).toBe(false);
        expect(parseTimestamp("2026-01-01T00:00:00+02:00")?.time).toBe(Date.parse("2025-12-31T22:00:00Z"));
        expect(parseTimestamp("2026-01-01T00:00:00")?.local).toBe(true);
        const withDefault = parseTimestamp("2026-01-01T00:00:00", "+02:00");
        expect(withDefault?.local).toBe(false);
        expect(withDefault?.time).toBe(Date.parse("2025-12-31T22:00:00Z"));
        expect(parseTimestamp("2026-01-01T00:00:00.123456")?.fraction).toBe("456");
        expect(parseTimestamp("yesterday")).toBeUndefined();
        expect(["Z", "+01:00", "-14:00", "+14:00"].every(isOffset)).toBe(true);
        expect(["CET", "+15:00", "+1:00", "+14:30", "AoE"].some(isOffset)).toBe(false);
    });
});

describe("Sample LDES: RiverBench", () => {
    const sample = "examples/riverbench/root.trig";
    const jellyUrl =
        "https://w3id.org/riverbench/datasets/assist-iot-weather-graphs/dev/files/jelly_10K.jelly.gz";

    test("the sample root page describes a RiverBench dataset as an LDES, and is read with a local copy of the Jelly page", async () => {
        const { gzipSync } = await import("zlib");
        const { namedNode, literal, quad } = JellyFactory;
        const atTime = namedNode("http://www.w3.org/ns/prov#atTime");
        const dateTime = namedNode("http://www.w3.org/2001/XMLSchema#dateTime");
        const writer = new Writer({ packMessages: false });
        // As in the dataset: the timestamp is on the graph name in the default graph, without a timezone
        for (const time of ["2023-01-02T15:36:37.065535", "2023-01-02T15:36:37.065600", "2023-01-02T15:36:47.000001"]) {
            const graph = namedNode(`https://assist-iot.eu/pilot2_rdf/graph/ws/ibs_1/${time}`);
            writer.addMessage([
                quad(graph, atTime, literal(time, dateTime)),
                quad(namedNode("https://assist-iot.eu/pilot2_rdf/obs/humidity"), namedNode("http://www.w3.org/ns/sosa/hasSimpleResult"), literal("71"), graph),
            ]);
        }
        const bytes = await new Promise<Buffer>((resolve, reject) =>
            writer.end((error, out) => (error ? reject(error) : resolve(Buffer.from(out!)))),
        );
        const requested: string[] = [];
        const offline: typeof fetch = async (input) => {
            requested.push(String(input));
            // As the real server: a redirect to storage that has lost the extension and has no helpful media type
            return new Response(gzipSync(bytes), { headers: { "content-type": "application/octet-stream" } });
        };

        const client = replicateLDES({ url: sample, fetch: offline, statePath: "client-state-ldes2" });
        client.on("description", (info) => {
            expect(info.ldesVersion).toBe(2);
            expect(info.timestampPath?.value).toBe("http://www.w3.org/ns/prov#atTime");
            expect(info.sequencePath).toBeUndefined();
            expect(info.shape?.value).toMatch(/#MemberShape$/);
            // The shape is a node shape with a property shape for prov:atTime
            expect(info.shapeQuads.length).toBeGreaterThanOrEqual(6);
        });
        const members: Member[] = [];
        for await (const member of client.stream()) members.push(member);

        expect(requested).toEqual([jellyUrl]);
        // The members are ordered by the timestamp, without timezone and with a precision beyond milliseconds
        expect(members.map((m) => m.id.value.split("/").pop())).toEqual([
            "2023-01-02T15:36:37.065535",
            "2023-01-02T15:36:37.065600",
            "2023-01-02T15:36:47.000001",
        ]);
        // The member is the whole message: the graph, and the default graph with the timestamp
        expect(members[0].quads).toHaveLength(2);
        expect(members[0].timestamp).toEqual(new Date("2023-01-02T15:36:37.065Z"));

        // The Jelly file is marked immutable in the root page: it is not fetched again
        expect(await collect(sample, { fetch: offline, statePath: "client-state-ldes2" })).toHaveLength(0);
        expect(requested).toEqual([jellyUrl]);
    });

    // The real dataset: 10 000 graphs of 116 quads, over the network. Run with: RIVERBENCH=1 npx vitest run
    test.skipIf(!process.env.RIVERBENCH)("the real RiverBench dataset is replicated from its Jelly file", async () => {
        const members = await collect(sample);
        expect(members).toHaveLength(10000);
        expect(members[0].quads).toHaveLength(116);
    }, 120000);
});

describe("Timestamps without a timezone", () => {
    const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record`;
    const pages = `<> ldes:relation [ ldes:page <${server.base}/a> ] , [ ldes:page <${server.base}/b> ] .`;
    const first = (members: Member[]) => ids(members);

    test("literals without a timezone in the same LDES are compared as if they have the same timezone", async () => {
        server.trig("/root", `${description} . ${pages}`);
        server.trig("/a", record("a1", "2026-01-01T00:30:00"), record("a2", "2026-01-03T00:00:00"));
        server.trig("/b", record("b1", "2026-01-01T00:45:00"), record("b2", "2026-01-02T00:00:00"));
        expect(first(await collect())).toEqual(["a1", "b1", "b2", "a2"]);
    });

    test("without a default timezone, a mix of literals with and without timezone is ordered by the earliest instant", async () => {
        server.trig("/root", `${description} . ${pages}`);
        server.trig("/a", record("a1", "2026-01-01T00:30:00"));
        server.trig("/b", record("b1", "2026-01-01T00:00:00Z"));
        // a1 can be from 14 hours before, up to 14 hours after the time that is written
        expect(first(await collect())).toEqual(["a1", "b1"]);
    });

    test("the ldes:defaultTimezone of the LDES is the timezone of literals without a timezone", async () => {
        server.trig("/root", `${description} ; ldes:defaultTimezone "-05:00" . ${pages}`);
        server.trig("/a", record("a1", "2026-01-01T00:30:00"));
        server.trig("/b", record("b1", "2026-01-01T00:00:00Z"));
        const members = await collect();
        expect(first(members)).toEqual(["b1", "a1"]);
        expect(members[1].timestamp).toEqual(new Date("2026-01-01T05:30:00Z"));
    });

    test("a configured default timezone is used before the ldes:defaultTimezone", async () => {
        server.trig("/root", `${description} ; ldes:defaultTimezone "-05:00" . ${pages}`);
        server.trig("/a", record("a1", "2026-01-01T00:30:00"));
        server.trig("/b", record("b1", "2026-01-01T00:00:00Z"));
        expect(first(await collect(ROOT, { defaultTimezone: "+01:00" }))).toEqual(["a1", "b1"]);
    });

    test("an ldes:defaultTimezone that is not a timezone is an error", async () => {
        server.trig("/root", `${description} ; ldes:defaultTimezone "CET" . ${pages}`);
        await expect(collect()).rejects.toThrow(/defaultTimezone/);
    });

    test("relation bounds without a timezone are read in the same way", async () => {
        server.trig("/root", `${description} .
<> ldes:relation [ ldes:page <${server.base}/a> ; ldes:timeFrom "2026-01-01T00:00:00"^^xsd:dateTime ; ldes:timeUntil "2026-02-01T00:00:00"^^xsd:dateTime ] .`);
        server.trig("/a", record("a1", "2026-01-05T00:00:00"));
        expect(first(await collect())).toEqual(["a1"]);
    });

    test("a page is only reported as not ordered when that is certain", async () => {
        server.trig("/root", `${description} . <> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        // 11:00 without timezone can be after 12:00Z: this is not certain
        server.trig("/a", record("a1", "2026-01-01T12:00:00Z"), record("a2", "2026-01-01T11:00:00"));
        expect(first(await collect())).toEqual(["a1", "a2"]);

        // 4 days before is certain
        server.trig("/a", record("a1", "2026-01-05T12:00:00Z"), record("a2", "2026-01-01T11:00:00"));
        await expect(collect()).rejects.toThrow(/ordering/);
    });

    test("a member is only skipped when it is certainly before the bookmark", async () => {
        server.trig("/root", `${description} . <> ldes:relation [ ldes:page <${server.base}/a> ] .`);
        server.trig("/a", record("m0", "2025-12-30T00:00:00"), record("m1", "2026-01-01T12:00:00Z"));
        const state = { statePath: "client-state-ldes2" };
        expect(first(await collect(ROOT, state))).toEqual(["m0", "m1"]);

        server.trig("/a",
            record("m0", "2025-12-30T00:00:00"),
            record("m1", "2026-01-01T12:00:00Z"),
            // Could be before or after the bookmark, depending on the timezone: emitted
            record("m2", "2026-01-01T12:00:00"),
        );
        expect(first(await collect(ROOT, state))).toEqual(["m2"]);
        // The members of the bookmark are not emitted again
        expect(first(await collect(ROOT, state))).toEqual([]);
    });

    test("a relation is only skipped when its upper bound is certainly before the bookmark", async () => {
        const state = { statePath: "client-state-ldes2" };
        server.trig("/root", `${description} . <> ldes:relation [ ldes:page <${server.base}/c> ] .`);
        server.trig("/c", record("c1", "2026-03-01T00:00:00Z"));
        expect(first(await collect(ROOT, state))).toEqual(["c1"]);

        server.requests = [];
        server.trig("/root", `${description} .
<> ldes:relation
   [ ldes:page <${server.base}/c> ] ,
   [ ldes:page <${server.base}/old> ; ldes:timeUntil "2026-01-01T00:00:00"^^xsd:dateTime ] ,
   [ ldes:page <${server.base}/maybe> ; ldes:timeUntil "2026-03-01T05:00:00"^^xsd:dateTime ] .`);
        server.trig("/old", record("o1", "2025-12-01T00:00:00"));
        server.trig("/maybe", record("m1", "2026-03-01T03:00:00"));
        expect(first(await collect(ROOT, state))).toEqual(["m1"]);
        expect(server.requests).not.toContain("/old");
        expect(server.requests).toContain("/maybe");
    });
});

describe("Immutable pages", () => {
    test("a page that is marked immutable by the page that links to it is not fetched again once processed", async () => {
        const state = { statePath: "client-state-ldes2" };
        const root = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/p1> ] , [ ldes:page <${server.base}/p2> ] .
<${server.base}/p1> ldes:immutable true .`;
        server.trig("/root", root);
        server.trig("/p1", record("a1", "2026-01-01T00:00:00Z"));
        server.trig("/p2", record("b1", "2026-01-02T00:00:00Z"));
        expect(ids(await collect(ROOT, state))).toEqual(["a1", "b1"]);

        server.requests = [];
        server.trig("/p2", record("b1", "2026-01-02T00:00:00Z"), record("b2", "2026-01-03T00:00:00Z"));
        expect(ids(await collect(ROOT, state))).toEqual(["b2"]);
        expect(server.requests).toEqual(["/root", "/p2"]);
    });

    test("a page that is marked immutable, but links to other pages, is read again", async () => {
        const state = { statePath: "client-state-ldes2" };
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/p1> ] .
<${server.base}/p1> ldes:immutable true .`);
        server.trig("/p1", `<> ldes:relation [ ldes:page <${server.base}/p2> ] .`, record("a1", "2026-01-01T00:00:00Z"));
        server.trig("/p2", record("b1", "2026-01-02T00:00:00Z"));
        expect(ids(await collect(ROOT, state))).toEqual(["a1", "b1"]);

        server.requests = [];
        server.trig("/p2", record("b1", "2026-01-02T00:00:00Z"), record("b2", "2026-01-03T00:00:00Z"));
        // p2 is a mutable child of p1, so p1 has to be read to find it
        expect(ids(await collect(ROOT, state))).toEqual(["b2"]);
        expect(server.requests).toEqual(["/root", "/p1", "/p2"]);
    });
});


describe("Output as an RDF Message log", () => {
    // The default output of the command line client: one TriG message per member
    test("the members, written as a TriG message log, are read back as the same messages", async () => {
        server.trig("/root", `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<> ldes:relation [ ldes:page <${server.base}/p1> ] .`);
        server.trig("/p1",
            record("a1", "2026-01-01T00:00:00Z", "; ex:label \"first\" "),
            record("b1", "2026-01-02T00:00:00Z"),
        );

        const members = await collect();
        const writer = new MessageWriter({ format: "TriG" });
        for (const member of members) {
            await writer.addMessage(member.quads);
        }
        const log = (await writer.end()) as string;

        expect(log.startsWith('@version "1.2-messages"')).toBe(true);
        const messages = parseMessages(log);
        expect(messages).toHaveLength(members.length);
        messages.forEach((message, i) => {
            expect(message.map((q) => q.toString()).sort()).toEqual(members[i].quads.map((q) => q.toString()).sort());
        });
    });
});

describe("Requesting pages ahead", () => {
    const DELAY = 40;
    const stream = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .`;
    const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`;
    const relation = (page: string, from: number, until: number) =>
        `[ ldes:page <${server.base}/${page}> ; ldes:timeFrom "${day(from)}"^^xsd:dateTime ; ldes:timeUntil "${day(until)}"^^xsd:dateTime ]`;

    /** A root with `count` leaf pages, one member each */
    function flat(count: number) {
        server.trig("/root", `${stream}\n<> ldes:relation ${Array.from({ length: count }, (_, i) => relation(`p${i}`, i + 1, i + 2)).join(" , ")} .`);
        for (let i = 0; i < count; i++) {
            server.trig(`/p${i}`, record(`m${i}`, day(i + 1)));
            server.pages.get(`/p${i}`)!.delay = DELAY;
        }
        return Array.from({ length: count }, (_, i) => `m${i}`);
    }

    test("pages that are followed next are requested at the same time, and the order does not change", async () => {
        const expected = flat(6);
        expect(ids(await collect(ROOT, { concurrentFetches: 4 }))).toEqual(expected);
        expect(server.maxInFlight).toBeGreaterThan(1);
    });

    test("never more pages than the concurrent requests are requested ahead", async () => {
        const expected = flat(8);
        expect(ids(await collect(ROOT, { concurrentFetches: 2 }))).toEqual(expected);
        expect(server.maxInFlight).toBe(2);
    });

    test("with one concurrent request, pages are requested one by one", async () => {
        const expected = flat(4);
        expect(ids(await collect(ROOT, { concurrentFetches: 1 }))).toEqual(expected);
        expect(server.maxInFlight).toBe(1);
        expect(server.requests).toEqual(["/root", "/p0", "/p1", "/p2", "/p3"]);
    });

    test("the relations in a page that was requested ahead are known before it is opened", async () => {
        // Three pages, each with two children: with only the relations of the opened pages, no more than three pages are requested at once
        const lines = [`${stream}\n<> ldes:relation ${[0, 1, 2].map((i) => relation(`p${i}`, 10 * i + 1, 10 * i + 10)).join(" , ")} .`];
        server.trig("/root", lines[0]);
        const expected: string[] = [];
        for (let i = 0; i < 3; i++) {
            const children = [0, 1].map((j) => relation(`c${i}${j}`, 10 * i + 5 + 2 * j, 10 * i + 7 + 2 * j));
            server.trig(`/p${i}`, `<> ldes:relation ${children.join(" , ")} .`, record(`p${i}`, day(10 * i + 1)));
            server.pages.get(`/p${i}`)!.delay = DELAY;
            expected.push(`p${i}`);
            for (let j = 0; j < 2; j++) {
                server.trig(`/c${i}${j}`, record(`c${i}${j}`, day(10 * i + 5 + 2 * j)));
                server.pages.get(`/c${i}${j}`)!.delay = DELAY;
                expected.push(`c${i}${j}`);
            }
        }
        expect(ids(await collect(ROOT, { concurrentFetches: 8 }))).toEqual(expected);
        expect(server.maxInFlight).toBeGreaterThan(3);
    });

    test("a page that fails to load is only an error when the merge needs it", async () => {
        flat(3);
        server.set("/p2", { body: "unavailable", status: 404 });
        // The consumer does not read that far
        const client = replicateLDES({ url: ROOT, concurrentFetches: 4 });
        const first: string[] = [];
        for await (const member of client.stream({ highWaterMark: 1 })) {
            first.push(...ids([member]));
            break;
        }
        expect(first).toEqual(["m0"]);
        // When it does, the error is reported
        await expect(collect(ROOT, { concurrentFetches: 4 })).rejects.toThrow();
    });

    test("pages before the bookmark of a saved state are not requested ahead", async () => {
        const expected = flat(5);
        const state = { statePath: "client-state-ldes2", concurrentFetches: 3 };
        expect(ids(await collect(ROOT, state))).toEqual(expected);
        server.requests = [];
        expect(ids(await collect(ROOT, state))).toEqual([]);
        // Only the last page, the upper bound of which is not before the bookmark
        expect(server.requests).toEqual(["/root", "/p4"]);
    });

    test("a page that is requested ahead buffers a limited number of messages, however long it is", async () => {
        const messages = Array.from({ length: 5000 }, (_, i) => record(`m${i}`, "2026-01-01T00:00:00Z"));
        server.trig("/long", ...messages);
        const log = await ldfetchDereferencer.dereferenceMessages(`${server.base}/long`, { bufferedMessages: 20 });
        // Give the parser the time to read everything it is allowed to
        await new Promise((resolve) => setTimeout(resolve, 300));
        const buffered = (log as unknown as { queue: unknown[] }).queue.length;
        expect(buffered).toBeGreaterThanOrEqual(20);
        expect(buffered).toBeLessThan(5000);
        // Reading on continues where it stopped
        let count = 0;
        for await (const _ of log) count++;
        expect(count).toBe(5000);
    });
});
