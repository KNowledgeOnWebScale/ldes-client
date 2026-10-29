/**
 * The LDES 2.0 client: reads the context information of the root page, and then repeats synchronization runs.
 * See https://w3id.org/ldes/specification#synchronization-algorithm
 */
import { getObjects, shaclPathKey } from "../utils/general";
import { getLoggerFor } from "../utils/logUtil";
import { V } from "./vocab";
import { isOffset } from "./key";
import { detectVersion, isEventStreamDescription, toStore } from "./description";
import { membershipRule } from "./membership";
import { synchronize } from "./traversal";

import type { Level } from "level";
import type { Quad, Term } from "@rdfjs/types";
import type { Config } from "../config";
import type { FetchedPage, LDESInfo, Member } from "../fetcher";
import type { MessageDereferencer, MessageLog } from "../fetcher/ldfetchDereferencer";
import type { Gate } from "./gate";
import type { Bookmark, StreamContext, Traversal } from "./traversal";
import type { Description, OrderMode } from "./description";

const logger = getLoggerFor("Ldes2Client");

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
    bookmarks?: Level<string, Bookmark>;
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
    return store.getQuads(resource, null, null, null).flatMap((quad) => [
        quad,
        ...(quad.object.termType === "BlankNode" ? describe(store, quad.object, seen) : []),
    ]);
}

/** Reads the context information from the description message of the root page */
export function readContext(
    first: Quad[] | undefined,
    configuredTimezone?: string,
): { context: StreamContext; info: LDESInfo } {
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
    const mode: OrderMode = timestampPath
        ? sequencePath ? "timestamp-sequence" : "timestamp"
        : sequencePath ? "sequence" : "implicit";

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
        emptyRetentionPolicies: retentionPolicies.filter(
            (policy) => store.getQuads(policy, null, null, null).length === 0,
        ),
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

    let bookmark: Bookmark = { members: [] };
    if (start.bookmarks) {
        bookmark = (await start.bookmarks.get(bookmarkKey).catch(() => undefined)) ?? bookmark;
    }
    const persist = async () => {
        await start.bookmarks?.put(bookmarkKey, bookmark).catch((ex) => {
            logger.error(`Could not save the bookmark: ${ex}`);
        });
    };

    const pollInterval = info.pollingInterval === undefined
        ? config.pollInterval
        : info.pollingInterval * 1000;

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
                open: (url, options) =>
                    dereferencer.dereferenceMessages(url, { fetch: config.fetch, localFiles: true, ...options }),
                emit: async (member) => {
                    await hooks.gate.wait();
                    if (hooks.isClosed()) return false;
                    if (!inWindow(member, config)) return true;
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

/** The `before` and `after` options of the client apply to the timestamp of the member */
function inWindow(member: Member, config: Config): boolean {
    if (!(member.timestamp instanceof Date)) return true;
    if (config.after && member.timestamp < config.after) return false;
    if (config.before && member.timestamp > config.before) return false;
    return true;
}

export { detectVersion };
