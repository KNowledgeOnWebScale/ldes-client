declare module "ldfetch/lib/RdfParsers.js" {
    import type { Readable } from "stream";
    import type { EventEmitter } from "events";

    export type ParseOptions = {
        contentType: string;
        baseIRI: string;
        requestUrl?: string;
        bodyText?: string;
        bodyBuffer?: Buffer;
        /** Loads the remote JSON-LD contexts (anything with an async `load(url)`) */
        documentLoader?: { load(url: string): Promise<unknown> };
    };

    export function parse(options: ParseOptions): EventEmitter;
    export function parseStream(stream: Readable, options: { contentType: string; baseIRI: string }): EventEmitter;
    export function prepareStream(
        stream: Readable,
        options: {
            contentType: string;
            url: string;
            requestUrl?: string;
            contentDisposition?: string | null;
        },
    ): Promise<{ stream: Readable; contentType: string; decompressed: boolean }>;
    export function isStreamable(contentType: string): boolean;
    export function resolveContentType(contentType: string, url: string, fallbackUrl?: string): string;
}

declare module "ldfetch/lib/HttpCache.js" {
    /** The response shape that HttpCache stores (the one that ldfetch's NodeHttpFetcher resolves with) */
    export type CachedResponse = {
        url: string;
        type: string;
        body: string;
        bodyBuffer: Buffer;
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
    };

    export type HttpCacheOptions = {
        /** Anything with get/set/delete (sync or async). Defaults to an in-memory LRU. */
        store?: {
            get(key: string): unknown;
            set(key: string, value: unknown): unknown;
            delete(key: string): unknown;
        };
        /** Seconds a response is served without asking the server, even when its headers say it is stale */
        minTTL?: number;
        /** Seconds after which a response is revalidated, even when its headers promise longer freshness */
        maxTTL?: number;
        overrideNoStore?: boolean;
        /** Size of the default in-memory store */
        maxEntries?: number;
    };

    export type CacheEntry = unknown;

    export type LookupResult =
        { state: "miss" } | { state: "fresh"; response: CachedResponse } | { state: "stale"; headers: Record<string, string>; entry: CacheEntry };

    export default class HttpCache {
        constructor(options?: HttpCacheOptions);
        lookup(method: string, url: string, headers: Record<string, string>): Promise<LookupResult>;
        put(method: string, url: string, requestHeaders: Record<string, string>, response: CachedResponse): Promise<boolean>;
        revalidated(
            method: string,
            url: string,
            requestHeaders: Record<string, string>,
            entry: CacheEntry,
            notModified: { statusCode: number; headers: Record<string, string | string[] | undefined> },
        ): Promise<CachedResponse>;
        getStats(): { hits: number; misses: number; revalidations: number; stores: number; keys?: number };
    }
}

declare module "ldfetch/lib/ContextLoader.js" {
    import type HttpCache from "ldfetch/lib/HttpCache.js";
    import type { IDocumentLoader } from "jsonld-context-parser";

    export type ContextLoaderOptions = {
        /** Any fetch function. Defaults to the global fetch. */
        fetch?: typeof fetch;
        /** Without a cache, nothing is stored */
        cache?: HttpCache | null;
        /** For a fetch that hides the real status of a response, such as a 304 behind an empty 200 */
        getStatus?: (response: Response) => number;
    };

    export function cachedDocumentLoader(options?: ContextLoaderOptions): IDocumentLoader;
    export const CONTEXT_ACCEPT: string;
}
