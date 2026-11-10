import HttpCache from "ldfetch/lib/HttpCache.js";
import { cachedDocumentLoader } from "ldfetch/lib/ContextLoader.js";

import type { IDocumentLoader } from "jsonld-context-parser";
import type { HttpCacheOptions } from "ldfetch/lib/HttpCache.js";

const ORIGINAL_STATUS_HEADER = "x-ldes-client-original-status";

/**
 * How external JSON-LD contexts (e.g. `https://schema.org`) are cached.
 *
 * Only contexts are cached: the pages of an LDES are never requested twice in a run, so caching them would only cost
 * memory. The pages of an LDES do share their contexts though, so these are not downloaded again for every page.
 *
 * The cache follows HTTP caching semantics (`Cache-Control`, `Expires`, `Age`, `Vary`, and revalidation with
 * `ETag`/`Last-Modified`), see https://github.com/pietercolpaert/ldfetch#http-caching. Contexts hardly ever change,
 * but are often served without useful cache headers, so a minimum TTL applies by default.
 */
export type ContextCacheOptions = HttpCacheOptions;

/** The context cache that is used when nothing is configured: follow the headers, but use a response for at least 10 minutes */
export const DEFAULT_CONTEXT_CACHE: ContextCacheOptions = { minTTL: 10 * 60, maxEntries: 100 };

/** What is not given keeps its default, but a `maxTTL` below the default `minTTL` lowers that */
function withDefaults(options: ContextCacheOptions = {}): ContextCacheOptions {
    const out = { ...DEFAULT_CONTEXT_CACHE, ...options };
    if (options.minTTL === undefined && options.maxTTL !== undefined) {
        out.minTTL = Math.min(out.minTTL!, options.maxTTL);
    }
    return out;
}

/** The client's fetch hides 304 and 410 behind an empty 200 and a header with the original status */
function originalStatus(response: Response): number {
    return Number(response.headers.get(ORIGINAL_STATUS_HEADER) ?? response.status);
}

/**
 * Loads external JSON-LD contexts through an HTTP cache, with the loader of ldfetch: contexts that are requested at the
 * same time share one request, and a parsed context is the same object for as long as its cache entry lives.
 */
export class ContextCache {
    public readonly cache: HttpCache;
    /**
     * One loader per fetch function: the sharing of requests and of parsed contexts is per loader,
     * and the pages of one client all use the same fetch.
     */
    private loaders = new WeakMap<typeof fetch, IDocumentLoader>();

    constructor(options?: ContextCacheOptions | HttpCache) {
        this.cache = options instanceof HttpCache ? options : new HttpCache(withDefaults(options));
    }

    /** A document loader for the JSON-LD parser, that fetches with `fetch_f` when the cache can't answer */
    documentLoader(fetch_f: typeof fetch): IDocumentLoader {
        let loader = this.loaders.get(fetch_f);
        if (!loader) {
            loader = cachedDocumentLoader({ fetch: fetch_f, cache: this.cache, getStatus: originalStatus });
            this.loaders.set(fetch_f, loader);
        }
        return loader;
    }

    getStats() {
        return this.cache.getStats();
    }
}

/** A document loader that never caches, for `contextCache: false` */
export function uncachedDocumentLoader(fetch_f: typeof fetch): IDocumentLoader {
    return cachedDocumentLoader({ fetch: fetch_f, getStatus: originalStatus });
}
