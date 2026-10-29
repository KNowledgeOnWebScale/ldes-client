/**
 * The synchronization algorithm of LDES 2.0: a merge of sorted logs.
 * See https://w3id.org/ldes/specification#traversal
 *
 * Every page is ordered, and the relations tell where the members of other pages can be found in the order.
 * The client therefore needs neither to sort members, nor to remember which pages it has visited:
 * its state is the bookmark, consisting of the key of the last emitted member,
 * and the identifiers of the emitted members that share exactly that key.
 */
import { XSD_NS } from "./vocab";
import { compareKeysCertain, compareLower, isBeforeBookmark, latestEarliest, parseTimestamp } from "./key";
import { evaluatePath, findMemberId } from "./membership";
import { isDescriptionMessage, readDescription } from "./description";
import { memberFromQuads } from "../utils/general";
import { getLoggerFor } from "../utils/logUtil";

import type { RdfStore } from "rdf-stores";
import type { NamedNode, Quad, Term } from "@rdfjs/types";
import type { Key, SequenceValue } from "./key";
import type { Description, OrderMode, Relation } from "./description";
import type { MembershipRule } from "./membership";
import type { Member } from "../fetcher";
import type { MessageLog } from "../fetcher/ldfetchDereferencer";
import { MAX_BUFFERED_MESSAGES } from "../fetcher/ldfetchDereferencer";

const logger = getLoggerFor("Ldes2Traversal");

/**
 * The messages that are buffered of a page that is requested ahead: only the description message and the first members
 * are needed to continue, the source is paused after that. A page that the merge starts reading gets the usual buffer.
 */
const PREFETCH_BUFFERED_MESSAGES = 64;

/** The state that is needed to continue a synchronization: it stays small, no matter how long the stream becomes */
export type Bookmark = {
    key?: Key;
    members: string[];
    /**
     * Pages that are marked immutable by the page that links to them, that have been read completely, and that have no
     * relations: they do not need to be fetched again as long as a relation links to them.
     */
    immutable?: string[];
};

/** The paths and rules of the `ldes:EventStream` that are needed to read members */
export type StreamContext = {
    streamId: Term;
    mode: OrderMode;
    rule: MembershipRule;
    /** The store with the description message of the root page, in which the SHACL paths are described */
    pathStore: RdfStore;
    /** The timezone of timestamps without timezone, as an offset such as `+01:00` or `Z`, if known */
    defaultOffset?: string;
    timestampPath?: Term;
    sequencePath?: Term;
    versionOfPath?: Term;
    transactionFinalizedPath?: Term;
    transactionFinalizedObject?: Term;
};

export type Traversal = {
    context: StreamContext;
    bookmark: Bookmark;
    /** Opens a page: dereferences the IRI */
    open(url: string, options?: { bufferedMessages?: number }): Promise<MessageLog>;
    /**
     * The number of relations of which the page is requested before it is needed, the one that is awaited included (0 or 1: one by one).
     * They are the relations that are followed next, so a page is never fetched without being followed,
     * unless the consumer stops. Each of them buffers only a few messages, so the memory use is bounded.
     */
    prefetch?: number;
    /** Called for every member that is not before the bookmark. Returns false when the consumer is gone. */
    emit(member: Member): Promise<boolean>;
    /** Called for every page that has been opened */
    onPage?(url: string, description: Description | undefined): void;
    /** The root page, of which the first message has already been read */
    root: { log: MessageLog; first: Quad[] | undefined };
};

type Next = { quads: Quad[]; id: NamedNode; key: Key };

/** A page of which the description message has been read, and of which the next member message is known */
class OpenPage {
    next?: Next;
    /** The IRI of the relation that led to this page */
    linkedAs?: string;
    /** The page has no relations */
    leaf = true;
    private index = 0;
    private last?: Key;

    constructor(
        readonly url: string,
        readonly pageNumber: number | undefined,
        readonly log: MessageLog,
        private readonly context: StreamContext,
    ) {}

