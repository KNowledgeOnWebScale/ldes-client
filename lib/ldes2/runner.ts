/**
 * The LDES 2.0 client: reads the context information of the root page, and then repeats synchronization runs.
 * See https://w3id.org/ldes/specification#synchronization-algorithm
 */
import { DataFactory } from "rdf-data-factory";
import { RdfStore } from "rdf-stores";
import { TREE } from "@treecg/types";
import { EmptyCondition, Range } from "../condition";
import { getObjects, shaclPathKey } from "../utils/general";
import { getLoggerFor } from "../utils/logUtil";
import { V } from "./vocab";
import { isOffset } from "./key";
import { detectVersion, isEventStreamDescription, toStore } from "./description";
import { membershipRule } from "./membership";
import { synchronize } from "./traversal";

import type { KVStore } from "../storage";
import type { Quad, Term } from "@rdfjs/types";
import type { Config } from "../config";
import type { Condition } from "../condition";
import type { Key } from "./key";
import type { FetchedPage, LDESInfo, Member } from "../types";
import type { MessageDereferencer, MessageLog } from "../fetcher/ldfetchDereferencer";
import type { Gate } from "./gate";
import type { Bookmark, SavedBookmark, StreamContext, Traversal } from "./traversal";
import { loadBookmark, saveBookmark } from "./traversal";
import type { Description, OrderMode } from "./description";

const logger = getLoggerFor("Ldes2Client");
const df = new DataFactory();

export type Ldes2Hooks = {
    /** Hands a member to the consumer. Returns false when the consumer is gone. */
    member(member: Member): boolean;
    fragment(page: FetchedPage): void;
    pollCycle(): void;
    mutable(): void;
    error(ex: unknown): void;
    close(): void;
    gate: Gate;
    isClosed(): boolean;
};

export type Ldes2Start = {
    config: Config;
    dereferencer: MessageDereferencer;
    bookmarks?: KVStore<string, SavedBookmark>;
    root: { log: MessageLog; first: Quad[] | undefined };
    hooks: Ldes2Hooks;
    /** Called as soon as the context information is read, before any member is emitted */
    onDescription?: (info: LDESInfo) => void;
};

function onlyOne(store: ReturnType<typeof toStore>, stream: Term, predicate: Term, what: string) {
    const objects = getObjects(store, stream, predicate);
    if (objects.length > 1) {
        throw new Error(`Expected at most one ${what} on the ldes:EventStream, found ${objects.length}`);
    }
    return objects[0];
}

/** The quads that describe a resource: its own, and those of the blank nodes it links to, recursively */
function describe(store: ReturnType<typeof toStore>, resource: Term, seen = new Set<string>()): Quad[] {
    if (seen.has(resource.value)) return [];
    seen.add(resource.value);
    return store
        .getQuads(resource, null, null, null)
        .flatMap((quad) => [quad, ...(quad.object.termType === "BlankNode" ? describe(store, quad.object, seen) : [])]);
}

/** Reads the context information from the description message of the root page */
export function readContext(first: Quad[] | undefined, configuredTimezone?: string): { context: StreamContext; info: LDESInfo } {
    if (!first || !isEventStreamDescription(first)) {
        throw new Error(
            "The first message of the root page does not describe an ldes:EventStream: " +
                "a page without a description of the LDES is not a root page",
        );
    }
    const streams = [
        ...new Map(
            first
                .filter((q) => q.predicate.equals(V.type) && q.object.equals(V.EventStream))
                .map((q) => [q.subject.termType + q.subject.value, q.subject]),
        ).values(),
    ];
    if (streams.length !== 1) {
        throw new Error(`Expected exactly one ldes:EventStream in the root page, found ${streams.length}`);
    }
    const stream = streams[0];
    const store = toStore(first);
    const get = (predicate: Term, what: string) => onlyOne(store, stream, predicate, what);

    const timestampPath = get(V.timestampPath, "ldes:timestampPath");
    const sequencePath = get(V.sequencePath, "ldes:sequencePath");
    const mode: OrderMode = timestampPath ? (sequencePath ? "timestamp-sequence" : "timestamp") : sequencePath ? "sequence" : "implicit";

    // The timezone of timestamps without timezone: the configured one, otherwise that of the LDES, otherwise unknown
    const ldesTimezone = get(V.defaultTimezone, "ldes:defaultTimezone")?.value;
    if (ldesTimezone !== undefined && !isOffset(ldesTimezone)) {
        throw new Error(`ldes:defaultTimezone must be Z or an offset between -14:00 and +14:00, found ${ldesTimezone}`);
    }
    const defaultOffset = configuredTimezone && isOffset(configuredTimezone) ? configuredTimezone : ldesTimezone;

    const context: StreamContext = {
        streamId: stream,
        defaultOffset,
        mode,
        rule: membershipRule(store, stream),
        pathStore: store,
        timestampPath,
        sequencePath,
        versionOfPath: get(V.versionOfPath, "ldes:versionOfPath"),
        transactionFinalizedPath: get(V.transactionFinalizedPath, "ldes:transactionFinalizedPath"),
        transactionFinalizedObject: get(V.transactionFinalizedObject, "ldes:transactionFinalizedObject"),
    };
    const pollingInterval = Number(get(V.pollingInterval, "ldes:pollingInterval")?.value);
    const retentionPolicies = getObjects(store, stream, V.retentionPolicy);
    const shapes = getObjects(store, stream, V.shape);

    const info = {
        ldesVersion: 2,
        shape: shapes[0],
        shapes,
        shapeQuads: shapes.flatMap((shape) => describe(store, shape)),
        contextQuads: first,
        rootNode: stream,
        timestampPath,
        timestampPathKey: shaclPathKey(store, timestampPath),
        sequencePath,
        sequencePathKey: shaclPathKey(store, sequencePath),
        transactionFinalizedPath: context.transactionFinalizedPath,
        transactionFinalizedObject: context.transactionFinalizedObject,
        versionOfPath: context.versionOfPath,
        versionTimestampPath: get(V.versionTimestampPath, "ldes:versionTimestampPath"),
        versionSequencePath: get(V.versionSequencePath, "ldes:versionSequencePath"),
        pollingInterval: Number.isNaN(pollingInterval) ? undefined : pollingInterval,
        retentionPolicies,
        emptyRetentionPolicies: retentionPolicies.filter((policy) => store.getQuads(policy, null, null, null).length === 0),
    } as unknown as LDESInfo;
    return { context, info };
}

