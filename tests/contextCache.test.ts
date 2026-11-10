/**
 * External JSON-LD contexts are shared by the pages of an LDES, so they are cached following HTTP caching semantics,
 * with a client-set minimum TTL. The pages themselves are not cached.
 */
import { describe, expect, test } from "vitest";
import { empty_special_status_fetch } from "../lib/fetcher";
import { ContextCache } from "../lib/fetcher/contextCache";
import { LdfetchDereferencer } from "../lib/fetcher/ldfetchDereferencer";
import { streamToArray } from "../lib/utils";

const CONTEXT_URL = "http://ctx.example/context.jsonld";
const CONTEXT = JSON.stringify({ "@context": { name: "http://schema.org/name" } });
const NAME = "http://schema.org/name";

type Served = { url: string; headers: Headers };

/** A server with a context at CONTEXT_URL (with the given headers) and JSON-LD pages that use it */
function server(contextHeaders: Record<string, string> = {}) {
    const requests: Served[] = [];
    const fetch_f = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({ url, headers });
        if (url === CONTEXT_URL) {
            const etag = contextHeaders["etag"];
            if (etag && headers.get("if-none-match") === etag) {
                return new Response(null, { status: 304, headers: contextHeaders });
            }
            return new Response(CONTEXT, {
                status: 200,
                headers: { "content-type": "application/ld+json", ...contextHeaders },
            });
        }
        return new Response(JSON.stringify({ "@context": CONTEXT_URL, "@id": url, name: `page ${url}` }), {
            status: 200,
            headers: { "content-type": "application/ld+json" },
        });
    }) as typeof fetch;
    return {
        fetch: empty_special_status_fetch(fetch_f),
        contextRequests: () => requests.filter((r) => r.url === CONTEXT_URL),
        pageRequests: () => requests.filter((r) => r.url !== CONTEXT_URL),
    };
}

async function read(dereferencer: LdfetchDereferencer, fetch_f: typeof fetch, page: number) {
    const { data } = await dereferencer.dereference(`http://pages.example/${page}`, { fetch: fetch_f });
    return streamToArray(data);
}

