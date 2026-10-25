
import { RdfDereferencer } from "rdf-dereference";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { LDES } from "@treecg/types";
import { getLoggerFor } from "../utils";
import { extractRelations } from "./relation";

import type { IDereferenceOptions } from "rdf-dereference";
import type { Condition } from "../condition";
import type { Notifier } from "./modulator";
import type { FoundRelation } from "./relation";

const { namedNode } = new DataFactory();

/**
 * target: url to fetch
 * expected: relations that can be found, and should be ignored
 *   examples are the originating url
 */
export type Node = {
    target: string;
    expected: Set<string>;
    etag?: string;
    relations?: string[];
};

export type FetchedPage = {
    url: string;
    data: RdfStore;
    immutable: boolean;
    memberCount: number;
    etag?: string;
    status?: number;
    created?: Date;
    updated?: Date;
};

export type LongPromise = {
    waiting: Promise<void>;
    callback: () => void;
};

export function longPromise(): LongPromise {
    const out = {} as LongPromise;
    out.waiting = new Promise((res) => (out.callback = res));
    return out;
}

export function resetPromise(promise: LongPromise) {
    const cb = promise.callback;
    promise.waiting = new Promise((res) => (promise.callback = res));
    cb();
}

export async function statelessPageFetch(
    location: string,
    dereferencer: RdfDereferencer,
    fetch_f?: typeof fetch,
    headers?: Record<string, string>,
): Promise<FetchedPage> {
    let etag: string | undefined;
    let status = 200;
    const fetchWithMetadata: typeof fetch = async (input, init) => {
        const resp = await (fetch_f ?? fetch)(input, init);
        etag = resp.headers.get("etag") ?? undefined;
        status = Number(resp.headers.get("x-ldes-client-original-status") ?? resp.status);
        return resp;
    };
    const resp = await dereferencer.dereference(location, {
        localFiles: true,
        fetch: fetchWithMetadata,
        headers,
    });
    const url = resp.url;
    const data = RdfStore.createDefault();
    await new Promise((resolve, reject) => {
        data.import(resp.data).on("end", resolve).on("error", reject);
    });
    return <FetchedPage>{
        url,
        data,
        immutable: false,
        memberCount: 0,
        etag: etag ?? resp.headers?.get("etag") ?? undefined,
        status,
    };
}

export type FetchEvent = {
    relationsFound: { from: Node; target: FoundRelation }[];
    pageFetched: FetchedPage;
    scheduleFetch: Node;
    error: unknown;
};

export type Cache = {
    immutable?: boolean;
    maxAge?: number;
    etag?: string;
};

export class Fetcher {
    private dereferencer: RdfDereferencer;
    private loose: boolean;
    private fetch_f?: typeof fetch;
    private condition: Condition;
    private defaultTimezone: string;
    private includeMetadata: boolean;

    private closed = false;

    private logger = getLoggerFor(this);

    constructor(
        dereferencer: RdfDereferencer,
        loose: boolean,
        condition: Condition,
        defaultTimezone: string,
        includeMetadata: boolean,
        fetch_f?: typeof fetch,
    ) {
        this.dereferencer = dereferencer;
        this.loose = loose;
        this.fetch_f = fetch_f;
        this.condition = condition;
        this.defaultTimezone = defaultTimezone;
        this.includeMetadata = includeMetadata;
    }

    close() {
        this.closed = true;
    }

    async fetch<S>(node: Node, state: S, notifier: Notifier<FetchEvent, S>) {
        try {
            const options: IDereferenceOptions = {
                localFiles: true,
                fetch: this.fetch_f,
            };
            if (node.etag) {
                options.headers = {
                    ...options.headers,
                    "If-None-Match": node.etag,
                };
            }
            if (this.includeMetadata) {
                options.headers = {
                    ...options.headers,
                    Accept: "application/metadata+trig",
                };
            }
            const resp = await this.dereferencer.dereference(node.target, options);

            node.target = resp.url;

            const cache = {} as Cache;
            if (resp.headers) {
                const cacheControlCandidate = resp.headers.get("cache-control");
                cache.etag = resp.headers.get("etag") ?? undefined;
                if (cacheControlCandidate) {
                    const controls = cacheControlCandidate
                        .split(",")
                        .map((x) => x.split("=", 2).map((x) => x.trim()));

                    for (const control of controls) {
                        if (control[0] == "max-age") {
                            cache.maxAge = parseInt(control[1]);
                        }

                        if (control[0] == "immutable") {
                            cache.immutable = true;
                        }
                    }
                }
            }

            this.logger.debug(
                `[fetch] Cache for ${node.target} ${JSON.stringify(cache)}`,
            );

            const data = RdfStore.createDefault();
            let quadCount = 0;
            await new Promise((resolve, reject) => {
                resp.data
                    .on("data", (quad) => {
                        data.addQuad(quad);
                        quadCount++;
                    })
                    .on("end", resolve)
                    .on("error", reject);
            });

            await this.processFetchedPage(
                node,
                {
                    data,
                    url: resp.url,
                    immutable: !!cache.immutable,
                    memberCount: 0,
                    etag: cache.etag,
                    status: Number(resp.headers?.get("x-ldes-client-original-status") ?? 200),
                },
                state,
                notifier,
                cache,
            );
        } catch (ex) {
            this.logger.error(`[fetch] Fetch failed for ${node.target} ${JSON.stringify(ex)}`);
            notifier.error(ex, state);
        }
    }

    async processFetchedPage<S>(
        node: Node,
        page: FetchedPage,
        state: S,
        notifier: Notifier<FetchEvent, S>,
        cache: Cache = {},
    ) {
        cache.immutable ||= page.immutable || isRdfImmutable(page.data, namedNode(page.url));

        this.logger.debug(`[fetch] Got data ${page.url}`);
        const toFetch: { from: Node; target: FoundRelation }[] = page.status === 304
            ? (node.relations ?? []).map((target) => ({
                from: node,
                target: {
                    source: page.url,
                    node: target,
                    allowed: true,
                    relations: [],
                },
            }))
            : [];
        for (const rel of extractRelations(
            page.data,
            namedNode(page.url),
            this.loose,
            this.condition,
            this.defaultTimezone,
        )) {
            if (!node.expected.has(rel.node) && rel.allowed) {
                toFetch.push({ from: node, target: rel });
            }
        }

        if (!cache.immutable && !this.closed) {
            notifier.scheduleFetch({
                ...node,
                target: page.url,
                etag: cache.etag ?? node.etag,
                relations: toFetch.map(({ target }) => target.node),
            }, state);
        }

        if (!this.closed) {
            if (toFetch.length > 0) {
                await notifier.relationsFound(toFetch, state);
            }
            notifier.pageFetched({
                data: page.data,
                url: page.url,
                immutable: !!cache.immutable,
                memberCount: 0,
                etag: cache.etag ?? page.etag,
                status: page.status,
                created: page.created,
                updated: page.updated,
            }, state);
        }
    }
}

function isRdfImmutable(data: RdfStore, page: ReturnType<typeof namedNode>): boolean {
    return data
        .getQuads(page, LDES.terms.custom("immutable"), null, null)
        .some((quad) => quad.object.termType === "Literal" && quad.object.value === "true");
}
