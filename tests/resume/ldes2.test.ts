import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicateLDES } from "../../lib/client";
import { FeedServer } from "./feedServer";

import type { Ordered } from "../../lib/client";
import type { LoggedRequest } from "./feedServer";

/**
 * Following and resuming an LDES 2.0: a root with relations to pages of members that are ordered on a timestamp, the last of which grows.
 * The requests are what matters, as in resume.test.ts: a page that has not changed is answered with a 304 to the request that has its ETag,
 * and a replication that is interrupted again and again emits every member once.
 */
let server: FeedServer;
let state: string;
beforeEach(async () => {
    server = new FeedServer();
    await server.start();
    state = fs.mkdtempSync(path.join(os.tmpdir(), "ldes2-resume-"));
});
afterEach(async () => {
    await server.stop();
    fs.rmSync(state, { recursive: true, force: true });
});

const PAGE_SIZE = 5;
const start = Date.parse("2026-01-01T00:00:00Z");
const timeOf = (n: number) => new Date(start + n * 20 * 60_000).toISOString();
const members = (count: number, from = 0) => Array.from({ length: count }, (_, i) => from + i);
const memberId = (n: number) => `http://example.org/m${n}`;

/** Publishes members 0..count-1: the pages that are full are closed, the last one can grow */
function publish(count: number) {
    server.routes.clear();
    const base = server.base;
    const turtle = { type: "application/trig", etag: true };
    const header = `VERSION "1.2-messages"
PREFIX ldes: <https://w3id.org/ldes#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX ex: <http://example.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>
`;
    const pages = Array.from({ length: Math.ceil(count / PAGE_SIZE) }, (_, i) => members(Math.min(PAGE_SIZE, count - i * PAGE_SIZE), i * PAGE_SIZE));
    const relations = pages
        .map((page, i) => {
            const closed = i < pages.length - 1;
            return `[ ldes:page <${base}/ldes2/p${i + 1}> ; ldes:timeFrom "${timeOf(page[0])}"^^xsd:dateTime${closed ? ` ; ldes:timeUntil "${timeOf(page[page.length - 1])}"^^xsd:dateTime` : ""} ]`;
        })
        .join(" ,\n  ");
    server.route("/ldes2/root", {
        ...turtle,
        body: `${header}
ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .
<${base}/ldes2/root> ldes:relation ${relations} .`,
    });
    pages.forEach((page, i) => {
        server.route(`/ldes2/p${i + 1}`, {
            ...turtle,
            body: `${header}\n${page.map((n) => `ex:m${n} a ex:Record ; dcterms:created "${timeOf(n)}"^^xsd:dateTime .`).join("\nMESSAGE\n")}`,
        });
    });
}

const root = () => `${server.base}/ldes2/root`;
const show = (log: LoggedRequest[]) => log.map((r) => `${r.status} ${r.url}${r.conditional ? " [If-None-Match]" : ""}`).join("\n");
const repeated = (log: LoggedRequest[]) => [...new Set(log.filter((r, i) => log.findIndex((other) => other.url === r.url) !== i).map((r) => r.url))];

async function replicate(options: { limit?: number; highWaterMark?: number; ordered?: Ordered } = {}) {
    const client = replicateLDES({ url: root(), statePath: state }, "none");
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
    await server.settle();
    return { ids, error, log: server.takeLog() };
}

describe("An LDES 2.0 that is resumed", () => {
    test("is replicated completely, and a second replication emits nothing and gets 304s for what can change", async () => {
        publish(23);
        const run1 = await replicate();
        expect(run1.error).toBeUndefined();
        expect(run1.ids.sort()).toEqual(members(23).map(memberId).sort());
        expect(repeated(run1.log), show(run1.log)).toEqual([]);

        const run2 = await replicate();
        expect(run2.error).toBeUndefined();
        expect(run2.ids).toEqual([]);
        // The root and the last page can change: they are requested with their ETags, and have not changed. The other pages are not requested.
        expect(
            run2.log.map((r) => [r.url, r.status, r.conditional]),
            show(run2.log),
        ).toEqual([
            ["/ldes2/root", 304, true],
            ["/ldes2/p5", 304, true],
        ]);
    });

    test("is resumed after it has grown: only the new members are emitted, and the page that did not change is a 304", async () => {
        publish(23);
        await replicate();

        // The last page grows, and a new page opens: the root changes
        publish(31);
        const run2 = await replicate();
        expect(run2.error).toBeUndefined();
        expect(run2.ids.sort(), show(run2.log)).toEqual(members(8, 23).map(memberId).sort());
        expect(run2.log.find((r) => r.url === "/ldes2/root")).toMatchObject({ status: 200, conditional: true });
        expect(repeated(run2.log), show(run2.log)).toEqual([]);

        // The last page grows: the root does not change
        publish(34);
        const run3 = await replicate();
        expect(run3.ids.sort(), show(run3.log)).toEqual(members(3, 31).map(memberId).sort());
        expect(
            run3.log.map((r) => [r.url, r.status, r.conditional]),
            show(run3.log),
        ).toEqual([
            ["/ldes2/root", 304, true],
            ["/ldes2/p7", 200, true],
        ]);
    });

    test("is followed: the root and the last page are requested with their ETags in every poll, and new members arrive", async () => {
        publish(12);
        const client = replicateLDES({ url: root(), polling: true, pollInterval: 30 }, "none");
        const seen: string[] = [];
        const reader = (async () => {
            for await (const member of client.stream()) seen.push(member.id.value);
        })();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const quiet = server.takeLog();
        publish(15);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const grown = server.takeLog();
        await client.close();
        await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 300))]);
        await server.settle();

        expect(seen.sort()).toEqual(members(15).map(memberId).sort());
        // After the first pass, the polls are conditional requests that are answered with a 304
        const polls = quiet.slice(4);
        expect(polls.length, show(quiet)).toBeGreaterThan(4);
        expect(
            polls.every((r) => r.conditional && r.status === 304),
            show(quiet),
        ).toBe(true);
        expect(
            grown.some((r) => r.url === "/ldes2/p3" && r.status === 200 && r.conditional),
            show(grown),
        ).toBe(true);
    });

    describe.each([1, 7, 10_000])("interrupted again and again, with a stream that buffers %i members", (highWaterMark) => {
        test("every member is emitted once", async () => {
            publish(30);
            const emitted: string[] = [];
            let finished = false;
            for (let i = 0; i < 80 && !finished; i++) {
                const result = await replicate({ limit: 7, highWaterMark });
                expect(result.error, `${result.error}\n${show(result.log)}`).toBeUndefined();
                expect(
                    result.log.filter((r) => r.status >= 400),
                    show(result.log),
                ).toEqual([]);
                emitted.push(...result.ids);
                finished = result.ids.length < 7;
            }
            expect(finished, "the replication does not finish").toBe(true);
            expect(
                members(30)
                    .map(memberId)
                    .filter((id) => !emitted.includes(id)),
                "members that were never emitted",
            ).toEqual([]);
            expect(
                emitted.filter((id, i) => emitted.indexOf(id) !== i),
                "members that were emitted twice",
            ).toEqual([]);
        });
    });
});
