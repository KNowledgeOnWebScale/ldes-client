/**
 * The extraction of the members of a page of an LDES 1.0.
 * The members of a page are extracted with one bulk extraction, as extracting them one by one is quadratic in the
 * size of the page.
 */
import { describe, expect, test } from "vitest";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { Parser } from "n3";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { LDES, TREE } from "@treecg/types";
import { Manager } from "../../lib/ldes1/fetcher";
import { empty_condition, MaxCountCondition } from "../../lib/condition";

import type { Quad, Term } from "@rdfjs/types";
import type { FetchedPage, LDESInfo, Member } from "../../lib/types";

const df = new DataFactory();
const PREFIXES = `@prefix tree: <https://w3id.org/tree#> . @prefix ex: <http://example.org/> .
@prefix dcterms: <http://purl.org/dc/terms/> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const PAGE = "http://example.org/page";

function pageOf(trig: string): FetchedPage {
    const data = RdfStore.createDefault();
    new Parser({ format: "application/trig" }).parse(PREFIXES + trig).forEach((q) => data.addQuad(q));
    return { url: PAGE, data, immutable: false, memberCount: 0 };
}

function manager(extractor: CBDShapeExtractor, condition = empty_condition()) {
    const info = {
        shape: undefined,
        shapeQuads: [],
        extractor,
        timestampPath: df.namedNode("http://purl.org/dc/terms/created"),
    } as unknown as LDESInfo;
    return new Manager(df.namedNode("http://example.org/ldes"), info, true, condition);
}

/** Runs the extraction of a page, and gives the members that were extracted, and the errors */
async function extract(manager: Manager, page: FetchedPage, emitted: string[] = []) {
    const members: Member[] = [];
    const errors: unknown[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const state = { modulator: { wasEmitted: async (id: string) => emitted.includes(id) } };
    await manager.extractMembers(
        page,
        state as never,
        {
            extracted: (member: Member) => void members.push(member),
            done: () => finished(),
            error: (error: unknown) => void errors.push(error),
        } as never,
    );
    await done;
    return { members, errors };
}

const key = (quads: Quad[]) => quads.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.graph.value}`).sort();

/** What extracting every member one by one, as it used to be done, gives */
async function oneByOne(extractor: CBDShapeExtractor, page: FetchedPage) {
    const members: Term[] = page.data.getQuads(null, df.namedNode(TREE.member), null, null).map((q) => q.object);
    const out = new Map<string, string[]>();
    for (const member of members) {
        const quads = await extractor.extract(page.data, member, undefined, [df.namedNode(LDES.custom("IngestionMetadata")), ...members]);
        out.set(member.value, key(quads));
    }
    return out;
}

