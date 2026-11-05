/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Parser } from "n3";
import { read, Tree } from "./helper";
import { replicateLDES } from "../lib/client";

const oldFetch = global.fetch;
beforeEach(() => {
    if ("mockClear" in global.fetch) {
        (<any>global.fetch).mockClear();
    }
    global.fetch = oldFetch;
});
afterEach(() => {
    if ("mockClear" in global.fetch) {
        (<any>global.fetch).mockClear();
    }
    global.fetch = oldFetch;
});

const TIMESTAMP_PATH = "http://example.com/generatedAt";
const SEQUENCE_PATH = "http://example.com/eventId";
const GT = "https://w3id.org/tree#GreaterThanRelation";
const LT = "https://w3id.org/tree#LessThanRelation";

/**
 * Build a multi-page tree with sequence-based GT relations.
 * Each page has `perPage` members. Pages are linked by GT relations
 * whose tree:path points to sequencePath and tree:value is a UUIDv7-like string.
 */
function sequenceTree(
    perPage: number,
    pages: number,
    opts?: { timestampPath?: string; sequencePath?: string },
): Tree<{ ts: string; seq: string }> {
    const tsPath = opts?.timestampPath ?? TIMESTAMP_PATH;
    const seqPath = opts?.sequencePath ?? SEQUENCE_PATH;

    const tree = new Tree<{ ts: string; seq: string }>(
        (id, { ts, seq }) =>
            new Parser().parse(
                `<${id}> <${tsPath}> "${ts}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.
                 <${id}> <${seqPath}> "${seq}".`,
            ),
        tsPath,
        seqPath,
    );

    // Generate UUIDv7-like sortable strings for each page boundary
    const baseSeq = "01900000-0000-7000-8000-";
    let prev = tree.root();

    for (let p = 0; p < pages; p++) {
        const frag = tree.newFragment();
        for (let i = 0; i < perPage; i++) {
            const idx = p * perPage + i;
            const seq = baseSeq + idx.toString().padStart(12, "0");
            const ts = new Date(2025, 0, 1, 0, 0, idx).toISOString();
            tree.fragment(frag).addMember(`m${idx}`, { ts, seq });
        }
        // Link previous page to this one with a GT relation on the sequence path
        const boundarySeq = baseSeq + (p * perPage).toString().padStart(12, "0");
        tree.fragment(prev).relation(frag, GT, seqPath, boundarySeq);
        prev = frag;
    }

    return tree;
}

/**
 * Build a multi-page tree that mimics cf-stream's real behavior:
 * - Members have ONLY a timestamp property (prov:generatedAtTime)
 * - Members do NOT have the sequence property (relay:eventId) in their quads
 *   because the SHACL shape doesn't include it
 * - GT relations use tree:path = sequencePath with UUIDv7 string values
 * - LDES metadata declares both timestampPath and sequencePath
 *
 * This is the exact scenario that caused the 6/10 member bug:
 * the marker is a string (from sequencePath GT relation) but member.sequence
 * is undefined, so the comparison must fall back correctly.
 */
function cfStreamLikeTree(
    perPage: number,
    pages: number,
): Tree<{ ts: string }> {
    const tsPath = TIMESTAMP_PATH;
    const seqPath = SEQUENCE_PATH;

    // Members only have timestamp, NOT sequence property
    const tree = new Tree<{ ts: string }>(
        (id, { ts }) =>
            new Parser().parse(
                `<${id}> <${tsPath}> "${ts}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`,
            ),
        tsPath,
        seqPath, // declared in metadata but NOT on member quads
    );

    const baseSeq = "01900000-0000-7000-8000-";
    let prev = tree.root();

    for (let p = 0; p < pages; p++) {
        const frag = tree.newFragment();
        for (let i = 0; i < perPage; i++) {
            const idx = p * perPage + i;
            const ts = new Date(2025, 0, 1, 0, 0, idx).toISOString();
            tree.fragment(frag).addMember(`m${idx}`, { ts });
        }
        // GT relation uses sequencePath with UUIDv7-like string value
        const boundarySeq = baseSeq + (p * perPage).toString().padStart(12, "0");
        tree.fragment(prev).relation(frag, GT, seqPath, boundarySeq);
        prev = frag;
    }

    return tree;
}

