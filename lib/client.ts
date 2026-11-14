import { LDES, RDF, TREE } from "@treecg/types";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { intoConfig } from "./config";
import { DEFAULT_TRANSFER_RETRY, LdfetchDereferencer, ldfetchDereferencer } from "./fetcher/ldfetchDereferencer";
import { Gate, cachedLog, detectVersion, isEventStreamDescription, startLdes2, toStore } from "./ldes2";
import { handleConditions } from "./condition";
import { OrderedStrategy, UnorderedStrategy, ModulatorFactory, Fetcher, Manager } from "./ldes1";
import {
    extractMainNodeShape,
    getObjects,
    maybeVersionMaterialize,
    shaclPathKey,
    shaclPathTerms,
    parseQuads,
    serializeQuads,
    streamToArray,
    getLoggerFor,
    handleExit,
    cleanUpHandlers,
    longPromise,
    resetPromise,
} from "./utils";

import type { Quad, Term } from "@rdfjs/types";
import type { Config } from "./config";
import { ClientStateManager } from "./state";
import { MemoryStorage } from "./storage/memory";
import type { MessageDereferencer } from "./fetcher/ldfetchDereferencer";
import type { SavedBookmark } from "./ldes2";
import type { LDESInfo, Notifier, FetchedPage, Member, MemberDelivery, Ordered, StrategyEvents } from "./types";

type CachedRoot = {
    url: string;
    quads: string;
    immutable: boolean;
    etag?: string;
};

// RDF-JS data factory
const df = new DataFactory();

// Local types
/** A member in the buffer of the stream, with what is to be done when the consumer has read it */
type Buffered = { member: Member; delivered?: MemberDelivery["delivered"] };
type Controller = ReadableStreamDefaultController<Buffered>;
type StreamOut = (member: Member, delivered?: MemberDelivery["delivered"]) => boolean;
type EventMap = Record<string, unknown>;
type EventKey<T extends EventMap> = string & keyof T;
type EventReceiver<T> = (params: T) => void;

// Re-export util functions
export { enhanced_fetch } from "./fetcher";
export { intoConfig } from "./config";
export * from "./condition";
export type { Ordered } from "./types";

// Re-export storage types and adapters
export type { KVStore, Storage } from "./storage";
export { MemoryStorage } from "./storage/memory";

export type ClientEvents = {
    fragment: FetchedPage;
    description: LDESInfo;
    mutable: void;
    poll: void;
    error: unknown;
};

export function replicateLDES(
    config: Partial<Config> & { url: string },
    ordered: Ordered = "none",
    dereferencer?: MessageDereferencer,
    streamId?: Term,
): Client {
    return new Client(intoConfig(config), ordered, dereferencer, streamId);
}

export class Client {
    public memberCount: number;
    public fragmentCount: number;
    public streamId?: Term;

    private config: Config;
    private dereferencer: MessageDereferencer;
    private fetcher!: Fetcher;
    private memberManager!: Manager;
    private strategy!: OrderedStrategy | UnorderedStrategy;
    private ordered: Ordered;
    private closed = false;
    private modulatorFactory: ModulatorFactory;
    private clientStateManager: ClientStateManager;
    private readonly persistState: boolean;
    private gate = new Gate();
    /** The updates of the state for members that were read by the consumer, and that are not done yet, in the order of the members */
    private waitingCommits: Array<NonNullable<MemberDelivery["delivered"]>> = [];
    private committing?: Promise<void>;
    private deliveryError?: { error: unknown };
    private closing?: Promise<void>;
    /** The members that are emitted to the stream, and that the consumer has not read yet */
    private undelivered = 0;
    private deliveryWaiters: Array<() => void> = [];
    /** Saves the bookmark of an LDES 2.0 */
    private persistLdes2?: () => Promise<void>;

    private listeners: {
        [K in keyof ClientEvents]?: Array<(p: ClientEvents[K]) => void>;
    } = {};

    private logger = getLoggerFor(this);