describe("Extracting the members of a page", () => {
    const extractor = () => new CBDShapeExtractor(undefined, undefined, { cbdDefaultGraph: false });

    test("members in the default graph, with blank nodes and links to other members, are extracted as one by one", async () => {
        const page = pageOf(`
<${PAGE}> tree:member ex:m1, ex:m2, ex:m3 .
ex:m1 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime ; ex:note [ ex:text "a" ; ex:deeper [ ex:text "b" ] ] .
ex:m2 dcterms:created "2026-01-02T00:00:00Z"^^xsd:dateTime ; ex:next ex:m1 .
ex:m3 dcterms:created "2026-01-03T00:00:00Z"^^xsd:dateTime .
`);
        const expected = await oneByOne(extractor(), page);
        const { members, errors } = await extract(manager(extractor()), page);
        expect(errors).toEqual([]);
        expect(members.map((m) => m.id.value).sort()).toEqual(["http://example.org/m1", "http://example.org/m2", "http://example.org/m3"]);
        for (const member of members) expect(key(member.quads)).toEqual(expected.get(member.id.value));
    });

    test("members that are each in their own named graph are extracted as one by one, without the quads of other members", async () => {
        const page = pageOf(`
<${PAGE}> tree:member ex:m1, ex:m2 .
ex:m1 { ex:m1 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime ; ex:other ex:m2 . }
ex:m2 { ex:m2 dcterms:created "2026-01-02T00:00:00Z"^^xsd:dateTime ; ex:note [ ex:text "x" ] . }
`);
        const expected = await oneByOne(extractor(), page);
        const { members, errors } = await extract(manager(extractor()), page);
        expect(errors).toEqual([]);
        expect(members).toHaveLength(2);
        for (const member of members) {
            expect(key(member.quads)).toEqual(expected.get(member.id.value));
            // The graph of the other member is not part of this member
            const other = member.id.value.endsWith("m1") ? "http://example.org/m2" : "http://example.org/m1";
            expect(member.quads.some((q) => q.graph.value === other)).toBe(false);
        }
    });

    test("members that are emitted already are not extracted, and are not part of the description of the others", async () => {
        const page = pageOf(`
<${PAGE}> tree:member ex:m1, ex:m2 .
ex:m1 { ex:m1 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime . }
ex:m2 { ex:m2 dcterms:created "2026-01-02T00:00:00Z"^^xsd:dateTime ; ex:other ex:m1 . }
`);
        const { members } = await extract(manager(extractor()), page, ["http://example.org/m1"]);
        expect(members.map((m) => m.id.value)).toEqual(["http://example.org/m2"]);
        expect(members[0].quads.some((q) => q.graph.value === "http://example.org/m1")).toBe(false);
    });

    test("the condition is applied to the extracted members", async () => {
        const page = pageOf(`
<${PAGE}> tree:member ex:m1, ex:m2, ex:m3 .
ex:m1 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime .
ex:m2 dcterms:created "2026-01-02T00:00:00Z"^^xsd:dateTime .
ex:m3 dcterms:created "2026-01-03T00:00:00Z"^^xsd:dateTime .
`);
        const { members } = await extract(manager(extractor(), new MaxCountCondition({ count: 2 })), page);
        expect(members).toHaveLength(2);
    });

    test("when the bulk extraction fails, the members are extracted one by one, and a member that fails only costs itself", async () => {
        const page = pageOf(`
<${PAGE}> tree:member ex:m1, ex:m2, ex:m3 .
ex:m1 dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime .
ex:m2 dcterms:created "2026-01-02T00:00:00Z"^^xsd:dateTime .
ex:m3 dcterms:created "2026-01-03T00:00:00Z"^^xsd:dateTime .
`);
        const inner = extractor();
        const broken = {
            bulkExtract: async () => {
                throw new Error("bulk is broken");
            },
            extract: async (store: RdfStore, id: Term, shape: Term | undefined, ignored: Term[]) => {
                if (id.value.endsWith("m2")) throw new Error("m2 is broken");
                return inner.extract(store, id, shape, ignored);
            },
        } as unknown as CBDShapeExtractor;
        const { members } = await extract(manager(broken), page);
        expect(members.map((m) => m.id.value).sort()).toEqual(["http://example.org/m1", "http://example.org/m3"]);
    });

    test("a page with many members is extracted in linear time", async () => {
        // One by one, this page takes about 30 seconds: the time per member grows with the size of the page
        const size = 20000;
        let trig = `<${PAGE}> tree:member ${Array.from({ length: size }, (_, i) => `ex:m${i}`).join(", ")} .\n`;
        for (let i = 0; i < size; i++) {
            trig += `ex:m${i} dcterms:created "2026-01-01T00:00:00Z"^^xsd:dateTime ; ex:note [ ex:text "t${i}" ] .\n`;
        }
        const page = pageOf(trig);
        const started = performance.now();
        const { members, errors } = await extract(manager(extractor()), page);
        const seconds = (performance.now() - started) / 1000;
        expect(errors).toEqual([]);
        expect(members).toHaveLength(size);
        expect(seconds).toBeLessThan(10);
    }, 60_000);
});
