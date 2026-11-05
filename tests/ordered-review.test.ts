import { afterEach, describe, expect, test } from "vitest";
import { DataFactory, Parser } from "n3";
import { OrderedStrategy } from "../lib/ldes1/strategy/ordered";
import { RelationChain } from "../lib/ldes1/fetcher/relation";
import type { Fetcher, Manager, ModulatorFactory } from "../lib/ldes1/fetcher";
import type { LDESInfo, Notifier, OrderValue, StrategyEvents } from "../lib/types";
import { replicateLDES } from "../lib/client";
import { read, Tree } from "./helper";

const TIMESTAMP = "http://example.org/time";
const SEQUENCE = "http://example.org/sequence";
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

type SavedFragment = { chain: RelationChain; expected: Set<string> };

function codecs(sequence: boolean) {
    let encode!: (fragment: SavedFragment) => unknown;
    let decode!: (fragment: unknown) => SavedFragment;
    const factory = {
        create: (...args: unknown[]) => {
            encode = args[3] as typeof encode;
            decode = args[4] as typeof decode;
            return {};
        },
    } as unknown as ModulatorFactory;
    new OrderedStrategy(
        {} as Manager, {} as Fetcher, {} as Notifier<StrategyEvents, unknown>,
        factory, {
            timestampPath: sequence ? undefined : DataFactory.namedNode(TIMESTAMP),
            sequencePath: sequence ? DataFactory.namedNode(SEQUENCE) : undefined,
        } as LDESInfo, "ascending", false,
    );
    return { encode, decode };
}

describe("ordered state restoration", () => {
    test.each(["", "01", "2025-01-01", "2025-01-01T00:00:00.000Z", "uuid-value"])("preserves sequence string %s through JSON", (value) => {
        const { encode, decode } = codecs(true);
        const input = { chain: new RelationChain("root", "page", [{ important: true, value }]), expected: new Set(["page"]) };
        const restored = decode(JSON.parse(JSON.stringify(encode(input))));
        expect(restored.chain.relations[0].value).toBe(value);
        expect(restored.expected).toEqual(input.expected);
    });

    test("preserves numeric sentinel values", () => {
        const { encode, decode } = codecs(false);
        const input = { chain: new RelationChain("root", "page", [{ important: false, value: 0 }]), expected: new Set<string>() };
        expect(decode(JSON.parse(JSON.stringify(encode(input)))).chain.relations[0].value).toBe(0);
    });

    test("restores timestamp markers as dates", () => {
        const { encode, decode } = codecs(false);
        const value = new Date("2025-01-01T00:00:00.000Z");
        const input = { chain: new RelationChain("root", "page", [{ important: true, value }]), expected: new Set<string>() };
        expect(decode(JSON.parse(JSON.stringify(encode(input)))).chain.relations[0].value).toEqual(value);
    });

    test.each([true, false])("reads legacy state with sequence ordering %s", (sequence) => {
        const { decode } = codecs(sequence);
        const value = "2025-01-01T00:00:00.000Z";
        const restored = decode({ chain: { source: "root", target: "page", relations: [{ important: true, value }] }, expected: [] });
        const actual: OrderValue = restored.chain.relations[0].value;
        expect(actual).toEqual(sequence ? value : new Date(value));
    });
});

test.each(["ascending", "descending"] as const)("%s traversal keeps timestamp order when sequence values conflict", async (order) => {
    const tree = new Tree<{ time: string; sequence: string }>((id, member) => new Parser().parse(
        `<${id}> <${TIMESTAMP}> "${member.time}"^^<http://www.w3.org/2001/XMLSchema#dateTime>; <${SEQUENCE}> "${member.sequence}".`,
    ), TIMESTAMP, SEQUENCE);
    const page = tree.newFragment(30);
    const ascending = order === "ascending";
    tree.fragment(tree.root()).addMember("root-member", { time: ascending ? "2020-01-01T00:00:00Z" : "2022-01-01T00:00:00Z", sequence: ascending ? "z" : "a" });
    tree.fragment(page).addMember("page-member", { time: "2021-01-01T00:00:00Z", sequence: ascending ? "a" : "z" });
    tree.fragment(tree.root()).relation(page, `https://w3id.org/tree#${ascending ? "GreaterThanRelation" : "LessThanRelation"}`, TIMESTAMP, ascending ? "2020-12-31T00:00:00Z" : "2021-12-31T00:00:00Z");
    global.fetch = tree.mock();
    const members = await read(replicateLDES({ url: tree.base() + tree.root() }, order).stream());
    expect(members.map(member => member.sequence)).toEqual(ascending ? ["z", "a"] : ["a", "z"]);
});

test.each(["ascending", "descending"] as const)("%s order uses sequence only to break timestamp ties", async (order) => {
    const tree = new Tree<{ time: string; sequence: string }>((id, member) => new Parser().parse(
        `<${id}> <${TIMESTAMP}> "${member.time}"^^<http://www.w3.org/2001/XMLSchema#dateTime>; <${SEQUENCE}> "${member.sequence}".`,
    ), TIMESTAMP, SEQUENCE);
    tree.fragment(tree.root())
        .addMember("newest", { time: "2022-01-01T00:00:00Z", sequence: "a" })
        .addMember("older-high-sequence", { time: "2020-01-01T00:00:00Z", sequence: "z" })
        .addMember("older-low-sequence", { time: "2020-01-01T00:00:00Z", sequence: "b" });
    global.fetch = tree.mock();
    const members = await read(replicateLDES({ url: tree.base() + tree.root() }, order).stream());
    const ascending = ["older-low-sequence", "older-high-sequence", "newest"].map(id => tree.base() + id);
    expect(members.map(member => member.id.value)).toEqual(order === "ascending" ? ascending : ascending.reverse());
});

test("sequence-only traversal emits a safe member while a later page is blocked", async () => {
    const tree = new Tree<string>((id, sequence) => new Parser().parse(`<${id}> <${SEQUENCE}> "${sequence}".`), undefined, SEQUENCE);
    const page = tree.newFragment();
    tree.fragment(tree.root()).addMember("first", "a");
    tree.fragment(page).addMember("last", "c");
    tree.fragment(tree.root()).relation(page, "https://w3id.org/tree#GreaterThanRelation", SEQUENCE, "b");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const mock = tree.mock();
    let laterPageReturned = false;
    global.fetch = async (input, init) => {
        if (String(input) === tree.base() + page) {
            await blocked;
            laterPageReturned = true;
        }
        return mock(input, init);
    };
    const reader = replicateLDES({ url: tree.base() + tree.root() }, "ascending").stream().getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const first = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("safe emission blocked")), 1000); }),
        ]);
        expect(first.value?.sequence).toBe("a");
        expect(laterPageReturned).toBe(false);
        release();
        expect((await reader.read()).value?.sequence).toBe("c");
        expect((await reader.read()).done).toBe(true);
    } finally {
        clearTimeout(timeout);
        release();
        await reader.cancel();
    }
});