/**
 * Starts the synchronization. The context information is read before this function resolves,
 * so that problems with the root page are reported to the caller.
 * The synchronization runs themselves continue in the background, until the stream is finished or closed.
 */
export async function startLdes2(start: Ldes2Start): Promise<{ info: LDESInfo }> {
    const { config, dereferencer, hooks } = start;
    const { context, info } = readContext(start.root.first, config.defaultTimezone);
    start.onDescription?.(info);
    const rootUrl = start.root.log.url;
    const bookmarkKey = config.url;

    let bookmark: Bookmark = { members: new Set() };
    if (start.bookmarks) {
        const saved = await start.bookmarks.get(bookmarkKey).catch(() => undefined);
        if (saved) bookmark = loadBookmark(saved);
    }
    const persist = async () => {
        await start.bookmarks?.put(bookmarkKey, saveBookmark(bookmark)).catch((ex) => {
            logger.error(`Could not save the bookmark: ${ex}`);
        });
    };

    // The conditions of the client: the condition file, as the options `before` and `after` are applied to members below
    const condition = config.condition;
    const relevant = relevance(condition, context, config.defaultTimezone);

    const pollInterval = info.pollingInterval === undefined ? config.pollInterval : info.pollingInterval * 1000;

    const run = async () => {
        let root = start.root;
        let first = true;
        while (!hooks.isClosed()) {
            if (!first) {
                // Every later run starts again from the root page
                const log = await dereferencer.dereferenceMessages(rootUrl, {
                    fetch: config.fetch,
                    localFiles: true,
                });
                root = { log, first: await log.next() };
            }
            first = false;

            const traversal: Traversal = {
                context,
                bookmark,
                root,
                // As many pages as the client may request at the same time
                prefetch: config.concurrentFetches,
                open: (url, options) => dereferencer.dereferenceMessages(url, { fetch: config.fetch, localFiles: true, ...options }),
                relevant,
                emit: async (member) => {
                    await hooks.gate.wait();
                    if (hooks.isClosed()) return false;
                    if (!inWindow(member, config)) return true;
                    try {
                        if (!condition.matchMember(member)) {
                            logger.silly(`Member <${member.id.value}> does not match the condition`);
                            return true;
                        }
                    } catch (ex) {
                        // The same as in an LDES 1.0: a member that the condition cannot be evaluated on is reported as an extraction error
                        logger.error(String(ex));
                        hooks.error({ error: ex, type: "extract", memberId: member.id });
                        return true;
                    }
                    condition.memberEmitted(member);
                    return hooks.member(member);
                },
                onPage: (url, description: Description | undefined) => {
                    hooks.fragment({
                        url,
                        data: description?.store ?? toStore([]),
                        immutable: description?.immutable ?? false,
                        memberCount: 0,
                    });
                },
            };
            const emitted = await synchronize(traversal);
            await persist();
            logger.debug(`Synchronization run finished: ${emitted} new members`);

            if (!config.polling) break;
            hooks.mutable();
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            hooks.pollCycle();
        }
        hooks.close();
    };

    run().catch(async (ex) => {
        await persist();
        hooks.error(ex);
    });
    return { info };
}

/**
 * Lets the condition of the client decide which parts of the order can still contain wanted members.
 * The interval of a relation, or the unbounded rest of a page, is a range of the ldes:timestampPath,
 * which is compared with the conditions on that path in the same way as the range of a tree:relation is in an LDES 1.0.
 * Returns undefined when there is nothing to prune on.
 */
export function relevance(condition: Condition, context: StreamContext, defaultTimezone: string): Traversal["relevant"] {
    if (condition instanceof EmptyCondition) return undefined;
    const path = context.timestampPath
        ? { id: context.timestampPath, store: context.pathStore }
        : // Without a timestamp, no range can be given: only conditions that do not depend on a path can prune
          { id: df.blankNode(), store: RdfStore.createDefault() };
    return (lower?: Key, upper?: Key) => {
        const range = Range.empty(defaultTimezone);
        if (context.timestampPath) {
            if (lower?.time !== undefined) range.add(new Date(lower.time), TREE.GreaterThanOrEqualToRelation);
            // The bound is exclusive in the LDES, but being inclusive never prunes what is wanted
            if (upper?.time !== undefined) range.add(new Date(upper.time), TREE.LessThanOrEqualToRelation);
        }
        return condition.matchRelation(range, path);
    };
}

/** The `before` and `after` options of the client apply to the timestamp of the member,
 *  and exclude both bounds, as in an LDES 1.0 */
function inWindow(member: Member, config: Config): boolean {
    if (!(member.timestamp instanceof Date)) return true;
    if (config.after && member.timestamp <= config.after) return false;
    if (config.before && member.timestamp >= config.before) return false;
    return true;
}

export { detectVersion };
