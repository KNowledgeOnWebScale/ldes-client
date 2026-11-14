import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicateLDES } from "../../lib/client";
import { FeedServer } from "./feedServer";
import { feeds, items } from "./feeds";

import type { Ordered } from "../../lib/client";
import type { Feed, Item } from "./feeds";
import type { LoggedRequest } from "./feedServer";
import type { LDESInfo } from "../../lib/types";

/**
 * Resuming a replication of a feed that is published like the LDESs of Marine Regions, the Rijksmuseum, MINT and
 * an OpenLDES server (see feeds.ts). What matters is what happens at the start of a resumed replication: which
 * requests are made, and whether they work. A request that is not answered with a success (a 404, for example) is
 * a replication that can not be resumed.
 *
 * A test that describes a problem that is not solved yet is a `test.fails` with the reason in its comment: when the client is
 * fixed, vitest reports that `test.fails` must be removed. There are none now.
 * To count how often a member is lost or emitted twice over many interrupted replications: tests/resume/interrupt-stats.test.ts.
 */

// A server for every test, on a port of its own: a client of an earlier test that still makes a request would be in the log of this one
let server: FeedServer;
let state: string;
beforeEach(async () => {
    server = new FeedServer();
    await server.start();
    state = fs.mkdtempSync(path.join(os.tmpdir(), "ldes-resume-"));
});
afterEach(async () => {
    await server.stop();
    fs.rmSync(state, { recursive: true, force: true });
});

/** Items in two periods: the year changes in the first, the month in the second, and the second ends on a later day */
const period = (count: number, from: number, start: string): Item[] => items(count, from, Date.parse(start));
const first = [...period(8, 0, "2025-12-31T22:00:00Z"), ...period(22, 8, "2026-01-31T20:00:00Z")];
const lastTime = (list: Item[]) => list[list.length - 1].t.getTime();
/** More items on the day of the latest item: the latest page grows */
const sameDay = (list: Item[], count: number) => items(count, list.length, lastTime(list) + 20 * 60_000);
/** Items on a later day: the latest page is closed, and a new one is opened */
const nextDay = (list: Item[], count: number) => items(count, list.length, Date.UTC(2026, 1, 3, 9, 0, 0));

type Run = { ids: string[]; error?: Error; log: LoggedRequest[] };

async function replicate(
    url: string,
    options: { limit?: number; ordered?: Ordered; highWaterMark?: number; onDescription?: (info: LDESInfo) => void } = {},
    config: Record<string, unknown> = {},
): Promise<Run> {
    const client = replicateLDES({ url, statePath: state, ...config }, options.ordered ?? "none");
    if (options.onDescription) client.on("description", options.onDescription);
    const ids: string[] = [];
    let error: Error | undefined;
    try {
        for await (const member of client.stream({ highWaterMark: options.highWaterMark ?? 10 })) {
            ids.push(member.id.value);
            if (options.limit && ids.length >= options.limit) {
                await client.close();
                break;
            }
        }
    } catch (e) {
        error = e as Error;
    }
    // A client that was closed can have requests in flight: they are part of this run
    await server.settle();
    return { ids, error, log: server.takeLog() };
}

const show = (log: LoggedRequest[]) => log.map((r) => `${r.status} ${r.url}${r.conditional ? " [If-None-Match]" : ""}`).join("\n");
const failures = (log: LoggedRequest[]) => log.filter((r) => r.status >= 400);
/** The URLs that are requested more than once: a page is requested once in a replication */
const repeated = (log: LoggedRequest[]) => [...new Set(log.filter((r, i) => log.findIndex((other) => other.url === r.url) !== i).map((r) => r.url))];
const immutableUrls = () => [...server.routes].filter(([, route]) => route.headers?.["cache-control"]?.includes("immutable")).map(([url]) => url);

/** FEEDS=rijks,mint runs the tests of these feeds only */
const selected = feeds.filter((feed) => !process.env.FEEDS || process.env.FEEDS.split(",").includes(feed.name));