describe("Caching of external JSON-LD contexts", () => {
    test("a context that is shared by pages is fetched once, also without cache headers", async () => {
        const { fetch: f, contextRequests } = server();
        const dereferencer = new LdfetchDereferencer();

        for (let page = 0; page < 3; page++) {
            const quads = await read(dereferencer, f, page);
            expect(quads.map((q) => q.predicate.value)).toEqual([NAME]);
        }

        expect(contextRequests()).toHaveLength(1);
        expect(dereferencer.getContextCacheStats()).toMatchObject({ stores: 1, hits: 2 });
    });

    test("pages that are read at the same time share one request for the context", async () => {
        const { fetch: f, contextRequests } = server();
        const dereferencer = new LdfetchDereferencer();

        const pages = await Promise.all([0, 1, 2, 3, 4].map((page) => read(dereferencer, f, page)));

        expect(pages.every((quads) => quads.length === 1)).toBe(true);
        expect(contextRequests()).toHaveLength(1);
    });

    test("the pages themselves are not cached", async () => {
        const { fetch: f, pageRequests } = server();
        const dereferencer = new LdfetchDereferencer();

        await read(dereferencer, f, 1);
        await read(dereferencer, f, 1);

        expect(pageRequests()).toHaveLength(2);
        expect(dereferencer.getContextCacheStats()).toMatchObject({ stores: 1 });
    });

    test("without a minimum TTL, a context that is stale is revalidated, and a 304 keeps it usable", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "max-age=0", etag: '"v1"' });
        const dereferencer = new LdfetchDereferencer(undefined, { minTTL: 0 });

        await read(dereferencer, f, 1);
        const quads = await read(dereferencer, f, 2);

        expect(quads.map((q) => q.predicate.value)).toEqual([NAME]);
        const requests = contextRequests();
        expect(requests).toHaveLength(2);
        expect(requests[1].headers.get("if-none-match")).toBe('"v1"');
        expect(dereferencer.getContextCacheStats()).toMatchObject({ revalidations: 1 });
    });

    test("the minimum TTL keeps a context that its server calls stale", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "max-age=0" });
        const dereferencer = new LdfetchDereferencer(undefined, { minTTL: 600 });

        await read(dereferencer, f, 1);
        await read(dereferencer, f, 2);

        expect(contextRequests()).toHaveLength(1);
    });

    test("Cache-Control: no-store is honoured, whatever the minimum TTL", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "no-store" });
        const dereferencer = new LdfetchDereferencer(undefined, { minTTL: 600 });

        await read(dereferencer, f, 1);
        await read(dereferencer, f, 2);

        expect(contextRequests()).toHaveLength(2);
    });

    test("contexts are not cached when that is disabled", async () => {
        const { fetch: f, contextRequests } = server();
        const dereferencer = new LdfetchDereferencer(undefined, false);

        await read(dereferencer, f, 1);
        await read(dereferencer, f, 2);

        expect(contextRequests()).toHaveLength(2);
        expect(dereferencer.getContextCacheStats()).toBeUndefined();
    });

    test("a context that cannot be loaded is not cached, and is tried again", async () => {
        let fail = true;
        const { fetch: ok, contextRequests } = server();
        const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (fail && String(input) === CONTEXT_URL) return new Response("nope", { status: 404 });
            return ok(input, init);
        }) as typeof fetch;
        const dereferencer = new LdfetchDereferencer();

        await expect(read(dereferencer, f, 1)).rejects.toThrow();
        fail = false;
        const quads = await read(dereferencer, f, 2);

        expect(quads).toHaveLength(1);
        expect(contextRequests()).toHaveLength(1);
    });

    test("a context is parsed once, not for every page", async () => {
        const { fetch: f } = server();
        const contexts = new ContextCache({ minTTL: 600 });
        const loader = contexts.documentLoader(f);

        const first = await loader.load(CONTEXT_URL);
        const second = await loader.load(CONTEXT_URL);

        expect(second).toBe(first);
    });

    test("a parsed context is replaced when its response is", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "max-age=0", etag: '"v1"' });
        const contexts = new ContextCache({ minTTL: 0 });
        const loader = contexts.documentLoader(f);

        const first = await loader.load(CONTEXT_URL);
        const revalidated = await loader.load(CONTEXT_URL);
        const again = await loader.load(CONTEXT_URL);

        expect(contextRequests()).toHaveLength(3);
        expect(revalidated).toEqual(first);
        expect(again).toEqual(first);
        expect(contexts.getStats()).toMatchObject({ revalidations: 2 });
    });

    test("a store that serializes its entries (a disk-backed one, for example) works too", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "max-age=0", etag: '"v1"' });
        const entries = new Map<string, string>();
        const store = {
            get: (key: string) => (entries.has(key) ? JSON.parse(entries.get(key)!) : undefined),
            set: (key: string, value: unknown) => void entries.set(key, JSON.stringify(value)),
            delete: (key: string) => void entries.delete(key),
        };
        const dereferencer = new LdfetchDereferencer(undefined, { store, minTTL: 600 });

        for (let page = 0; page < 3; page++) {
            const quads = await read(dereferencer, f, page);
            expect(quads.map((q) => q.predicate.value)).toEqual([NAME]);
        }

        expect(contextRequests()).toHaveLength(1);
        expect(entries.size).toBe(1);
    });

    test("options that are not given keep their default", async () => {
        const { fetch: f, contextRequests } = server({ "cache-control": "max-age=0" });
        // No minTTL: the default keeps the context for 10 minutes. A maxTTL below that lowers it instead of failing.
        const dereferencer = new LdfetchDereferencer(undefined, { maxTTL: 60 });
        await read(dereferencer, f, 1);
        await read(dereferencer, f, 2);
        expect(contextRequests()).toHaveLength(1);
    });
});
