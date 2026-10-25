/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, afterAll, describe, expect, test } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TREE } from "@treecg/types";
import { read, Tree } from "./helper";
import { MaxCountCondition } from "../lib/condition";
import { retry_fetch } from "../lib/fetcher";
import { intoConfig, replicateLDES } from "../lib/client";
import { parseQuads } from "../lib/utils";

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

describe("Simple Tree", () => {
    function simpleTree(
        perPage = 1,
        pages = 2,
        values = [3, 2],
        delay?: number,
    ): Tree<number> {
        // root -> first -> second
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );

        let prev = tree.root();

        for (let j = 0; j < pages; j++) {
            const first = tree.newFragment(delay);
            for (let i = 0; i < perPage; i++) {
                tree.fragment(first).addMember(
                    "a" + j + i,
                    values[j * perPage + i],
                );
            }
            tree.fragment(prev).relation(
                first,
                "https://w3id.org/tree#relation",
            );
            prev = first;
        }
        return tree;
    }

    test("ascending tree, emits ordered", async () => {
        const tree = simpleTree(1);
        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "ascending",
        );

        const members = await read(client.stream());

        expect(members.length).toBe(2);
        expect(members.map((x) => x.timestamp)).toEqual(
            ["2", "3"].map((x) => new Date(x)),
        );
    });

    test("descending tree, emits ordered", async () => {
        const tree = simpleTree(1);

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "descending",
        );

        const members = await read(client.stream());

        expect(members.length).toBe(2);
        expect(members.map((x) => x.timestamp)).toEqual(
            ["3", "2"].map((x) => new Date(x)),
        );
    });

    test("tree handles backpressure", async () => {
        const tree = simpleTree(
            2,
            6,
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            50,
        );

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "none",
        );

        const stream = client.stream({ highWaterMark: 1, size: () => 1 });

        const members = await read(stream);
        expect(tree.fetched.size).toEqual(7);
        expect(members.length).toBe(12);
    });

    test("unordered tree, emits", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "none",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(2);
        expect(new Set(members.map((x) => x.timestamp))).toEqual(
            new Set(["3", "2"].map((x) => new Date(x))),
        );
    });
});