    /** Reads the next member message of the page, to know its key. Closes the page when there is none. */
    async advance(message?: Quad[] | undefined, readAhead = true): Promise<void> {
        const quads = readAhead ? await this.log.next() : message;
        if (!quads) {
            this.next = undefined;
            this.log.close();
            return;
        }
        if (quads.length === 0) {
            throw new Error(`Empty message in page ${this.url}: an LDES does not allow empty messages`);
        }
        const id = findMemberId(this.context.rule, quads);
        const key = orderingKey(this.context, id, quads, this.pageNumber, this.index, this.url);
        // Only when the order is certain, the page does not respect the specification
        const order = this.last ? compareKeysCertain(key, this.last) : undefined;
        if (order && order.certain && order.order < 0) {
            throw new Error(
                `Page ${this.url} does not respect the ordering of the LDES: ${id.value} comes after a member with a larger key`,
            );
        }
        if (!this.last || compareKeysCertain(key, this.last).order >= 0) this.last = key;
        this.index++;
        this.next = { quads, id, key };
    }
}

function singleLiteral(terms: Term[], what: string, id: Term): Term & { termType: "Literal" } {
    if (terms.length !== 1 || terms[0].termType !== "Literal") {
        throw new Error(
            `Expected exactly one literal for ${what} of member ${id.value}, found ${terms.length}`,
        );
    }
    return terms[0];
}

/** Determines the ordering key of a member, see https://w3id.org/ldes/specification#ordering-keys */
export function orderingKey(
    context: StreamContext,
    id: Term,
    quads: Quad[],
    pageNumber: number | undefined,
    index: number,
    pageUrl: string,
): Key {
    const key: Key = {};
    if (context.mode === "implicit") {
        if (pageNumber === undefined) {
            throw new Error(
                `Cannot determine the page number of ${pageUrl}: its relation has no ldes:pageNumber`,
            );
        }
        return { page: pageNumber, index };
    }
    if (context.timestampPath) {
        const literal = singleLiteral(
            evaluatePath(context.timestampPath, context.pathStore, id, quads),
            "ldes:timestampPath",
            id,
        );
        const instant = parseTimestamp(literal.value, context.defaultOffset);
        if (!literal.datatype.value.startsWith(XSD_NS + "dateTime") || instant === undefined) {
            throw new Error(
                `The timestamp of member ${id.value} is not an xsd:dateTime: ${literal.value}`,
            );
        }
        Object.assign(key, instant);
    }
    if (context.sequencePath) {
        const literal = singleLiteral(
            evaluatePath(context.sequencePath, context.pathStore, id, quads),
            "ldes:sequencePath",
            id,
        );
        if (!literal.datatype.value.startsWith(XSD_NS)) {
            throw new Error(`The sequence of member ${id.value} is not an xsd literal: ${literal.value}`);
        }
        key.sequence = { value: literal.value, datatype: literal.datatype.value } as SequenceValue;
    }
    return key;
}

function toMember(context: StreamContext, next: Next): Member {
    const member = memberFromQuads(
        next.id,
        next.quads,
        context.timestampPath,
        context.sequencePath,
        undefined,
        context.transactionFinalizedPath,
        undefined,
        context.transactionFinalizedObject,
        context.versionOfPath,
        undefined,
        context.pathStore,
    );
    if (next.key.time !== undefined) {
        // A timestamp without a timezone is read in the default timezone, or else as UTC
        member.timestamp = new Date(next.key.time);
        member.order = member.timestamp;
    }
    return member;
}

/**
 * Opens a page: reads its description message, if any, and its first member message.
 * @param first the first message of the page, when that has already been read
 */