    constructor(config: Config, ordered: Ordered = "none", dereferencer?: MessageDereferencer, stream?: Term) {
        this.memberCount = 0;
        this.fragmentCount = 0;
        this.config = config;
        this.dereferencer =
            dereferencer ??
            (config.contextCache !== undefined || config.transferRetry
                ? new LdfetchDereferencer(undefined, config.contextCache, { ...DEFAULT_TRANSFER_RETRY, ...config.transferRetry })
                : ldfetchDereferencer);
        this.streamId = stream;
        this.ordered = ordered;
        // A client that polls keeps its state in memory when no state is configured: it needs to remember the pages that
        // are immutable and the members that were emitted, or every poll would request every page again.
        const keepInMemory = this.config.polling === true && this.config.statePath === undefined && this.config.storage === undefined;
        this.clientStateManager = new ClientStateManager(
            keepInMemory ? new MemoryStorage() : this.config.storage,
            this.config.statePath,
            this.config.startFresh,
        );
        this.persistState = keepInMemory || this.config.statePath !== undefined || this.config.storage !== undefined;
        this.modulatorFactory = new ModulatorFactory(
            this.clientStateManager,
            this.persistState,
            this.config.concurrentFetches,
            this.config.lastVersionOnly,
        );
        // handleExit internally checks for process signal support,
        // so it's safe to call unconditionally (no-op on CF Workers)
        handleExit(() => {
            this.logger.warn("Process was externally terminated, closing client...");
            this.logger.info("Managed to emit " + this.memberCount + " members from " + this.fragmentCount + " fragments before termination");
        });
    }

    on<K extends EventKey<ClientEvents>>(key: K, fn: EventReceiver<ClientEvents[K]>) {
        if (!this.listeners[key]) {
            this.listeners[key] = [];
        }
        this.listeners[key].push(fn);
    }