describe.each(selected)("A feed published like $name", (feed: Feed) => {
    const ids = (list: Item[]) => list.map((item) => feed.memberId(server, item)).sort();
    const run = (options: Parameters<typeof replicate>[1] = {}) => replicate(feed.entry(server), options, feed.options);

    test.each(feed.orders)(
        "is replicated completely, ordered: %s, and a second replication emits nothing and requests no page that is immutable",
        async (ordered) => {
            feed.publish(server, first);
            const immutable = immutableUrls();
            const run1 = await run({ ordered });
            expect(run1.error).toBeUndefined();
            expect(run1.ids.sort(), show(run1.log)).toEqual(ids(first));
            expect(failures(run1.log), show(run1.log)).toEqual([]);
            expect(repeated(run1.log), show(run1.log)).toEqual([]);

            const run2 = await run({ ordered });
            expect(run2.error).toBeUndefined();
            expect(run2.ids).toEqual([]);
            expect(failures(run2.log), show(run2.log)).toEqual([]);
            expect(
                run2.log.filter((r) => immutable.includes(r.url)),
                show(run2.log),
            ).toEqual([]);
            expect(repeated(run2.log), show(run2.log)).toEqual([]);
        },
    );

    test.each(feed.orders)(
        "is resumed after it has grown, twice, ordered: %s: only the new members are emitted, and none of the requests fails",
        async (ordered) => {
            feed.publish(server, first);
            await run({ ordered });

            // The latest page grows. A page that was not immutable when the client read it, may be now.
            const immutable0 = immutableUrls();
            const second = [...first, ...sameDay(first, 6)];
            feed.publish(server, second);
            const immutable1 = immutableUrls().filter((url) => immutable0.includes(url));
            server.takeLog();
            const run2 = await run({ ordered });
            expect(run2.error).toBeUndefined();
            expect(run2.ids.sort(), show(run2.log)).toEqual(ids(second.slice(first.length)));
            expect(failures(run2.log), show(run2.log)).toEqual([]);
            expect(
                run2.log.filter((r) => immutable1.includes(r.url)),
                show(run2.log),
            ).toEqual([]);
            expect(repeated(run2.log), show(run2.log)).toEqual([]);

            // A later day: the latest page is closed, and a new page opens
            const immutableBefore = immutableUrls();
            const third = [...second, ...nextDay(second, 5)];
            feed.publish(server, third);
            const immutable2 = immutableUrls().filter((url) => immutableBefore.includes(url));
            server.takeLog();
            const run3 = await run({ ordered });
            expect(run3.error).toBeUndefined();
            expect(run3.ids.sort(), show(run3.log)).toEqual(ids(third.slice(second.length)));
            expect(failures(run3.log), show(run3.log)).toEqual([]);
            expect(
                run3.log.filter((r) => immutable2.includes(r.url)),
                show(run3.log),
            ).toEqual([]);
            expect(repeated(run3.log), show(run3.log)).toEqual([]);
        },
    );

    // The description of Marine Regions says how often to poll (a day), and that is what this client does
    (feed.name === "marine" ? test.skip : test).each(feed.orders)(
        "is followed without a state that is configured, ordered: %s: the pages that are immutable are requested once, the others with their ETag",
        async (ordered) => {
            feed.publish(server, first);
            const immutable = immutableUrls();
            // No statePath and no storage: the client keeps what it needs in memory
            const client = replicateLDES({ url: feed.entry(server), polling: true, pollInterval: 30, ...feed.options }, ordered);
            const seen: string[] = [];
            const reader = (async () => {
                for await (const member of client.stream()) seen.push(member.id.value);
            })();
            // Enough time for a number of polls
            await new Promise((resolve) => setTimeout(resolve, 600));
            await client.close();
            // The stream of a client that follows has no end: it is closed, and that is all
            await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 300))]);
            await server.settle();
            const log = server.takeLog();
            expect(seen.sort(), show(log)).toEqual(ids(first));
            const heads = log.filter((r) => !immutable.includes(r.url) && feed.isLeaf(r.url));
            expect(heads.length, "the polls that were made\n" + show(log)).toBeGreaterThan(3);
            expect(repeated(log.filter((r) => immutable.includes(r.url))), show(log)).toEqual([]);
            // A page that has an ETag is requested again with it, and has not changed
            const again = log.filter((r, i) => log.findIndex((other) => other.url === r.url) !== i && server.routes.get(r.url)?.etag);
            expect(
                again.every((r) => r.conditional && r.status === 304),
                show(log),
            ).toBe(true);
            if (feed.name === "openldes") expect(again.length, show(log)).toBeGreaterThan(3);
        },
    );

    describe.each(feed.orders)("interrupted again and again, ordered: %s", (ordered) => {
        /**
         * A consumer that stops after 7 members, every time. A member is remembered as emitted when the consumer has read it, and
         * not when it is put in the buffer of the stream: the members that are in the buffer when the consumer stops, and the members
         * of the pages that are being fetched at that time, are emitted by the next run. None is lost, and none is emitted twice.
         * `RESUME_STATS=1` counts it over 15 interrupted replications: tests/resume/interrupt-stats.test.ts.
         */
        test.each([1, 7, 10_000])(
            "with a stream that buffers %i members: every member is emitted once, none of the requests fails",
            async (highWaterMark) => {
                feed.publish(server, first);
                const emitted: string[] = [];
                const all: LoggedRequest[] = [];
                let finished = false;
                for (let i = 0; i < 80 && !finished; i++) {
                    const result = await run({ limit: 7, ordered, highWaterMark });
                    all.push(...result.log);
                    expect(result.error, `${result.error}\n${show(result.log)}`).toBeUndefined();
                    emitted.push(...result.ids);
                    finished = result.ids.length < 7;
                }
                expect(finished, "the replication does not finish").toBe(true);
                expect(failures(all), show(all)).toEqual([]);
                expect(
                    ids(first).filter((id) => !emitted.includes(id)),
                    "members that were never emitted",
                ).toEqual([]);
                expect(
                    emitted.filter((id, i) => emitted.indexOf(id) !== i),
                    "members that were emitted twice",
                ).toEqual([]);
            },
        );
    });

    /**
     * A feed that removes pages, as a retention policy does (Marine Regions, the Rijksmuseum and Telraam all have one).
     * The page was found by the first run, which was stopped before it was read, and is gone at the next. The specification says that
     * a client reports an error for a page that answers 404 (a removed page is a 410), and the page is in the state of the client:
     * the run fails at that page, and so does every run after it. `skipMissingPages` skips the page with a warning, and the next runs
     * do not request it.
     */
    const removeUnreadPage = async (context: { skip: () => never }) => {
        feed.publish(server, first);
        const run1 = await run({ limit: 9 });
        const requested = new Set(run1.log.map((r) => r.url));
        const unread = [...server.routes]
            .filter(([url, route]) => !route.redirect && !requested.has(url) && feed.isLeaf(url))
            .map(([url]) => url)
            .pop();
        if (!unread) return context.skip();
        server.routes.delete(unread);
        return unread;
    };

    test("is an error when a page that was found is removed (404), as the specification says, and the state is not locked", async (context) => {
        const unread = await removeUnreadPage(context);
        for (const attempt of [1, 2]) {
            const retry = await run();
            expect(retry.error?.message, `attempt ${attempt}\n${show(retry.log)}`).toMatch(/404/);
            expect(retry.log.filter((r) => r.url === unread).length, show(retry.log)).toBeGreaterThan(0);
        }
    });

    test("is resumed when a page that was found, but not read yet, is removed, and skipMissingPages is set", async (context) => {
        const unread = await removeUnreadPage(context);
        for (const attempt of [1, 2]) {
            const retry = await replicate(feed.entry(server), {}, { ...feed.options, skipMissingPages: true });
            expect(retry.error, `attempt ${attempt}: ${retry.error}\n${show(retry.log)}`).toBeUndefined();
            // The page is requested once, and never again: it is not in the state of the client any more
            expect(retry.log.filter((r) => r.url === unread).length, show(retry.log)).toBe(attempt === 1 ? 1 : 0);
        }
    });

    test("is not resumed past a page that is gone (410): that is a page without members and relations, and no error", async (context) => {
        const unread = await removeUnreadPage(context);
        server.route(unread, { body: "", type: "text/html", status: 410 });
        const retry = await run();
        expect(retry.error, show(retry.log)).toBeUndefined();
    });
});

