import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { LDES } from "@treecg/types";
import { errorMessage, getLoggerFor } from "../../utils";
import { extractRelations } from "./relation";

import { HttpStatusError } from "../../fetcher/ldfetchDereferencer";
import type { Dereferencer, DereferenceOptions } from "../../fetcher/ldfetchDereferencer";
import type { Condition } from "../../condition";
import type { FetchedPage, Notifier } from "../../types";
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

export async function statelessPageFetch(
    location: string,
    dereferencer: Dereferencer,
    fetch_f?: typeof fetch,
    headers?: Record<string, string>,
): Promise<FetchedPage> {
    let etag: string | undefined;
    const fetchWithMetadata: typeof fetch = async (input, init) => {
        const resp = await (fetch_f ?? fetch)(input, init);
        etag = resp.headers.get("etag") ?? undefined;
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
        status: resp.status,
    };
}

export type FetchEvent = {
    relationsFound: { from: Node; target: FoundRelation }[];
    pageFetched: FetchedPage;
    scheduleFetch: Node;
    error: unknown;
};

/**
 * What to do with a page of an LDES 1.0 that is not found (HTTP 404). The pages that the client was given or found as the root
 * (`entries`) are always an error: there is nothing to replicate without them.
 */
export type MissingPages = { skip: boolean; entries: string[] };

export type Cache = {
    immutable?: boolean;
    maxAge?: number;
    etag?: string;
};

export class Fetcher {
    private dereferencer: Dereferencer;
    private loose: boolean;
    private fetch_f?: typeof fetch;
    private condition: Condition;
    private defaultTimezone: string;

    private closed = false;
    /** Pages that are not found are skipped, except the pages in `entries`: see {@link MissingPages} */
    private missingPages: MissingPages;

    private logger = getLoggerFor(this);

    constructor(
        dereferencer: Dereferencer,
        loose: boolean,
        condition: Condition,
        defaultTimezone: string,
        fetch_f?: typeof fetch,
        missingPages: MissingPages = { skip: false, entries: [] },
    ) {
        this.dereferencer = dereferencer;
        this.loose = loose;
        this.fetch_f = fetch_f;
        this.condition = condition;
        this.defaultTimezone = defaultTimezone;
        this.missingPages = missingPages;
    }

    close() {
        this.closed = true;
    }

    async fetch<S>(node: Node, state: S, notifier: Notifier<FetchEvent, S>) {
        // A client that is closed does not start requests for the pages that were queued
        if (this.closed) return;
        try {
            const options: DereferenceOptions = {
                localFiles: true,
                fetch: this.fetch_f,
            };
            if (node.etag) {
                options.headers = {
                    ...options.headers,
                    "If-None-Match": node.etag,
                };
            }
            const resp = await this.dereferencer.dereference(node.target, options);

            node.target = resp.url;

            const cache = {} as Cache;
            if (resp.headers) {
                const cacheControlCandidate = resp.headers.get("cache-control");
                cache.etag = resp.headers.get("etag") ?? undefined;
                if (cacheControlCandidate) {
                    const controls = cacheControlCandidate.split(",").map((x) => x.split("=", 2).map((x) => x.trim()));

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

            this.logger.debug(`[fetch] Cache for ${node.target} ${JSON.stringify(cache)}`);

            const data = RdfStore.createDefault();
            await new Promise((resolve, reject) => {
                resp.data
                    .on("data", (quad) => {
                        data.addQuad(quad);
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
                    status: resp.status,
                },
                state,
                notifier,
                cache,
            );
        } catch (ex) {
            if (this.isMissing(ex, node)) {
                // A page that was found through a relation, and is not there (any more): a retention policy removes pages.
                // It is an empty page that is not requested again, and not an error that every next run, which has the page in its state, fails on.
                this.logger.warn(
                    `[fetch] Page ${node.target} was not found (HTTP 404) and is skipped: it has no members and no relations for this client`,
                );
                await this.processFetchedPage(
                    node,
                    { data: RdfStore.createDefault(), url: node.target, immutable: true, memberCount: 0, status: 404 },
                    state,
                    notifier,
                    { immutable: true },
                );
                return;
            }
            this.logger.error(`[fetch] Fetch failed for ${node.target} ${errorMessage(ex)}`);
            notifier.error(ex, state);
        }
    }

    private isMissing(ex: unknown, node: Node): boolean {
        return (
            this.missingPages.skip &&
            ex instanceof HttpStatusError &&
            ex.status === 404 &&
            !this.closed &&
            !this.missingPages.entries.includes(node.target)
        );
    }

    async processFetchedPage<S>(node: Node, page: FetchedPage, state: S, notifier: Notifier<FetchEvent, S>, cache: Cache = {}) {
        cache.immutable ||= page.immutable || isRdfImmutable(page.data, namedNode(page.url));

        this.logger.debug(`[fetch] Got data ${page.url}`);
        const toFetch: { from: Node; target: FoundRelation }[] =
            page.status === 304
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
        for (const rel of extractRelations(page.data, namedNode(page.url), this.loose, this.condition, this.defaultTimezone)) {
            if (!node.expected.has(rel.node) && rel.allowed) {
                toFetch.push({ from: node, target: rel });
            }
        }

        if (!cache.immutable && !this.closed) {
            // Before the members are extracted: the state of the page is written, and what is written when the consumer has read them comes after
            await notifier.scheduleFetch(
                {
                    ...node,
                    target: page.url,
                    etag: cache.etag ?? page.etag ?? node.etag,
                    relations: toFetch.map(({ target }) => target.node),
                },
                state,
            );
        }

        if (!this.closed) {
            if (toFetch.length > 0) {
                await notifier.relationsFound(toFetch, state);
            }
            notifier.pageFetched(
                {
                    data: page.data,
                    url: page.url,
                    immutable: !!cache.immutable,
                    memberCount: 0,
                    etag: cache.etag ?? page.etag,
                    status: page.status,
                    created: page.created,
                    updated: page.updated,
                },
                state,
            );
        }
    }
}

function isRdfImmutable(data: RdfStore, page: ReturnType<typeof namedNode>): boolean {
    return data
        .getQuads(page, LDES.terms.custom("immutable"), null, null)
        .some((quad) => quad.object.termType === "Literal" && quad.object.value === "true");
}