    async init(streamOut: StreamOut, close: () => void): Promise<void> {
        // Initialize the client state manager
        await this.clientStateManager.init();

        const rootState = this.clientStateManager.build<string, CachedRoot>("root");
        let root: FetchedPage | undefined;
        let cached: CachedRoot | undefined;
        if (this.persistState) {
            cached = await rootState.get(this.config.url).catch(() => undefined);
            if (cached?.immutable) {
                const data = RdfStore.createDefault();
                parseQuads(cached.quads).forEach((quad) => data.addQuad(quad));
                root = {
                    url: cached.url,
                    data,
                    immutable: true,
                    memberCount: 0,
                };
                this.logger.debug(`Reusing persisted immutable root ${cached.url}`);
            }
        }
        if (!root) {
            // The root of an LDES 2.0 is requested with the ETag that it had when the last run read it completely: the bookmark has its description
            const cachedLdes2 = this.persistState
                ? (
                      await this.clientStateManager
                          .build<string, SavedBookmark>("ldes2")
                          .get(this.config.url)
                          .catch(() => undefined)
                  )?.pages?.[this.config.url]
                : undefined;
            const etag = cached?.etag ?? cachedLdes2?.etag;
            const headers = etag ? { "If-None-Match": etag } : undefined;
            const answer = await this.dereferencer.dereferenceMessages(this.config.url, { fetch: this.config.fetch, headers, localFiles: true });
            const log = answer.status === 304 && cachedLdes2 && !cached ? cachedLog(answer.url, answer, cachedLdes2) : answer;
            const first = await log.next();

            // Is this an LDES 1.0 or an LDES 2.0? The first message tells.
            const version = detectVersion(log, first) ?? (first && isEventStreamDescription(first) ? 2 : 1);
            if (version === 2) {
                this.logger.debug(`Found an LDES 2.0 at ${log.url}`);
                this.logger.warn(
                    "LDES 2.0 support is experimental: it follows the evolving proposals for the LDES 2.0 " +
                        "specification, and can change in any release of this client",
                );
                await this.initLdes2(log, first, streamOut, close);
                return;
            }

            // An LDES 1.0 page is a document without messages: the first message is the entire page
            log.close();
            const data = toStore(first ?? []);
            root = {
                url: log.url,
                data,
                immutable: false,
                memberCount: 0,
                etag: log.headers.get("etag") ?? undefined,
                status: log.status,
            };
            if (root.status === 304 && cached) {
                parseQuads(cached.quads).forEach((quad) => root!.data.addQuad(quad));
            }
            root.immutable = root.data
                .getQuads(df.namedNode(root.url), LDES.terms.custom("immutable"), null, null)
                .some((quad) => quad.object.value === "true" || quad.object.value === "1");
            if (this.persistState) {
                await rootState.put(this.config.url, {
                    url: root.url,
                    quads: serializeQuads(root.data.getQuads()),
                    immutable: root.immutable,
                    etag: root.etag ?? cached?.etag,
                });
            }
        }
        this.fragmentCount++;
        this.emit("fragment", root);

        // Determine if the URL was a local dump
        const isLocalDump = !this.config.url.startsWith("http");

        // Set the LDES ID accordingly
        const ldesId: Term = isLocalDump ? df.namedNode("file://" + this.config.url) : df.namedNode(this.config.url);

        const allViewQuads = root.data.getQuads(null, TREE.terms.view, null, null);
        const fetchedUrl = df.namedNode(root.url);
        const currentViewQuads = root.data.getQuads(null, TREE.terms.view, fetchedUrl, null);
        const suppliedIriViewQuads = root.data.getQuads(ldesId, TREE.terms.view, null, null);
        let viewId: Term;
        let ldesUri: Term | undefined;
        // Whether the page that was fetched is the view itself, and the LDES is described elsewhere
        let urlIsView = this.config.urlIsView;

        // A page without a tree:view that is dct:isPartOf an LDES: how an OpenLDES server describes the root of a view
        const partOfLdes = root.data.getQuads(fetchedUrl, df.namedNode("http://purl.org/dc/terms/isPartOf"), null, null).map((quad) => quad.object);
        const viewIsPartOfLdes =
            !this.config.urlIsView &&
            !isLocalDump &&
            currentViewQuads.length === 0 &&
            suppliedIriViewQuads.length === 0 &&
            partOfLdes.length === 1 &&
            root.data.getQuads(partOfLdes[0], RDF.terms.type, LDES.terms.EventStream, null).length > 0;

        if (viewIsPartOfLdes) {
            this.logger.debug(`Page ${root.url} is part of the LDES ${partOfLdes[0].value}, and has no tree:view: it is the view`);
            urlIsView = true;
            viewId = fetchedUrl;
            ldesUri = partOfLdes[0];
        } else if (this.config.urlIsView) {
            viewId = ldesId;
            if (currentViewQuads.length === 1) {
                ldesUri = currentViewQuads[0].subject;
            }
        } else {
            const candidates =
                currentViewQuads.length > 0
                    ? currentViewQuads
                    : suppliedIriViewQuads.length > 0
                      ? suppliedIriViewQuads
                      : isLocalDump
                        ? allViewQuads
                        : [];
            if (candidates.length === 0) {
                this.logger.error(
                    "Did not find exactly one applicable tree:view predicate, which is required to interpret the LDES. " +
                        "If you are targeting a tree:view directly, use the '--url-is-view' option.",
                );
                throw new Error("No applicable tree:view found");
            }
            if (candidates.length > 1 && !this.config.allowUnsafeAmbiguousView) {
                throw new Error(`Ambiguous tree:view discovery: found ${candidates.length} applicable statements`);
            }
            if (candidates.length > 1) {
                this.logger.warn(
                    `Found ${candidates.length} applicable tree:view statements; ` +
                        "the command-line client is taking the first one. This fallback is not specification compliant.",
                );
            }
            const selected = candidates[0];
            viewId = selected.object;
            ldesUri = selected.subject;
        }

        // This is the actual LDES IRI found in the RDF data.
        // Might be different from the configured ldesId due to HTTP redirects
        ldesUri = ldesUri || root.data.getQuads(null, RDF.terms.type, LDES.terms.EventStream)[0].subject;
        if (!ldesUri) {
            this.logger.error("Could not find the LDES IRI in the fetched RDF data.");
            throw "No LDES IRI found";
        }
        // This is the ID of the stream of data we are replicating.
        // Normally it corresponds to the actual LDES IRI, unless externally specified.
        // This is used mainly for metadata descriptions.
        this.streamId = this.streamId || ldesUri;

        // Extract the main LDES information (e.g., timestampPath, versionOfPath, etc.)
        // The view is read to find what the page of the LDES does not tell: the strategy starts at this page, and does not request it again
        let viewPage: FetchedPage | undefined;
        const info: LDESInfo = await getInfo(ldesUri, viewId, root.data, root.url, this.dereferencer, this.config, isLocalDump, urlIsView, (page) => {
            viewPage = page;
        });
        this.emit("description", info);

        // Handle and assemble condition object that dictates fragment fetching and member emission
        const condition = handleConditions(
            this.config.condition,
            this.config.defaultTimezone,
            this.config.before,
            this.config.after,
            info.timestampPath,
        );

        // Component that manages the extraction of all members from every fetched page
        this.memberManager = new Manager(
            isLocalDump
                ? null // Local dump does not need to dereference a view
                : ldesUri, // Point to the actual LDES IRI
            info,
            this.config.loose,
            condition,
        );

        this.logger.debug(`timestampPath: ${!!info.timestampPath}`);
        this.logger.debug(`sequencePath: ${!!info.sequencePath}`);

        if (this.ordered !== "none" && !info.timestampPath && !info.sequencePath) {
            throw "Can only emit members in order, if LDES is configured with timestampPath or sequencePath";
        }

        // Component that manages the fetching of RDF data over HTTP
        this.fetcher = new Fetcher(this.dereferencer, this.config.loose, condition, this.config.defaultTimezone, this.config.fetch, {
            skip: this.config.skipMissingPages === true,
            entries: [this.config.url, root.url, viewId.value, ldesUri.value],
        });

        const notifier = this.buildNotifier(info, streamOut, close, condition);

        // Opt for descending order strategy if last version only is true, to start reading at the newest end.
        if (this.config.lastVersionOnly) this.ordered = "descending";
        this.logger.debug("Order chosen: " + this.ordered);

        // Fetching strategy definition, i.e., whether to use ordered or unordered fetching;
        // keep on polling the LDES (mutable pages) for new data or finish when fully fetched.
        const pollInterval = info.pollingInterval === undefined ? this.config.pollInterval : info.pollingInterval * 1000;
        this.strategy =
            this.ordered !== "none"
                ? new OrderedStrategy(
                      this.memberManager,
                      this.fetcher,
                      notifier,
                      this.modulatorFactory,
                      info,
                      this.ordered,
                      this.config.polling,
                      pollInterval,
                  )
                : new UnorderedStrategy(this.memberManager, this.fetcher, notifier, this.modulatorFactory, this.config.polling, pollInterval);

        if (!isLocalDump) this.logger.debug(`Found ${allViewQuads.length} views, choosing ${viewId.value}`);

        const startPage =
            isLocalDump || root.url === viewId.value ? root : (viewPage as FetchedPage | undefined)?.url === viewId.value ? viewPage : undefined;
        await this.strategy.start(viewId.value, condition, startPage, !isLocalDump);
    }