async function openPage(
    traversal: Traversal,
    log: MessageLog,
    pageNumber: number | undefined,
    isRoot: boolean,
    first?: { quads: Quad[] | undefined },
): Promise<{ page: OpenPage; description?: Description }> {
    const { context } = traversal;
    let message = first ? first.quads : await log.next();
    let description: Description | undefined;
    if (message && message.length > 0 && isDescriptionMessage(message, log.url)) {
        description = readDescription(message, log.url, context.mode, context.defaultOffset);
        if (isRoot) pageNumber = description.pageNumber ?? 0;
        message = await log.next();
    } else if (isRoot) {
        pageNumber = 0;
    }
    const page = new OpenPage(log.url, pageNumber, log, context);
    await page.advance(message, false);
    return { page, description };
}

type Source =
    | { kind: "page"; page: OpenPage }
    | { kind: "relation"; relation: Relation };

/**
 * Executes one synchronization run. Returns the number of members that were emitted.
 */
export async function synchronize(traversal: Traversal): Promise<number> {
    const { context, bookmark } = traversal;
    const pages: OpenPage[] = [];
    const relations: Relation[] = [];
    const seen = new Set<string>();
    // The pages that are marked immutable by a page that links to them, and have been read completely in this run
    const markedImmutable = new Set<string>();
    const completed = new Set<string>();
    const referenced = new Set<string>();
    let emitted = 0;

    // Pages that are requested ahead, by relation: the ones that are followed next.
    // Of such a page, the first message is read when it arrives: if that is the description message, the relations in it
    // are known before the page is opened, so the pages below it can be requested ahead too.
    type Prefetched = { log: MessageLog; first: Quad[] | undefined };
    const prefetched = new Map<Relation, Promise<Prefetched>>();
    const prefetchWindow = Math.max(0, traversal.prefetch ?? 0);
    let finishedRun = false;
    const prefetchPage = (relation: Relation) => {
        const pending = (async (): Promise<Prefetched> => {
            const log = await traversal.open(relation.page, { bufferedMessages: PREFETCH_BUFFERED_MESSAGES });
            const first = await log.next();
            if (finishedRun) {
                log.close();
                return { log, first };
            }
            try {
                if (first && first.length > 0 && isDescriptionMessage(first, log.url)) {
                    addRelations(readDescription(first, log.url, context.mode, context.defaultOffset).relations);
                    prefetchAhead();
                }
            } catch {
                // An invalid description is reported when the page is opened
            }
            return { log, first };
        })();
        // A failure is reported when the page is needed, not before
        pending.catch(() => undefined);
        prefetched.set(relation, pending);
        return pending;
    };
    /** Requests the pages of the relations that are followed next, until the window is full */
    const prefetchAhead = () => {
        if (finishedRun || prefetched.size >= prefetchWindow) return;
        const upcoming = relations.filter((relation) => !prefetched.has(relation));
        upcoming.sort((a, b) => compareLower(a.lower, b.lower));
        for (const relation of upcoming.slice(0, prefetchWindow - prefetched.size)) {
            logger.debug(`Requesting ${relation.page} ahead`);
            prefetchPage(relation);
        }
    };

    const addRelations = (found: Relation[]) => {
        for (const relation of found) {
            referenced.add(relation.page);
            // Relations that can only lead to members that have been emitted already, are not followed
            if (relation.upper && bookmark.key && isBeforeBookmark(relation.upper, bookmark.key)) {
                logger.debug(`Skipping ${relation.page}: before the bookmark`);
                continue;
            }
            // An immutable page that was read completely in an earlier run does not need to be fetched again
            if (bookmark.immutable?.includes(relation.page)) {
                logger.debug(`Skipping ${relation.page}: immutable, and already processed`);
                continue;
            }
            const identity = JSON.stringify([relation.page, relation.lower, relation.upper]);
            if (!seen.has(identity)) {
                seen.add(identity);
                relations.push(relation);
            }
        }
    };

    const open = async (
        log: MessageLog,
        pageNumber: number | undefined,
        isRoot: boolean,
        first?: { quads: Quad[] | undefined },
        linkedAs?: string,
    ) => {
        const { page, description } = await openPage(traversal, log, pageNumber, isRoot, first);
        page.linkedAs = linkedAs;
        page.leaf = !description || description.relations.length === 0;
        traversal.onPage?.(log.url, description);
        if (description) {
            description.immutablePages.forEach((url) => markedImmutable.add(url));
            addRelations(description.relations);
        }
        if (page.next) {
            pages.push(page);
        } else {
            finished(page);
        }
        prefetchAhead();
    };

    // A page that is read completely, is immutable, and has no relations, does not have to be read again
    const finished = (page: OpenPage) => {
        if (page.linkedAs && page.leaf && markedImmutable.has(page.linkedAs)) {
            completed.add(page.linkedAs);
        }
    };

    try {
        // 1. the root page
        await open(traversal.root.log, undefined, true, { quads: traversal.root.first });

        while (pages.length > 0 || relations.length > 0) {
            // 2. the source with the smallest lower key; an open page wins a tie
            let best: Source | undefined;
            let bestKey: Key | undefined;
            for (const page of pages) {
                if (!best || compareLower(page.next!.key, bestKey) < 0) {
                    best = { kind: "page", page };
                    bestKey = page.next!.key;
                }
            }
            for (const relation of relations) {
                if (!best || compareLower(relation.lower, bestKey) < 0) {
                    best = { kind: "relation", relation };
                    bestKey = relation.lower;
                }
            }

            if (best!.kind === "page") {
                // 3. an open page
                const page = best!.page;
                const next = page.next!;
                // Only a member that is certainly before the bookmark, or that is a member of the bookmark, is skipped
                const comparison = bookmark.key
                    ? compareKeysCertain(next.key, bookmark.key)
                    : { order: 1, certain: true };
                const skip =
                    (comparison.certain && comparison.order < 0) ||
                    (comparison.certain &&
                        comparison.order === 0 &&
                        (context.mode === "implicit" || bookmark.members.includes(next.id.value))) ||
                    (!comparison.certain && bookmark.members.includes(next.id.value));
                if (!skip) {
                    if (!(await traversal.emit(toMember(context, next)))) {
                        return emitted;
                    }
                    emitted++;
                    if (!comparison.certain) {
                        // Neither earlier nor later for certain: the bookmark is the key with the latest earliest instant
                        bookmark.key = latestEarliest(bookmark.key!, next.key);
                        bookmark.members.push(next.id.value);
                    } else if (comparison.order > 0) {
                        bookmark.key = next.key;
                        bookmark.members = [next.id.value];
                    } else {
                        bookmark.members.push(next.id.value);
                    }
                }
                await page.advance();
                if (!page.next) {
                    pages.splice(pages.indexOf(page), 1);
                    finished(page);
                }
            } else {
                // 4. an unopened relation
                const relation = best!.relation;
                relations.splice(relations.indexOf(relation), 1);
                logger.debug(`Opening ${relation.page}`);
                let log: MessageLog;
                let first: { quads: Quad[] | undefined } | undefined;
                if (prefetchWindow > 0) {
                    // The page may be on its way already. Requests for the pages after it start while this one loads.
                    const pending = prefetched.get(relation) ?? prefetchPage(relation);
                    prefetchAhead();
                    try {
                        const result = await pending;
                        log = result.log;
                        first = { quads: result.first };
                    } finally {
                        prefetched.delete(relation);
                    }
                    log.maxBuffered = MAX_BUFFERED_MESSAGES;
                } else {
                    log = await traversal.open(relation.page);
                }
                await open(log, relation.pageNumber, false, first, relation.page);
            }
        }
        // 5. no sources left: the run is finished. Remember the immutable pages that are still linked to.
        const immutable = new Set([...(bookmark.immutable ?? []), ...completed]);
        bookmark.immutable = [...immutable].filter((url) => referenced.has(url));
        if (bookmark.immutable.length === 0) delete bookmark.immutable;
        return emitted;
    } finally {
        traversal.root.log.close();
        pages.forEach((page) => page.log.close());
        // Pages that were requested ahead, and are not needed any more
        finishedRun = true;
        prefetched.forEach((pending) => pending.then(({ log }) => log.close(), () => undefined));
        prefetched.clear();
    }
}
