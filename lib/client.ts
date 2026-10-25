import { RdfDereferencer, rdfDereferencer } from "rdf-dereference";
import { LDES, RDF, TREE } from "@treecg/types";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { intoConfig } from "./config";
import { handleConditions } from "./condition";
import { OrderedStrategy, UnorderedStrategy } from "./strategy";
import {
    ModulatorFactory,
    Fetcher,
    longPromise,
    resetPromise,
    Manager,
    statelessPageFetch
} from "./fetcher";
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
} from "./utils";

import type { Term } from "@rdfjs/types";
import type { Config } from "./config";
import { ClientStateManager } from "./state";
import type { Ordered, StrategyEvents } from "./strategy";
import type { LDESInfo, Notifier, FetchedPage, Member } from "./fetcher";

type CachedRoot = {
    url: string;
    quads: string;
    immutable: boolean;
    etag?: string;
};

// RDF-JS data factory
const df = new DataFactory();

// Local types
type Controller = ReadableStreamDefaultController<Member>;
type EventMap = Record<string, unknown>;
type EventKey<T extends EventMap> = string & keyof T;
type EventReceiver<T> = (params: T) => void;

// Re-export util functions
export { enhanced_fetch } from "./fetcher";
export { intoConfig } from "./config";
export * from "./condition";
export type { Ordered } from "./strategy";

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
    dereferencer?: RdfDereferencer,
    streamId?: Term,
): Client {
    return new Client(intoConfig(config), ordered, dereferencer, streamId);
}

export class Client {
    public memberCount: number;
    public fragmentCount: number;
    public streamId?: Term;

    private config: Config;
    private dereferencer: RdfDereferencer;
    private fetcher!: Fetcher;
    private memberManager!: Manager;
    private strategy!: OrderedStrategy | UnorderedStrategy;
    private ordered: Ordered;
    private closed = false;
    private modulatorFactory: ModulatorFactory;
    private clientStateManager: ClientStateManager;

    private listeners: {
        [K in keyof ClientEvents]?: Array<(p: ClientEvents[K]) => void>;
    } = {};

    private logger = getLoggerFor(this);

    constructor(
        config: Config,
        ordered: Ordered = "none",
        dereferencer?: RdfDereferencer,
        stream?: Term,
    ) {
        this.memberCount = 0;
        this.fragmentCount = 0;
        this.config = config;
        this.dereferencer = dereferencer ?? rdfDereferencer;
        this.streamId = stream;
        this.ordered = ordered;
        this.clientStateManager = new ClientStateManager(
            this.config.statePath,
            this.config.startFresh
        );
        this.modulatorFactory = new ModulatorFactory(
            this.clientStateManager,
            this.config.statePath !== undefined,
            this.config.concurrentFetches,
            this.config.lastVersionOnly,
        );
        if (typeof process !== "undefined") {
            // Handle exit gracefully
            handleExit(() => {
                this.logger.warn("Process was externally terminated, closing client...");
                this.logger.info("Managed to emit " + this.memberCount + " members from " + this.fragmentCount + " fragments before termination");
            });
        }
    }

    on<K extends EventKey<ClientEvents>>(
        key: K,
        fn: EventReceiver<ClientEvents[K]>,
    ) {
        if (!this.listeners[key]) {
            this.listeners[key] = [];
        }
        this.listeners[key].push(fn);
    }