    /**
     * Event handler object that listens for various runtime events (e.g., page fetching, member extraction, etc.)
     */
    private buildNotifier(
        info: LDESInfo,
        streamOut: StreamOut,
        close: () => void,
        condition?: ReturnType<typeof handleConditions>,
    ): Notifier<StrategyEvents, unknown> {
        return {
            error: (ex: unknown) => this.emit("error", ex),
            fragment: (fragment: FetchedPage) => {
                this.emit("fragment", fragment);
                this.fragmentCount++;
            },
            member: (m, state) => {
                const streamed = streamOut(
                    // Check if member is to be materialized
                    maybeVersionMaterialize(m, this.config.materialize === true, info),
                    (state as MemberDelivery | undefined)?.delivered,
                );
                if (streamed) {
                    this.memberCount++;
                }
                return streamed;
            },
            pollCycle: () => {
                condition?.poll();
                this.emit("poll", undefined);
            },
            mutable: () => {
                this.emit("mutable", undefined);
            },
            close: () => {
                close();
            },
        };
    }

    /**
     * Replicates an LDES 2.0, of which the root page has been opened already.
     */
    private async initLdes2(
        log: Awaited<ReturnType<MessageDereferencer["dereferenceMessages"]>>,
        first: Quad[] | undefined,
        streamOut: StreamOut,
        close: () => void,
    ): Promise<void> {
        const bookmarks = this.persistState ? this.clientStateManager.build<string, SavedBookmark>("ldes2") : undefined;
        // The notifier needs the description of the LDES, which is only known when the root page was read.
        // The members are only emitted after that, so it is safe to complete this reference afterwards.
        let notifier!: Notifier<StrategyEvents, unknown>;
        const { persist } = await startLdes2({
            config: this.config,
            dereferencer: this.dereferencer,
            bookmarks,
            root: { log, first },
            hooks: {
                member: (m, delivered) => notifier.member(m, { delivered }) as boolean,
                fragment: (page) => {
                    this.fragmentCount++;
                    this.emit("fragment", page);
                },
                pollCycle: () => notifier.pollCycle({}, undefined),
                mutable: () => notifier.mutable({}, undefined),
                error: (ex) => notifier.error(ex, undefined),
                close: () => notifier.close({}, undefined),
                gate: this.gate,
                isClosed: () => this.closed,
                delivered: () => this.untilDelivered(),
            },
            onDescription: (info) => {
                this.streamId = this.streamId ?? info.rootNode;
                // The notifier tells the conditions that the client polls
                notifier = this.buildNotifier(info, streamOut, close, this.config.condition);
                this.emit("description", info);
            },
        });
        this.persistLdes2 = persist;
    }