describe("more complex tree", () => {
    function simpleTree(): Tree<number> {
        // root (2) -GTE> first (3)
        //  |> second (2)
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);

        const first = tree.newFragment();
        tree.fragment(first).addMember("b", 3);
        tree.fragment(tree.root()).relation(
            first,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            "3",
        );

        const second = tree.newFragment();
        tree.fragment(second).addMember("c", 2);
        tree.fragment(tree.root()).relation(second, TREE.relation);

        return tree;
    }

    test("tree handles backpressure", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "none",
        );

        const stream = client.stream({ highWaterMark: 1, size: () => 1 });

        const members = await read(stream);
        expect(tree.fetched.size).toEqual(3);
        expect(members.length).toBe(3);
    });

    test("unordered tree, emits", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "none",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(3);
    });

    test("ascending tree, emits ordered", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "ascending",
        );

        const members = await read(client.stream());

        expect(members.length).toBe(3);
        expect(members.map((x) => x.timestamp)).toEqual(
            ["2", "3", "5"].map((x) => new Date(x)),
        );
    });

    test("descending tree, emits ordered", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "descending",
        );

        const members = await read(client.stream());

        expect(members.length).toBe(3);
        expect(members.map((x) => x.timestamp)).toEqual(
            ["5", "3", "2"].map((x) => new Date(x)),
        );
    });

    test("ordered tree, emits asap", async () => {
        const tree = simpleTree();

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
            },
            "ascending",
        );

        const first = await client.stream().getReader().read();
        expect(first.done).toBe(false);
        expect(first.value?.timestamp).toEqual(new Date("2"));
        await client.close();
    });

    test("ordered tree, emits asap ascending", async () => {
        // root (2) -GTE> first (3) -GTE (delay)> second (5)
        const tree = new Tree<Date>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb.toISOString()}" .`,
                ),
            "http://example.com/value",
        );
        const rootFragment = tree.fragment(tree.root());
        // rootFragment.addMember("a", new Date(5));

        const first = tree.newFragment();
        const frag1 = tree.fragment(first);
        frag1.addMember("b", new Date(3));
        rootFragment.relation(
            first,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(3).toISOString(),
        );

        const second = tree.newFragment(150);
        const frag2 = tree.fragment(second);
        frag2.addMember("c", new Date(7));
        frag1.relation(
            second,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(5).toISOString(),
        );

        const mock = tree.mock();
        global.fetch = mock;

        const base = tree.base() + tree.root();
        const client = replicateLDES(
            {
                polling: false,
                url: base,
            },
            "ascending",
        );

        const start = new Date();
        const stream = client.stream().getReader();
        const m1 = await stream.read();
        expect(m1.done).toBeFalsy();
        let end = new Date();

        const m2 = await stream.read();
        expect(m2.done).toBeFalsy();
        end = new Date();
        expect(end.getTime() - start.getTime()).toBeGreaterThan(150);
        await stream.cancel();
    });

    test("ordered tree, emits asap ascending (branched)", async () => {
        // root -GTE 3> first (10) second (4)
        //      -GTE 5> second (delay)> (6)
        const tree = new Tree<Date>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb.toISOString()}" .`,
                ),
            "http://example.com/value",
        );
        const rootFragment = tree.fragment(tree.root());

        const first = tree.newFragment();
        rootFragment.relation(
            first,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(3).toISOString(),
        );
        const frag1 = tree.fragment(first);
        frag1.addMember("b", new Date(4));

        const second = tree.newFragment(150);
        rootFragment.relation(
            second,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(5).toISOString(),
        );
        const frag2 = tree.fragment(second);
        frag2.addMember("c", new Date(6));

        const mock = tree.mock();
        global.fetch = mock;

        const base = tree.base() + tree.root();
        const client = replicateLDES(
            {
                polling: false,
                url: base,
            },
            "ascending",
        );

        const start = new Date();
        const stream = client.stream().getReader();
        const m1 = await stream.read();
        expect(m1.done).toBeFalsy();
        let end = new Date();

        const m2 = await stream.read();
        expect(m2.done).toBeFalsy();
        end = new Date();
        expect(end.getTime() - start.getTime()).toBeGreaterThan(150);
        await stream.cancel();
    });

    test("ordered tree, emits asap descending", async () => {
        // root -LTE> first (10) -LTE (delay)> second (7)
        const tree = new Tree<Date>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb.toISOString()}" .`,
                ),
            "http://example.com/value",
        );
        const rootFragment = tree.fragment(tree.root());

        const first = tree.newFragment();
        const frag1 = tree.fragment(first);
        frag1.addMember("b", new Date(10));
        rootFragment.relation(
            first,
            TREE.LessThanOrEqualToRelation,
            "http://example.com/value",
            new Date(12).toISOString(),
        );
        rootFragment.relation(
            first,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(5).toISOString(),
        );

        const second = tree.newFragment(150);
        frag1.relation(
            second,
            TREE.LessThanOrEqualToRelation,
            "http://example.com/value",
            new Date(9).toISOString(),
        );
        frag1.relation(
            second,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(5).toISOString(),
        );
        const frag2 = tree.fragment(second);
        frag2.addMember("c", new Date(7));

        const mock = tree.mock();
        global.fetch = mock;

        const base = tree.base() + tree.root();
        const client = replicateLDES(
            {
                polling: false,
                url: base,
            },
            "descending",
        );

        const start = new Date();
        const stream = client.stream().getReader();
        const m1 = await stream.read();
        expect(m1.done).toBeFalsy();
        let end = new Date();

        const m2 = await stream.read();
        expect(m2.done).toBeFalsy();
        end = new Date();
        expect(end.getTime() - start.getTime()).toBeGreaterThan(150);
        await stream.cancel();
    });

    test("ordered tree, emits asap descending (branched)", async () => {
        // root -LTE 10> first (10) second (7)
        //      -LTE 6> second (delay)> (5)
        const tree = new Tree<Date>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb.toISOString()}" .`,
                ),
            "http://example.com/value",
        );
        const rootFragment = tree.fragment(tree.root());

        const first = tree.newFragment();
        rootFragment.relation(
            first,
            TREE.LessThanOrEqualToRelation,
            "http://example.com/value",
            new Date(10).toISOString(),
        );
        rootFragment.relation(
            first,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(6).toISOString(),
        );
        const frag1 = tree.fragment(first);
        frag1.addMember("b", new Date(7));

        const second = tree.newFragment(150);
        rootFragment.relation(
            second,
            TREE.LessThanOrEqualToRelation,
            "http://example.com/value",
            new Date(6).toISOString(),
        );
        rootFragment.relation(
            second,
            TREE.GreaterThanOrEqualToRelation,
            "http://example.com/value",
            new Date(3).toISOString(),
        );
        const frag2 = tree.fragment(second);
        frag2.addMember("c", new Date(5));

        const mock = tree.mock();
        global.fetch = mock;

        const base = tree.base() + tree.root();
        const client = replicateLDES(
            {
                polling: false,
                url: base,
            },
            "descending",
        );

        const start = new Date();
        const stream = client.stream().getReader();
        const m1 = await stream.read();
        expect(m1.done).toBeFalsy();
        let end = new Date();

        const m2 = await stream.read();
        expect(m2.done).toBeFalsy();
        end = new Date();
        expect(end.getTime() - start.getTime()).toBeGreaterThan(150);
        await stream.cancel();
    });

    test("Polling works, single page", async () => {
        // return;
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);
        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                polling: true,
                url: base,
            },
            "none",
        );

        let hasPolled: undefined | ((b: unknown) => void) = undefined;
        const polled = new Promise((res) => (hasPolled = res));

        let added = false;

        client.on("poll", () => {
            if (!added) {
                tree.fragment(tree.root()).addMember("b", 7);
                added = true;
                hasPolled!({});
            }
        });

        const reader = client.stream().getReader();

        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value?.timestamp).toEqual(new Date("5"));

        await polled;

        const second = await reader.read();
        expect(second.done).toBe(false);
        expect(second.value?.timestamp).toEqual(new Date("7"));

        await reader.cancel();
    });

    test("Polling works, single page - ordered", async () => {
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);
        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                polling: true,
                url: base,
            },
            "ascending",
        );

        let hasPolled: undefined | ((b: unknown) => void) = undefined;
        const polled = new Promise((res) => (hasPolled = res));

        let added = false;

        client.on("poll", () => {
            if (!added) {
                tree.fragment(tree.root()).addMember("b", 7);
                added = true;
                hasPolled!({});
            }
        });

        const reader = client.stream().getReader();

        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value?.timestamp).toEqual(new Date("5"));

        await polled;

        const second = await reader.read();
        expect(second.done).toBe(false);
        expect(second.value?.timestamp).toEqual(new Date("7"));

        await reader.cancel();
    });

    test("Polling works, single page - max values", async () => {
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);
        tree.fragment(tree.root()).addMember("a", 6);
        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                polling: true,
                url: base,
                condition: new MaxCountCondition({
                    count: 1,
                    reset_on_poll: true,
                }),
            },
            "ascending",
        );

        let hasPolled: undefined | ((b: unknown) => void) = undefined;
        const polled = new Promise((res) => (hasPolled = res));

        let added = false;

        client.on("poll", () => {
            if (!added) {
                tree.fragment(tree.root()).addMember("b", 4);
                added = true;
                hasPolled!({});
            }
        });

        const reader = client.stream().getReader();

        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value?.timestamp).toEqual(new Date("5"));

        const secondPromise = reader.read().then((second) => {
            expect(second.done).toBe(false);
            expect(second.value?.timestamp).toEqual(new Date("4"));
            expect(added).toBeTruthy();
        });

        await polled;

        await secondPromise;

        await reader.cancel();
    });

    test("Exponential backoff works", async () => {
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);
        const frag = tree.newFragment();
        tree.fragment(tree.root()).relation(
            frag,
            "https://w3id.org/tree#relation",
        );
        tree.fragment(frag).setFailcount(2).addMember("b", 7);

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
                fetch: retry_fetch(fetch, {
                    codes: [408, 425, 429, 500, 502, 503, 504],
                    base: 100,
                    maxRetries: 5,
                }),
            },
            "none",
        );

        const members = await read(client.stream());
        expect(members.length).toBe(2);
    });

    test("Exponential backoff works, handle max retries", async () => {
        const tree = new Tree<number>(
            (x, numb) =>
                parseQuads(
                    `<${x}> <http://example.com/value> "${numb}" .`,
                ),
            "http://example.com/value",
        );
        tree.fragment(tree.root()).addMember("a", 5);
        const frag = tree.newFragment();
        tree.fragment(tree.root()).relation(
            frag,
            "https://w3id.org/tree#relation",
        );
        tree.fragment(frag).setFailcount(5).addMember("b", 7);

        const base = tree.base() + tree.root();
        const mock = tree.mock();
        global.fetch = mock;

        const client = replicateLDES(
            {
                url: base,
                fetch: retry_fetch(fetch, {
                    codes: [408, 425, 429, 500, 502, 503, 504],
                    base: 100,
                    maxRetries: 5,
                }),
            },
            "none",
        );

        let errorCb = false;
        let thrown = false;

        client.on("error", () => (errorCb = true));
        try {
            await read(client.stream());
        } catch (ex) {
            thrown = true;
        }

        expect(thrown).toBeTruthy();
        expect(errorCb).toBeTruthy();
    });

    test("Default fetch retries all LDES transient status codes", async () => {
        const statuses = [408, 425, 429, 500, 502, 503, 504, 200];
        const seen: number[] = [];
        global.fetch = (async () => {
            const status = statuses.shift() ?? 200;
            seen.push(status);
            return new Response("", { status });
        }) as typeof fetch;

        const config = intoConfig({ url: "http://example.com/ldes" });
        const startedAt = Date.now();
        const response = await config.fetch!("http://example.com/ldes");

        expect(response.status).toBe(200);
        expect(seen).toEqual([408, 425, 429, 500, 502, 503, 504, 200]);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    });

    test("Default fetch treats 410 Gone as an empty successful RDF response", async () => {
        global.fetch = (async () => new Response("", { status: 410 })) as typeof fetch;

        const config = intoConfig({ url: "http://example.com/ldes" });
        const response = await config.fetch!("http://example.com/retired");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/turtle");
        expect(await response.text()).toBe("");
    });

    test("Ordered traversal accepts direct sequence path metadata", async () => {
        global.fetch = (async () => new Response(`
@prefix ex: <http://example.com/> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .

<http://example.com/ldes> tree:view <http://example.com/ldes>;
  ldes:sequencePath ex:sequence;
  tree:member <http://example.com/member/three>, <http://example.com/member/one>, <http://example.com/member/two> .

<http://example.com/member/three> ex:sequence 3; ex:value "three" .
<http://example.com/member/one> ex:sequence 1; ex:value "one" .
<http://example.com/member/two> ex:sequence 2; ex:value "two" .
`, {
            headers: { "content-type": "text/turtle" },
        })) as typeof fetch;

        const client = replicateLDES({
            url: "http://example.com/ldes",
            noShape: true,
        }, "ascending");

        const members = await read(client.stream());

        expect(members.map((member) => member.id.value)).toEqual([
            "http://example.com/member/one",
            "http://example.com/member/two",
            "http://example.com/member/three",
        ]);
    });

    test("Ordered traversal evaluates RDF list sequence paths", async () => {
        global.fetch = (async () => new Response(`
@prefix ex: <http://example.com/> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .

<http://example.com/ldes> tree:view <http://example.com/ldes>;
  ldes:sequencePath ( ex:metadata ex:sequence );
  tree:member <http://example.com/member/two>, <http://example.com/member/one> .

<http://example.com/member/two> ex:metadata [ ex:sequence 2 ]; ex:value "two" .
<http://example.com/member/one> ex:metadata [ ex:sequence 1 ]; ex:value "one" .
`, {
            headers: { "content-type": "text/turtle" },
        })) as typeof fetch;

        const client = replicateLDES({
            url: "http://example.com/ldes",
            noShape: true,
        }, "ascending");

        const members = await read(client.stream());

        expect(members.map((member) => member.id.value)).toEqual([
            "http://example.com/member/one",
            "http://example.com/member/two",
        ]);
    });

    test("Description exposes root context even when shape extraction is disabled", async () => {
        global.fetch = (async () => new Response(`
@prefix ex: <http://example.com/> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .

<http://example.com/ldes> tree:view <http://example.com/ldes>;
  tree:shape ex:ShapeA, ex:ShapeB;
  ldes:timestampPath ex:created;
  ldes:versionTimestampPath ex:modified;
  ldes:versionSequencePath ex:version;
  ldes:pollingInterval 30 .

<http://example.com/ldes> tree:viewDescription ex:service;
  ldes:retentionPolicy ex:direct-policy .
ex:service ldes:retentionPolicy ex:service-policy .
`, {
            headers: { "content-type": "text/turtle" },
        })) as typeof fetch;

        const client = replicateLDES({
            url: "http://example.com/ldes",
            noShape: true,
        });
        let context: Parameters<Parameters<typeof client.on<"description">>[1]>[0] | undefined;
        client.on("description", (description) => {
            context = description;
        });

        await read(client.stream());

        expect(context?.rootNode?.value).toBe("http://example.com/ldes");
        expect(context?.shapes?.map((shape) => shape.value).sort()).toEqual([
            "http://example.com/ShapeA",
            "http://example.com/ShapeB",
        ]);
        expect(context?.viewDescriptions?.map((description) => description.value)).toEqual([
            "http://example.com/service",
        ]);
        expect(context?.retentionPolicies?.map((policy) => policy.value).sort()).toEqual([
            "http://example.com/direct-policy",
            "http://example.com/service-policy",
        ]);
        expect(context?.timestampPath?.value).toBe("http://example.com/created");
        expect(context?.versionTimestampPath?.value).toBe("http://example.com/modified");
        expect(context?.versionSequencePath?.value).toBe("http://example.com/version");
        expect(context?.pollingInterval).toBe(30);
        expect(context?.contextQuads?.length).toBeGreaterThan(0);
    });

    test("Saved state skips immutable pages and revalidates mutable pages with ETags", async () => {
        const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "ldes-cache-state-"));
        let phase: "initial" | "repeat" = "initial";
        const requests: { path: string; ifNoneMatch?: string | null }[] = [];
        global.fetch = (async (input, init) => {
            const url = new URL(input.toString());
            const ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
            requests.push({ path: url.pathname, ifNoneMatch });

            if (url.pathname === "/root") {
                return turtleResponse(`
@prefix tree: <https://w3id.org/tree#> .
<http://example.com/cache-stream> tree:view <http://example.com/root> .
<http://example.com/root> tree:relation
  [ tree:node <http://example.com/rdf-immutable> ],
  [ tree:node <http://example.com/header-immutable> ],
  [ tree:node <http://example.com/mutable> ] .
`);
            }
            if (url.pathname === "/rdf-immutable") {
                if (phase === "repeat") {
                    return new Response("", { status: 500 });
                }
                return turtleResponse(`
@prefix ex: <http://example.com/> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .
<http://example.com/rdf-immutable> ldes:immutable true .
<http://example.com/cache-stream> tree:member <http://example.com/member/rdf> .
<http://example.com/member/rdf> ex:value "rdf immutable" .
`);
            }
            if (url.pathname === "/header-immutable") {
                if (phase === "repeat") {
                    return new Response("", { status: 500 });
                }
                return turtleResponse(`
@prefix ex: <http://example.com/> .
@prefix tree: <https://w3id.org/tree#> .
<http://example.com/cache-stream> tree:member <http://example.com/member/header> .
<http://example.com/member/header> ex:value "header immutable" .
`, {
                    "cache-control": "public, max-age=31536000, immutable",
                });
            }
            if (url.pathname === "/mutable") {
                if (phase === "repeat") {
                    return new Response(null, {
                        status: 304,
                        headers: { etag: '"mutable-v1"' },
                    });
                }
                return turtleResponse(`
@prefix ex: <http://example.com/> .
@prefix tree: <https://w3id.org/tree#> .
<http://example.com/cache-stream> tree:member <http://example.com/member/mutable> .
<http://example.com/member/mutable> ex:value "mutable" .
`, {
                    etag: '"mutable-v1"',
                });
            }
            return new Response("", { status: 404 });
        }) as typeof fetch;

        try {
            const initial = await read(replicateLDES({
                url: "http://example.com/root",
                noShape: true,
                statePath,
            }).stream());
            phase = "repeat";
            const repeat = await read(replicateLDES({
                url: "http://example.com/root",
                noShape: true,
                statePath,
            }).stream());

            expect(initial.map((member) => member.id.value).sort()).toEqual([
                "http://example.com/member/header",
                "http://example.com/member/mutable",
                "http://example.com/member/rdf",
            ]);
            expect(repeat).toHaveLength(0);
            expect(requests.filter((request) => request.path === "/rdf-immutable")).toHaveLength(1);
            expect(requests.filter((request) => request.path === "/header-immutable")).toHaveLength(1);
            expect(
                requests.findLast((request) => request.path === "/mutable")?.ifNoneMatch,
            ).toBe('"mutable-v1"');
        } finally {
            fs.rmSync(statePath, { recursive: true, force: true });
        }
    });
});

function turtleResponse(body: string, headers: Record<string, string> = {}): Response {
    return new Response(body, {
        headers: {
            "content-type": "text/turtle",
            ...headers,
        },
    });
}