describe("Ordered strategy with sequence-based relations", () => {
    test("cf-stream scenario: members without sequence property, GT on sequencePath, emits all (3 pages x 3 members)", async () => {
        // This reproduces the exact bug: GT relation uses sequencePath with UUIDv7
        // string values, but members only have timestamp (no sequence property).
        // Before fix: only 6/9 emitted (members stuck in heap due to cross-type comparison).
        const tree = cfStreamLikeTree(3, 3);
        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(9);
    });

    test("cf-stream scenario: 4 pages x 3 members = 10 members with remainder page, emits all", async () => {
        // Mimics max_page_size=3 with 10 members: pages of 3, 3, 3, 1
        const tsPath = TIMESTAMP_PATH;
        const seqPath = SEQUENCE_PATH;
        const baseSeq = "01900000-0000-7000-8000-";

        const tree = new Tree<{ ts: string }>(
            (id, { ts }) =>
                new Parser().parse(
                    `<${id}> <${tsPath}> "${ts}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`,
                ),
            tsPath,
            seqPath,
        );

        let prev = tree.root();
        const pageSizes = [3, 3, 3, 1]; // 10 members total
        let memberIdx = 0;

        for (let p = 0; p < pageSizes.length; p++) {
            const frag = tree.newFragment();
            for (let i = 0; i < pageSizes[p]; i++) {
                const ts = new Date(2025, 0, 1, 0, 0, memberIdx).toISOString();
                tree.fragment(frag).addMember(`m${memberIdx}`, { ts });
                memberIdx++;
            }
            const boundarySeq = baseSeq + (p * 3).toString().padStart(12, "0");
            tree.fragment(prev).relation(frag, GT, seqPath, boundarySeq);
            prev = frag;
        }

        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(10);
    });

    test("_checkEmit emits members before all pages arrive (not just _checkEnd drain)", async () => {
        // This test catches the Date < string comparison bug.
        // Page 2 has a 500ms delay. If _checkEmit works, page 1 members are emitted
        // during the delay (before page 2 arrives). If broken (Date < string = false),
        // members are stuck until _checkEnd drains after ALL pages complete.
        //
        // Members only have timestamp (no sequence property), GT relation uses sequencePath.
        const tsPath = TIMESTAMP_PATH;
        const seqPath = SEQUENCE_PATH;
        const baseSeq = "01900000-0000-7000-8000-";

        const tree = new Tree<{ ts: string }>(
            (id, { ts }) =>
                new Parser().parse(
                    `<${id}> <${tsPath}> "${ts}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`,
                ),
            tsPath,
            seqPath,
        );

        // Page 1: instant, 3 members
        const frag1 = tree.newFragment();
        for (let i = 0; i < 3; i++) {
            tree.fragment(frag1).addMember(`m${i}`, {
                ts: new Date(2025, 0, 1, 0, 0, i).toISOString(),
            });
        }

        // Page 2: 500ms delay, 3 members
        const frag2 = tree.newFragment(500);
        for (let i = 3; i < 6; i++) {
            tree.fragment(frag2).addMember(`m${i}`, {
                ts: new Date(2025, 0, 1, 0, 0, i).toISOString(),
            });
        }

        // GT relations on sequencePath with string values
        tree.fragment(tree.root()).relation(frag1, GT, seqPath, baseSeq + "000000000000");
        tree.fragment(frag1).relation(frag2, GT, seqPath, baseSeq + "000000000003");

        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const reader = client.stream({ highWaterMark: 10 }).getReader();

        // Read members with a 300ms deadline — well before page 2's 500ms delay completes.
        // If _checkEmit works: page 1 members (3) are emitted during page 2's delay.
        // If _checkEmit is broken: 0 members emitted (stuck waiting for _checkEnd).
        const earlyMembers: unknown[] = [];
        const deadline = Date.now() + 300;
        let pendingRead = reader.read();
        while (Date.now() < deadline) {
            const result = await Promise.race([
                pendingRead.then(r => r),
                new Promise<null>(resolve =>
                    setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))
                ),
            ]);
            if (result === null) break; // timeout — pendingRead still active
            if (result.done || !result.value) { pendingRead = null!; break; }
            earlyMembers.push(result.value);
            pendingRead = reader.read();
        }

        // Page 1 members must be emitted before page 2 arrives
        expect(earlyMembers.length).toBeGreaterThanOrEqual(3);

        // Now read the rest, starting with the pending read if still active
        const allMembers = [...earlyMembers];
        if (pendingRead) {
            const result = await pendingRead;
            if (!result.done && result.value) allMembers.push(result.value);
        }
        while (true) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            allMembers.push(value);
        }
        expect(allMembers.length).toBe(6);
    });

    test("ascending with sequence-based GT relations emits all members", async () => {
        const tree = sequenceTree(3, 3);
        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(9);

        // Verify ascending order by sequence
        const sequences = members.map((m) => m.sequence);
        for (let i = 1; i < sequences.length; i++) {
            expect(sequences[i]! >= sequences[i - 1]!).toBe(true);
        }
    });

    test("descending with sequence-based LT relations emits all members", async () => {
        const seqPath = SEQUENCE_PATH;
        const tree = new Tree<{ ts: string; seq: string }>(
            (id, { ts, seq }) =>
                new Parser().parse(
                    `<${id}> <${TIMESTAMP_PATH}> "${ts}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.
                     <${id}> <${seqPath}> "${seq}".`,
                ),
            TIMESTAMP_PATH,
            seqPath,
        );

        const baseSeq = "01900000-0000-7000-8000-";
        // Page 1: higher sequences
        const frag1 = tree.newFragment();
        for (let i = 4; i >= 3; i--) {
            const seq = baseSeq + i.toString().padStart(12, "0");
            tree.fragment(frag1).addMember(`m${i}`, {
                ts: new Date(2025, 0, 1, 0, 0, i).toISOString(),
                seq,
            });
        }

        // Page 2: lower sequences
        const frag2 = tree.newFragment();
        for (let i = 2; i >= 1; i--) {
            const seq = baseSeq + i.toString().padStart(12, "0");
            tree.fragment(frag2).addMember(`m${i}`, {
                ts: new Date(2025, 0, 1, 0, 0, i).toISOString(),
                seq,
            });
        }

        // Root -> frag1 (no relation value, just link)
        tree.fragment(tree.root()).relation(frag1, "https://w3id.org/tree#relation");
        // frag1 -> frag2 via LT relation on sequence path
        const boundary = baseSeq + "000000000003";
        tree.fragment(frag1).relation(frag2, LT, seqPath, boundary);

        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "descending",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(4);
    });

    test("GT relation with unrelated path is ignored (not a crash)", async () => {
        const tree = new Tree<number>(
            (id, val) =>
                new Parser().parse(
                    `<${id}> <http://example.com/value> ${val}.`,
                ),
            "http://example.com/value",
        );

        const frag1 = tree.newFragment();
        tree.fragment(frag1).addMember("a1", 1);

        const frag2 = tree.newFragment();
        tree.fragment(frag2).addMember("a2", 2);

        // GT relation with an unrelated path (not timestampPath, not sequencePath)
        tree.fragment(tree.root()).relation(
            frag1,
            GT,
            "http://example.com/unrelated",
            "some-value",
        );
        tree.fragment(frag1).relation(
            frag2,
            GT,
            "http://example.com/unrelated",
            "another-value",
        );

        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const members = await read(client.stream());
        // Should still emit members without crashing
        expect(members.length).toBe(2);
    });

    test("sequence-only LDES (no timestampPath) works with ordered mode", async () => {
        const seqPath = "http://example.com/seqId";

        const tree = new Tree<string>(
            (id, seq) =>
                new Parser().parse(
                    `<${id}> <${seqPath}> "${seq}".`,
                ),
            undefined, // no timestampPath
            seqPath,
        );

        const frag1 = tree.newFragment();
        tree.fragment(frag1).addMember("s1", "aaa");
        tree.fragment(frag1).addMember("s2", "bbb");

        const frag2 = tree.newFragment();
        tree.fragment(frag2).addMember("s3", "ccc");
        tree.fragment(frag2).addMember("s4", "ddd");

        tree.fragment(tree.root()).relation(frag1, GT, seqPath, "aaa");
        tree.fragment(frag1).relation(frag2, GT, seqPath, "ccc");

        global.fetch = tree.mock();

        const client = replicateLDES(
            { url: tree.base() + tree.root() },
            "ascending",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(4);

        // Should be in ascending sequence order
        const sequences = members.map((m) => m.sequence);
        for (let i = 1; i < sequences.length; i++) {
            expect(sequences[i]! >= sequences[i - 1]!).toBe(true);
        }
    });
});