    /**
     * The members of the LDES. A member is emitted when the consumer has read it, and not when it is put in the buffer of the
     * stream: the state is updated then (see `MemberDelivery`). A consumer that stops can leave members in the buffer,
     * and the next run, which starts from the state, emits them.
     * The buffer (`highWaterMark`) is behind the stream that the consumer reads: it reads from it when the consumer asks for a member.
     */
    stream(strategy?: { highWaterMark?: number; size?: (chunk: Member) => number }): ReadableStream<Member> {
        const reader = this.bufferedStream(
            strategy && { ...strategy, size: strategy.size && ((chunk: Buffered) => strategy.size!(chunk.member)) },
        ).getReader();
        return new ReadableStream<Member>(
            {
                pull: async (controller) => {
                    const { done, value } = await reader.read();
                    if (done) return controller.close();
                    try {
                        controller.enqueue(value.member);
                    } catch (_) {
                        // The consumer is gone: the member was not read, and the state does not say it was
                        return;
                    }
                    this.commit(value.delivered);
                },
                cancel: (reason) => reader.cancel(reason),
            },
            { highWaterMark: 0 },
        );
    }

    /**
     * Updates the state for a member that the consumer has read. The updates that wait are done together, and in the order of the
     * members (they start in that order): the consumer is not held up by them, and a state that is stored on a disk is not
     * written to one member at a time.
     */
    private commit(delivered: MemberDelivery["delivered"]) {
        if (!delivered) return;
        this.waitingCommits.push(delivered);
        this.committing ??= this.drainCommits();
    }

    private async drainCommits() {
        const failed = (ex: unknown) => {
            if (this.deliveryError) return;
            this.deliveryError = { error: ex };
            this.logger.error(`Could not update the state of a member: ${ex}`);
            // These writes started before storage closes, including when close() is flushing them. A failure
            // must fail the stream and close(), rather than report that progress was saved successfully.
            this.emit("error", ex);
        };
        // Not before the caller has stored the promise of this drain: it is cleared when the drain ends
        await Promise.resolve();
        try {
            while (this.waitingCommits.length > 0) {
                const batch = this.waitingCommits.splice(0);
                // They start in the order of the members. Most of them do not wait for anything, and do not need a promise.
                const pending: Promise<unknown>[] = [];
                for (const delivered of batch) {
                    try {
                        const done = delivered();
                        if (done) pending.push(Promise.resolve(done).catch(failed));
                    } catch (ex) {
                        failed(ex);
                    }
                }
                if (pending.length > 0) await Promise.all(pending);
                this.undelivered -= batch.length;
                this.releaseDeliveryWaiters();
            }
        } finally {
            this.committing = undefined;
        }
    }

