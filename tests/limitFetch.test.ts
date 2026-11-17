/**
 * The fetch of the client allows a limited number of concurrent requests per domain. A request that fails with a network error
 * (e.g. a server that drops the connection) has to free its slot as well: otherwise, once as many requests failed as there are
 * slots, every next request to that domain waits forever, and so does the stream.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { replicateLDES } from "../lib/client";
import { limit_fetch_per_domain } from "../lib/fetcher";

/** Whether a promise settles within the time, so that a test fails instead of hanging */
function settles<T>(promise: Promise<T>, ms: number): Promise<"settled" | "waiting"> {
    return Promise.race([
        promise.then(
            () => "settled" as const,
            () => "settled" as const,
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms)),
    ]);
}

describe("Limiting the requests per domain", () => {
    test("a request that throws frees its slot", async () => {
        let calls = 0;
        const fetch_f = (async () => {
            calls++;
            if (calls <= 2) throw new TypeError("fetch failed");
            return new Response("ok");
        }) as typeof fetch;
        const limited = limit_fetch_per_domain(fetch_f, 2);

        await expect(limited("http://example.org/a")).rejects.toThrow("fetch failed");
        await expect(limited("http://example.org/b")).rejects.toThrow("fetch failed");

        // Both slots were taken by requests that failed
        const third = limited("http://example.org/c");
        expect(await settles(third, 1000)).toBe("settled");
        expect(await (await third).text()).toBe("ok");
    });

    test("a request that waits for a slot gets it when a running request throws", async () => {
        let fail!: (error: Error) => void;
        const fetch_f = (async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/a")) return new Promise<Response>((_, reject) => (fail = reject));
            return new Response("ok");
        }) as typeof fetch;
        const limited = limit_fetch_per_domain(fetch_f, 1);

        const first = limited("http://example.org/a");
        const second = limited("http://example.org/b");
        expect(await settles(second, 100)).toBe("waiting");

        fail(new TypeError("fetch failed"));
        await expect(first).rejects.toThrow("fetch failed");
        expect(await settles(second, 1000)).toBe("settled");
    });
});

describe("A server that drops the requests for members", () => {
    // The shape requires a property that the members do not have in the page, so the client dereferences them,
    // and those requests fail: more of them than there are slots, as each one is retried
    let base = "";
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/member/")) {
            res.socket?.destroy();
            return;
        }
        res.writeHead(200, { "content-type": "text/turtle" }).end(`
            @prefix tree: <https://w3id.org/tree#> . @prefix ldes: <https://w3id.org/ldes#> .
            @prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://example.org/> .
            <${base}/stream> a ldes:EventStream ; tree:view <${base}/stream> ;
                tree:shape [ a sh:NodeShape ; sh:property [ sh:path ex:required ; sh:minCount 1 ] ] ;
                tree:member <${base}/member/a>, <${base}/member/b> .
            <${base}/member/a> a ex:Thing .
            <${base}/member/b> a ex:Thing .`);
    });

    beforeAll(
        () =>
            new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", () => {
                    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
                    resolve();
                }),
            ),
    );
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    test("the stream ends, instead of waiting forever for a free slot", async () => {
        const client = replicateLDES({ url: `${base}/stream`, transferRetry: { base: 1 } });
        const reader = client.stream().getReader();
        const read = (async () => {
            while (!(await reader.read()).done);
        })();
        expect(await settles(read, 10000)).toBe("settled");
        await client.close();
    }, 15000);
});