describe("An OpenLDES view", () => {
    const openldes = feeds.find((feed) => feed.name === "openldes")!;

    test("is a page that is dct:isPartOf the LDES, has no tree:view, and gets its description from the LDES", async () => {
        openldes.publish(server, first);
        let description: LDESInfo | undefined;
        const result = await replicate(openldes.entry(server), { onDescription: (info) => (description = info) });
        expect(result.error).toBeUndefined();
        expect(result.ids).toHaveLength(first.length);
        expect(description?.timestampPath?.value).toBe("http://www.w3.org/ns/prov#generatedAtTime");
        expect(description?.versionOfPath?.value).toBe("http://purl.org/dc/terms/isVersionOf");
        // The page, and the description of the LDES. Not the other view of the LDES, which this client does not follow.
        expect(result.log.map((r) => r.url).slice(0, 2)).toEqual(["/measurements/by-page", "/measurements"]);
        expect(result.log.map((r) => r.url)).not.toContain("/measurements/by-time");
    });

    test("is not requested again when the replication is resumed, only the LDES and the root are revalidated", async () => {
        openldes.publish(server, first);
        await replicate(openldes.entry(server));
        server.takeLog();
        const again = await replicate(openldes.entry(server));
        expect(again.ids).toEqual([]);
        // The root and the last page, with their ETag: they are not immutable (max-age=60)
        expect(again.log.filter((r) => r.url.startsWith("/measurements/by-page")).map((r) => [r.url, r.status])).toEqual([
            ["/measurements/by-page", 304],
            [`/measurements/by-page?pageNumber=${first.length / 5}`, 304],
        ]);
    });
});