    private releaseDeliveryWaiters() {
        if (this.undelivered > 0 && !this.closed) return;
        const waiters = this.deliveryWaiters;
        this.deliveryWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    /** Resolves when every member that was emitted to the stream was read by the consumer, or when the client is closed */
    untilDelivered(): Promise<void> {
        if (this.undelivered <= 0 || this.closed) return Promise.resolve();
        return new Promise((resolve) => this.deliveryWaiters.push(resolve));
    }

    private bufferedStream(strategy?: { highWaterMark?: number; size?: (chunk: Buffered) => number }): ReadableStream<Buffered> {
        const emitted = longPromise();
        const config: UnderlyingDefaultSource<Buffered> = {
            //
            // Called when starting the stream
            //
            start: async (controller: Controller) => {
                this.on("error", (error) => {
                    // A failure to close must not hide the error that the stream has to report
                    void this.close()
                        .catch((ex) => this.logger.error(`Could not close the client: ${ex}`))
                        .then(() => controller.error(error));
                });
                this.modulatorFactory.pause();
                this.gate.pause();
                try {
                    await this.init(
                        (member, delivered) => {
                            try {
                                controller.enqueue({ member, delivered });
                                if (delivered) this.undelivered++;
                                resetPromise(emitted);
                                return true;
                            } catch (_) {
                                return false;
                            }
                        },
                        () => {
                            if (this.closed) return;
                            // The members that are in the buffer are read first: the state is updated when they are.
                            // The end of the stream is the end of the client: the consumer that sees it can open the same state.
                            void this.untilDelivered()
                                .then(() => this.close())
                                .then(() => {
                                    try {
                                        controller.close();
                                    } catch (_) {
                                        // The consumer is gone
                                    }
                                })
                                .catch((ex) => {
                                    this.logger.error(`Could not close the client: ${ex}`);
                                    controller.error(ex);
                                });
                        },
                    );
                } catch (error) {
                    // A client that could not start must not keep its state open: the next client of that state could not open it
                    await this.close().catch((ex) => this.logger.error(`Could not close the client: ${ex}`));
                    throw error;
                }
            },

            //
            // Called when the internal buffer is not full
            //
            pull: async () => {
                resetPromise(emitted);
                this.modulatorFactory.unpause();
                this.gate.unpause();
                await emitted.waiting;
                this.modulatorFactory.pause();
                this.gate.pause();
                return;
            },

            //
            // Called when canceled
            //
            cancel: async () => {
                this.logger.info("Stream has been canceled");
                await this.close();
            },
        };

        return new ReadableStream<Buffered>(config, strategy);
    }

    private emit<K extends EventKey<ClientEvents>>(key: K, data: ClientEvents[K]) {
        (this.listeners[key] || []).forEach(function (fn) {
            fn(data);
        });
    }

    public close(): Promise<void> {
        // Error handling, normal completion and cancellation can close the client together. All callers
        // must wait for the same cleanup, including a delivery write that fails while it is being flushed.
        return (this.closing ??= this.closeClient());
    }

    private async closeClient() {
        this.closed = true;
        this.releaseDeliveryWaiters();
        // The members that were read by the consumer are in the state before it is closed
        await this.committing;
        await this.persistLdes2?.();
        this.gate.unpause();
        this.memberManager?.close();
        this.fetcher?.close();
        this.modulatorFactory.close();
        await this.strategy?.cancel();
        await this.clientStateManager.close();
        cleanUpHandlers();
        if (this.deliveryError) throw this.deliveryError.error;
        this.logger.info("Client has been gracefully closed");
    }
}

/**
 * Fetches and determines the main LDES information, such as the shape, timestampPath, versionOfPath, etc.
 */
async function getInfo(
    ldesId: Term,
    viewId: Term,
    store: RdfStore,
    fetchedRootUrl: string,
    dereferencer: MessageDereferencer,
    config: Config,
    isLocalDump: boolean,
    urlIsView: boolean,
    onViewPage?: (page: FetchedPage) => void,
): Promise<LDESInfo> {
    const logger = getLoggerFor("getShape");

    if (config.shapeFile && config.shapeFile !== "") {
        // Shape file is given externally, so we need to fetch it
        const shapeId = config.shapeFile.startsWith("http") ? config.shapeFile : "file://" + config.shapeFile;
        try {
            const resp = await dereferencer.dereference(config.shapeFile, {
                localFiles: true,
                fetch: config.fetch,
            });
            const quads = await streamToArray(resp.data);
            config.shape = {
                quads: quads,
                shapeId: df.namedNode(shapeId),
            };
            quads.forEach((quad) => store.addQuad(quad));
        } catch (ex) {
            logger.error(`Failed to fetch shape from ${shapeId}`);
            throw ex;
        }
    }

    let shapeIds;
    let contextShapeIds;
    let timestampPaths;
    let sequencePaths;
    let transactionFinalizedPaths;
    let versionOfPaths;
    let versionTimestampPaths;
    let versionSequencePaths;
    let pollingIntervals;

    // Whether this is a local dump is known from the URL that the client was given: `ldesId` is the IRI of the LDES
    // in the data, which is a web IRI even when that data is read from a local file
    if (isLocalDump) {
        // We are dealing with a local dump LDES
        contextShapeIds = getObjects(store, null, TREE.terms.shape);
        shapeIds = config.noShape ? [] : contextShapeIds;
        timestampPaths = getObjects(store, null, LDES.terms.timestampPath);
        sequencePaths = getObjects(store, null, LDES.terms.custom("sequencePath"));
        transactionFinalizedPaths = getObjects(store, null, LDES.terms.custom("transactionFinalizedPath"));
        versionOfPaths = getObjects(store, null, LDES.terms.versionOfPath);
        versionTimestampPaths = getObjects(store, null, LDES.terms.custom("versionTimestampPath"));
        versionSequencePaths = getObjects(store, null, LDES.terms.custom("versionSequencePath"));
        pollingIntervals = getObjects(store, null, LDES.terms.custom("pollingInterval"));
    } else {
        // This is a normal LDES on the Web
        contextShapeIds = getObjects(store, ldesId, TREE.terms.shape);
        shapeIds = config.noShape ? [] : contextShapeIds;
        timestampPaths = getObjects(store, ldesId, LDES.terms.timestampPath);
        sequencePaths = getObjects(store, ldesId, LDES.terms.custom("sequencePath"));
        transactionFinalizedPaths = getObjects(store, ldesId, LDES.terms.custom("transactionFinalizedPath"));
        versionOfPaths = getObjects(store, ldesId, LDES.terms.versionOfPath);
        versionTimestampPaths = getObjects(store, ldesId, LDES.terms.custom("versionTimestampPath"));
        versionSequencePaths = getObjects(store, ldesId, LDES.terms.custom("versionSequencePath"));
        pollingIntervals = getObjects(store, ldesId, LDES.terms.custom("pollingInterval"));
    }

    logger.debug(
        `Found ${shapeIds.length} shapes, ${timestampPaths.length} timestampPaths, ${sequencePaths.length} sequencePaths, ${versionOfPaths.length} versionOfPaths`,
    );

    // Only try to dereference the view if we are not dealing with a local dump
    if (isLocalDump) {
        logger.debug("Ignoring view since this is a local dump");
    } else if (shapeIds.length === 0 || timestampPaths.length === 0 || versionOfPaths.length === 0 || sequencePaths.length === 0) {
        let tryAgainUrl = viewId.value;
        if (urlIsView) {
            tryAgainUrl = ldesId.value;
        }
        if (tryAgainUrl === fetchedRootUrl) {
            return buildInfo(
                config,
                store,
                dereferencer,
                shapeIds,
                timestampPaths,
                sequencePaths,
                transactionFinalizedPaths,
                versionOfPaths,
                versionTimestampPaths,
                versionSequencePaths,
                pollingIntervals,
                ldesId,
                viewId,
                contextShapeIds,
            );
        }
        try {
            logger.debug(`Maybe find more info at ${tryAgainUrl}`);
            const resp = await dereferencer.dereference(tryAgainUrl, {
                localFiles: true,
                fetch: config.fetch,
            });
            const viewStore = RdfStore.createDefault();
            await new Promise((resolve, reject) => {
                viewStore.import(resp.data).on("end", resolve).on("error", reject);
            });
            viewStore.getQuads().forEach((quad) => store.addQuad(quad));
            if (!urlIsView) {
                onViewPage?.({
                    url: resp.url,
                    data: viewStore,
                    immutable: /(^|,)\s*immutable\b/i.test(resp.headers?.get("cache-control") ?? ""),
                    memberCount: 0,
                    etag: resp.headers?.get("etag") ?? undefined,
                    status: resp.status,
                });
            }

            const shapeInView = getObjects(store, null, TREE.terms.shape);
            if (shapeInView) {
                contextShapeIds = shapeInView;
                shapeIds = config.noShape ? [] : shapeInView;
            }

            if (!timestampPaths.length) {
                timestampPaths = getObjects(store, null, LDES.terms.timestampPath);
            }
            if (!sequencePaths.length) {
                sequencePaths = getObjects(store, null, LDES.terms.custom("sequencePath"));
            }
            if (!transactionFinalizedPaths.length) {
                transactionFinalizedPaths = getObjects(store, null, LDES.terms.custom("transactionFinalizedPath"));
            }
            if (!versionOfPaths.length) {
                versionOfPaths = getObjects(store, null, LDES.terms.versionOfPath);
            }
            if (!versionTimestampPaths.length) {
                versionTimestampPaths = getObjects(store, null, LDES.terms.custom("versionTimestampPath"));
            }
            if (!versionSequencePaths.length) {
                versionSequencePaths = getObjects(store, null, LDES.terms.custom("versionSequencePath"));
            }
            if (!pollingIntervals.length) {
                pollingIntervals = getObjects(store, null, LDES.terms.custom("pollingInterval"));
            }
            logger.debug(
                `Found ${shapeIds.length} shapes, ${timestampPaths.length} timestampPaths, ${sequencePaths.length} sequencePaths, ${versionOfPaths.length} isVersionOfPaths`,
            );
        } catch (ex: unknown) {
            logger.error(`Failed to fetch ${tryAgainUrl}`);
            logger.error((<Error>ex).message);
        }
    }

    if (shapeIds.length > 1) {
        logger.error(`Expected at most one shape id, found ${shapeIds.length}`);
    }

    if (timestampPaths.length > 1) {
        logger.error(`Expected at most one timestamp path, found ${timestampPaths.length}`);
    }

    if (sequencePaths.length > 1) {
        logger.error(`Expected at most one sequence path, found ${sequencePaths.length}`);
    }

    if (transactionFinalizedPaths.length > 1) {
        logger.error(`Expected at most one transactionFinalized path, found ${transactionFinalizedPaths.length}`);
    }

    if (versionOfPaths.length > 1) {
        logger.error(`Expected at most one versionOf path, found ${versionOfPaths.length}`);
    }

    if (versionTimestampPaths.length > 1) {
        logger.error(`Expected at most one versionTimestamp path, found ${versionTimestampPaths.length}`);
    }

    if (versionSequencePaths.length > 1) {
        logger.error(`Expected at most one versionSequence path, found ${versionSequencePaths.length}`);
    }

    if (pollingIntervals.length > 1) {
        logger.error(`Expected at most one polling interval, found ${pollingIntervals.length}`);
    }

    return buildInfo(
        config,
        store,
        dereferencer,
        shapeIds,
        timestampPaths,
        sequencePaths,
        transactionFinalizedPaths,
        versionOfPaths,
        versionTimestampPaths,
        versionSequencePaths,
        pollingIntervals,
        ldesId,
        viewId,
        contextShapeIds,
    );
}

async function buildInfo(
    config: Config,
    store: RdfStore,
    dereferencer: MessageDereferencer,
    shapeIds: Term[],
    timestampPaths: Term[],
    sequencePaths: Term[],
    transactionFinalizedPaths: Term[],
    versionOfPaths: Term[],
    versionTimestampPaths: Term[],
    versionSequencePaths: Term[],
    pollingIntervals: Term[],
    ldesId: Term,
    viewId: Term,
    contextShapeIds: Term[],
): Promise<LDESInfo> {
    const shapeConfigStore = RdfStore.createDefault();
    if (config.shape) {
        for (const quad of config.shape.quads) {
            shapeConfigStore.addQuad(quad);
        }
        if (shapeConfigStore.getQuads(config.shape.shapeId).length === 0) {
            // This happened because the given shape IRI does not match any shape in the (remote) shape file
            // We will try to find the main node shape
            config.shape.shapeId = extractMainNodeShape(shapeConfigStore);
        }
    } else {
        const shapeId = shapeIds[0];
        if (shapeId && shapeId.termType === "NamedNode" && store.getQuads(shapeId, null, null).length === 0) {
            // Dereference out-of-band shape
            const respShape = await dereferencer.dereference(shapeId.value, { fetch: config.fetch });
            await new Promise((resolve, reject) => {
                shapeConfigStore.import(respShape.data).on("end", resolve).on("error", reject);
            });
        }
    }

    const shapeStore = shapeIds.length > 0 ? store : shapeConfigStore;
    const viewDescriptions = getObjects(store, viewId, TREE.terms.custom("viewDescription"));
    const retentionPolicies = [
        ...getObjects(store, viewId, LDES.terms.retentionPolicy),
        ...viewDescriptions.flatMap((description) => getObjects(store, description, LDES.terms.retentionPolicy)),
    ].filter((policy, index, policies) => policies.findIndex((candidate) => candidate.equals(policy)) === index);
    const emptyRetentionPolicies = retentionPolicies.filter((policy) => store.getQuads(policy, null, null, null).length === 0);
    const pollingInterval = Number(pollingIntervals[0]?.value);

    return {
        extractor: new CBDShapeExtractor(shapeStore, dereferencer as unknown as ConstructorParameters<typeof CBDShapeExtractor>[1], {
            // Generic LDES member extraction is defined over the default graph
            // (plus the member's own named graph), not unrelated named graphs.
            cbdDefaultGraph: true,
            fetch: config.fetch,
        }),
        shape: config.shape ? config.shape.shapeId : shapeIds[0],
        timestampPath: timestampPaths[0],
        timestampPathKey: shaclPathKey(store, timestampPaths[0]),
        sequencePath: sequencePaths[0],
        sequencePathTerms: shaclPathTerms(store, sequencePaths[0]),
        sequencePathKey: shaclPathKey(store, sequencePaths[0]),
        transactionFinalizedPath: transactionFinalizedPaths[0],
        transactionFinalizedPathTerms: shaclPathTerms(store, transactionFinalizedPaths[0]),
        transactionFinalizedObject:
            getObjects(store, ldesId, LDES.terms.custom("transactionFinalizedObject"))[0] ??
            getObjects(store, null, LDES.terms.custom("transactionFinalizedObject"))[0],
        versionOfPath: versionOfPaths[0],
        versionTimestampPath: versionTimestampPaths[0],
        versionSequencePath: versionSequencePaths[0],
        pollingInterval: Number.isNaN(pollingInterval) ? undefined : pollingInterval,
        rootNode: viewId,
        shapes: contextShapeIds,
        viewDescriptions,
        retentionPolicies,
        emptyRetentionPolicies,
        contextQuads: store.getQuads(),
        shapeQuads: shapeStore.getQuads(),
    };
}