    async init(
        streamOut: (member: Member) => boolean,
        close: () => void,
    ): Promise<void> {
        // Initialize the client state manager
        this.clientStateManager.init();

        const rootState = this.clientStateManager.build<string, CachedRoot>("root");
        let root: FetchedPage | undefined;
        let cached: CachedRoot | undefined;
        if (this.config.statePath) {
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
            const headers = cached?.etag
                ? { "If-None-Match": cached.etag }
                : undefined;
            root = await statelessPageFetch(
                this.config.url,
                this.dereferencer,
                this.config.fetch,
                headers,
            );
            if (root.status === 304 && cached) {
                parseQuads(cached.quads).forEach((quad) => root!.data.addQuad(quad));
            }
            root.immutable = root.data
                .getQuads(
                    df.namedNode(root.url),
                    LDES.terms.custom("immutable"),
                    null,
                    null,
                )
                .some((quad) => quad.object.value === "true" || quad.object.value === "1");
            if (this.config.statePath) {
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
        const ldesId: Term = isLocalDump
            ? df.namedNode("file://" + this.config.url)
            : df.namedNode(this.config.url);

        const allViewQuads = root.data.getQuads(null, TREE.terms.view, null, null);
        const fetchedUrl = df.namedNode(root.url);
        const currentViewQuads = root.data.getQuads(
            null,
            TREE.terms.view,
            fetchedUrl,
            null,
        );
        const suppliedIriViewQuads = root.data.getQuads(
            ldesId,
            TREE.terms.view,
            null,
            null,
        );
        let viewId: Term;
        let ldesUri: Term | undefined;

        if (this.config.urlIsView) {
            viewId = ldesId;
            if (currentViewQuads.length === 1) {
                ldesUri = currentViewQuads[0].subject;
            }
        } else {
            const candidates = currentViewQuads.length > 0
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
                throw new Error(
                    `Ambiguous tree:view discovery: found ${candidates.length} applicable statements`,
                );
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
        ldesUri = ldesUri ||
            root.data.getQuads(null, RDF.terms.type, LDES.terms.EventStream)[0].subject;
        if (!ldesUri) {
            this.logger.error("Could not find the LDES IRI in the fetched RDF data.");
            throw "No LDES IRI found";
        }
        // This is the ID of the stream of data we are replicating.
        // Normally it corresponds to the actual LDES IRI, unless externally specified.
        // This is used mainly for metadata descriptions.
        this.streamId = this.streamId || ldesUri;

        // Extract the main LDES information (e.g., timestampPath, versionOfPath, etc.)
        const info: LDESInfo = await getInfo(
            ldesUri,
            viewId,
            root.data,
            root.url,
            this.dereferencer,
            this.config,
        );
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
        this.fetcher = new Fetcher(
            this.dereferencer,
            this.config.loose,
            condition,
            this.config.defaultTimezone,
            this.config.includeMetadata || false,
            this.config.fetch,
        );

        // Event handler object that listens for various runtime events (e.g., page fetching, member extraction, etc.)
        const notifier: Notifier<StrategyEvents, unknown> = {
            error: (ex: unknown) => this.emit("error", ex),
            fragment: (fragment: FetchedPage) => {
                this.emit("fragment", fragment);
                this.fragmentCount++;
            },
            member: (m) => {
                const streamed = streamOut(
                    // Check if member is to be materialized
                    maybeVersionMaterialize(
                        m,
                        this.config.materialize === true,
                        info,
                    ),
                );
                if (streamed) {
                    this.memberCount++;
                }
                return streamed;
            },
            pollCycle: () => {
                condition.poll();
                this.emit("poll", undefined);
            },
            mutable: () => {
                this.emit("mutable", undefined);
            },
            close: () => {
                close();
            },
        };

        // Opt for descending order strategy if last version only is true, to start reading at the newest end.
        if (this.config.lastVersionOnly) this.ordered = "descending";
        this.logger.debug("Order chosen: " + this.ordered);

        // Fetching strategy definition, i.e., whether to use ordered or unordered fetching;
        // keep on polling the LDES (mutable pages) for new data or finish when fully fetched.
        const pollInterval = info.pollingInterval === undefined
            ? this.config.pollInterval
            : info.pollingInterval * 1000;
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
                : new UnorderedStrategy(
                    this.memberManager,
                    this.fetcher,
                    notifier,
                    this.modulatorFactory,
                    this.config.polling,
                    pollInterval,
                );

        if (!isLocalDump) this.logger.debug(
            `Found ${allViewQuads.length} views, choosing ${viewId.value}`,
        );

        await this.strategy.start(
            viewId.value,
            condition,
            isLocalDump || root.url === viewId.value ? root : undefined,
            !isLocalDump,
        );
    }

    stream(strategy?: {
        highWaterMark?: number;
        size?: (chunk: Member) => number;
    }): ReadableStream<Member> {
        const emitted = longPromise();
        const config: UnderlyingDefaultSource = {
            //
            // Called when starting the stream
            //
            start: async (controller: Controller) => {
                this.on("error", async (error) => {
                    await this.close();
                    controller.error(error);
                });
                this.modulatorFactory.pause();
                await this.init(
                    (member) => {
                        try {
                            controller.enqueue(member);
                            resetPromise(emitted);
                            return true;
                        } catch (_) {
                            return false;
                        }
                    },
                    async () => {
                        if (this.closed) return;
                        controller.close();
                        await this.close();
                    },
                );
            },

            //
            // Called when the internal buffer is not full
            //
            pull: async () => {
                resetPromise(emitted);
                this.modulatorFactory.unpause();
                await emitted.waiting;
                this.modulatorFactory.pause();
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

        return new ReadableStream(config, strategy);
    }

    private emit<K extends EventKey<ClientEvents>>(
        key: K,
        data: ClientEvents[K],
    ) {
        (this.listeners[key] || []).forEach(function (fn) {
            fn(data);
        });
    }

    public async close() {
        if (this.closed) return;
        this.closed = true;
        this.memberManager?.close();
        this.fetcher?.close();
        this.modulatorFactory.close();
        await this.strategy?.cancel();
        await this.clientStateManager.close();
        cleanUpHandlers();
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
    dereferencer: RdfDereferencer,
    config: Config,
): Promise<LDESInfo> {
    const logger = getLoggerFor("getShape");

    if (config.shapeFile && config.shapeFile !== "") {
        // Shape file is given externally, so we need to fetch it
        const shapeId = config.shapeFile.startsWith("http")
            ? config.shapeFile
            : "file://" + config.shapeFile;
        try {
            const resp = await rdfDereferencer.dereference(config.shapeFile, {
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

    const isLocalDump = ldesId.value.startsWith("file://");

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
    } else if (shapeIds.length === 0 || timestampPaths.length === 0 || versionOfPaths.length === 0) {
        let tryAgainUrl = viewId.value;
        if (config.urlIsView) {
            tryAgainUrl = ldesId.value;
        }
        if (tryAgainUrl === fetchedRootUrl) {
            return buildInfo(config, store, dereferencer, shapeIds, timestampPaths, sequencePaths, transactionFinalizedPaths, versionOfPaths, versionTimestampPaths, versionSequencePaths, pollingIntervals, ldesId, viewId, contextShapeIds);
        }
        try {
            logger.debug(`Maybe find more info at ${tryAgainUrl}`);
            const resp = await dereferencer.dereference(tryAgainUrl, {
                localFiles: true,
                fetch: config.fetch,
            });
            await new Promise((resolve, reject) => {
                store.import(resp.data).on("end", resolve).on("error", reject);
            });

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

    return buildInfo(config, store, dereferencer, shapeIds, timestampPaths, sequencePaths, transactionFinalizedPaths, versionOfPaths, versionTimestampPaths, versionSequencePaths, pollingIntervals, ldesId, viewId, contextShapeIds);
}

async function buildInfo(
    config: Config,
    store: RdfStore,
    dereferencer: RdfDereferencer,
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
    const logger = getLoggerFor("getShape");
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
        if (shapeId &&
            shapeId.termType === 'NamedNode' &&
            store.getQuads(shapeId, null, null).length === 0
        ) {
            // Dereference out-of-band shape
            const respShape = await rdfDereferencer.dereference(shapeId.value);
            await new Promise((resolve, reject) => {
                shapeConfigStore.import(respShape.data)
                    .on("end", resolve)
                    .on("error", reject);
            });
        }
    }

    const shapeStore = shapeIds.length > 0 ? store : shapeConfigStore;
    const viewDescriptions = getObjects(store, viewId, TREE.terms.custom("viewDescription"));
    const retentionPolicies = [
        ...getObjects(store, viewId, LDES.terms.retentionPolicy),
        ...viewDescriptions.flatMap((description) =>
            getObjects(store, description, LDES.terms.retentionPolicy)
        ),
    ].filter((policy, index, policies) =>
        policies.findIndex((candidate) => candidate.equals(policy)) === index
    );
    const emptyRetentionPolicies = retentionPolicies.filter((policy) =>
        store.getQuads(policy, null, null, null).length === 0
    );
    const pollingInterval = Number(pollingIntervals[0]?.value);

    return {
        extractor: new CBDShapeExtractor(shapeStore, dereferencer, {
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