describe("An entry that does not work", () => {
    test("is an error, and does not keep the state of the client locked: a client that follows can use it", async () => {
        // As the catalogue of a government that links to /ldes/observations of a server that moved the LDES
        const openldes = feeds.find((feed) => feed.name === "openldes")!;
        openldes.publish(server, first);
        server.redirect("/ldes/observations", "/observations");
        const stale = await replicate(`${server.base}/ldes/observations`);
        expect(stale.error?.message).toMatch(/404/);
        expect(stale.log.map((r) => [r.url, r.status])).toEqual([
            ["/ldes/observations", 302],
            ["/observations", 404],
        ]);

        const good = await replicate(openldes.entry(server));
        expect(good.error).toBeUndefined();
        expect(good.ids).toHaveLength(first.length);
    });
});

describe("A page that two pages lead to", () => {
    const publish = (cacheControl: string) => {
        const prefixes = `@prefix tree: <https://w3id.org/tree#> . @prefix ldes: <https://w3id.org/ldes#> . @prefix dc: <http://purl.org/dc/terms/> .`;
        const turtle = { type: "text/turtle", etag: true, headers: { "cache-control": cacheControl } };
        const stream = `${server.base}/ldes`;
        const relations = (...targets: string[]) =>
            targets.map((t) => `<${stream}> tree:relation [ a tree:Relation ; tree:node <${server.base}${t}> ] .`).join("\n");
        server.route("/ldes", { ...turtle, body: `${prefixes}\n<${stream}> a ldes:EventStream ; tree:view <${stream}> .\n${relations("/a", "/b")}` });
        server.route("/a", {
            ...turtle,
            body: `${prefixes}\n<${server.base}/a> a tree:Node .\n<${server.base}/a> tree:relation [ a tree:Relation ; tree:node <${server.base}/c> ] .`,
        });
        server.route("/b", {
            ...turtle,
            body: `${prefixes}\n<${server.base}/b> a tree:Node .\n<${server.base}/b> tree:relation [ a tree:Relation ; tree:node <${server.base}/c> ] .`,
        });
        server.route("/c", { ...turtle, body: `${prefixes}\n<${stream}> tree:member <${server.base}/m1> .\n<${server.base}/m1> dc:title "m1" .` });
    };

    test.each(["public,max-age=60", "public,max-age=31536000,immutable"])("is requested once in a replication: %s", async (cacheControl) => {
        publish(cacheControl);
        const run = await replicate(`${server.base}/ldes`, {}, {});
        expect(run.error).toBeUndefined();
        expect(run.ids, show(run.log)).toEqual([`${server.base}/m1`]);
        expect(repeated(run.log), show(run.log)).toEqual([]);
    });
});
