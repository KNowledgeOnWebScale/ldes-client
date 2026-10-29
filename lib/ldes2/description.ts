/**
 * Reading the description message of a page, see https://w3id.org/ldes/specification#log-structure
 */
import { RdfStore } from "rdf-stores";
import { LDES1_PREDICATES, LDES2_PREDICATES, LDES_PROFILE, V } from "./vocab";
import { parseTimestamp } from "./key";
import { getObjects } from "../utils/general";

import type { Quad, Term } from "@rdfjs/types";
import type { Instant, Key, SequenceValue } from "./key";
import type { MessageLog } from "../fetcher/ldfetchDereferencer";

export type OrderMode = "implicit" | "timestamp" | "sequence" | "timestamp-sequence";

/** One `ldes:relation`: the page to follow and the interval of the order that can be found there */
export type Relation = {
    page: string;
    /** Absent when the relation has no lower bound */
    lower?: Key;
    /** Absent when the relation has no upper bound */
    upper?: Key;
    /** The number of the page this relation points to (implicit order only) */
    pageNumber?: number;
};

export type Description = {
    store: RdfStore;
    relations: Relation[];
    immutable: boolean;
    /** The pages that the description message marks as immutable, with `<P> ldes:immutable true` */
    immutablePages: Set<string>;
    pageNumber?: number;
};

export type LdesVersion = 1 | 2;

/**
 * Decides whether the first message of a response is LDES 1.0 or LDES 2.0,
 * following https://w3id.org/ldes/specification#compatibility.
 * Returns undefined when the response does not tell.
 */
export function detectVersion(
    log: MessageLog,
    first: Quad[] | undefined,
): LdesVersion | undefined {
    // 1. media type and syntax
    const profile = /profile="?([^";]+)"?/.exec(log.headers.get("content-type") ?? "")?.[1];
    if (log.framed || profile === LDES_PROFILE || /\.ldes\.[a-z]+(\.gz)?$/.test(log.url)) {
        return 2;
    }
    // 2. content of the first statements
    const predicates = new Set(first?.map((quad) => quad.predicate.value));
    if (LDES1_PREDICATES.some((p) => predicates.has(p))) return 1;
    if (LDES2_PREDICATES.some((p) => predicates.has(p))) return 2;
    return undefined;
}

export function isEventStreamDescription(quads: Quad[]): boolean {
    return quads.some(
        (quad) => quad.predicate.equals(V.type) && quad.object.equals(V.EventStream),
    );
}

/**
 * A message is the description message when it has the page IRI as the subject of a triple,
 * or when it describes the LDES using a subject with `rdf:type ldes:EventStream`.
 */
export function isDescriptionMessage(quads: Quad[], pageUrl: string): boolean {
    return (
        isEventStreamDescription(quads) ||
        quads.some(
            (quad) => quad.subject.termType === "NamedNode" && quad.subject.value === pageUrl,
        )
    );
}

export function toStore(quads: Quad[]): RdfStore {
    const store = RdfStore.createDefault();
    quads.forEach((quad) => store.addQuad(quad));
    return store;
}

function single(store: RdfStore, subject: Term, predicate: Term, what: string): Term | undefined {
    const objects = getObjects(store, subject, predicate);
    if (objects.length > 1) {
        throw new Error(`Expected at most one ${what}, found ${objects.length}`);
    }
    return objects[0];
}

function nonNegativeInteger(term: Term | undefined, what: string): number | undefined {
    if (!term) return undefined;
    const value = Number(term.value);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${what} must be a non-negative integer, found ${term.value}`);
    }
    return value;
}

function timestamp(term: Term | undefined, what: string, defaultOffset?: string): Instant | undefined {
    if (!term) return undefined;
    const instant = parseTimestamp(term.value, defaultOffset);
    if (instant === undefined) {
        throw new Error(`${what} must be an xsd:dateTime, found ${term.value}`);
    }
    return instant;
}

function sequence(term: Term | undefined): SequenceValue | undefined {
    if (!term) return undefined;
    return {
        value: term.value,
        datatype: term.termType === "Literal" ? term.datatype.value : "",
    };
}

/**
 * Reads the relations (and the page-level flags) of the description message of a page.
 * @param quads the description message
 * @param pageUrl the IRI of the page `<>`, after following redirects
 * @param mode the order of the LDES, which determines what the bounds of a relation mean
 * @param defaultOffset the timezone of timestamps without timezone, if known
 */
export function readDescription(
    quads: Quad[],
    pageUrl: string,
    mode: OrderMode,
    defaultOffset?: string,
    store = toStore(quads),
): Description {
    const pageNode = quads.find(
        (quad) => quad.subject.termType === "NamedNode" && quad.subject.value === pageUrl,
    )?.subject;
    const relations: Relation[] = [];
    let immutable = false;
    let pageNumber: number | undefined;
    // `<P> ldes:immutable true` can be stated about the page itself, and about the pages that it links to
    const immutablePages = new Set(
        store
            .getQuads(null, V.immutable, null, null)
            .filter((quad) => quad.subject.termType === "NamedNode" && (quad.object.value === "true" || quad.object.value === "1"))
            .map((quad) => quad.subject.value),
    );

    if (pageNode) {
        immutable = getObjects(store, pageNode, V.immutable).some(
            (term) => term.value === "true" || term.value === "1",
        );
        pageNumber = nonNegativeInteger(
            single(store, pageNode, V.pageNumber, "ldes:pageNumber of the page"),
            "ldes:pageNumber",
        );
        for (const relation of getObjects(store, pageNode, V.relation)) {
            relations.push(readRelation(store, relation, mode, defaultOffset));
        }
    }
    return { store, relations, immutable, immutablePages, pageNumber };
}

function readRelation(store: RdfStore, relation: Term, mode: OrderMode, defaultOffset?: string): Relation {
    const pages = getObjects(store, relation, V.page);
    if (pages.length !== 1 || pages[0].termType !== "NamedNode") {
        throw new Error(
            `A relation must have exactly one ldes:page that is an IRI, found ${pages.length}`,
        );
    }
    const page = pages[0].value;
    const get = (predicate: Term, what: string) => single(store, relation, predicate, what);

    if (mode === "implicit") {
        const pageNumber = nonNegativeInteger(get(V.pageNumber, "ldes:pageNumber"), "ldes:pageNumber");
        const until = nonNegativeInteger(
            get(V.pageNumberUntil, "ldes:pageNumberUntil"),
            "ldes:pageNumberUntil",
        );
        if (pageNumber === undefined) return { page };
        return {
            page,
            pageNumber,
            lower: { page: pageNumber, index: 0 },
            upper: { page: until ?? pageNumber + 1, index: 0 },
        };
    }

    const timeFrom = timestamp(get(V.timeFrom, "ldes:timeFrom"), "ldes:timeFrom", defaultOffset);
    const timeUntil = timestamp(get(V.timeUntil, "ldes:timeUntil"), "ldes:timeUntil", defaultOffset);
    const sequenceFrom = sequence(get(V.sequenceFrom, "ldes:sequenceFrom"));
    const sequenceUntil = sequence(get(V.sequenceUntil, "ldes:sequenceUntil"));

    if (mode !== "sequence") {
        if (sequenceFrom && !timeFrom) {
            throw new Error("ldes:sequenceFrom must be accompanied by ldes:timeFrom");
        }
        if (sequenceUntil && !timeUntil) {
            throw new Error("ldes:sequenceUntil must be accompanied by ldes:timeUntil");
        }
    }
    const bound = (instant?: Instant, seq?: SequenceValue): Key | undefined => {
        if (mode === "sequence") return seq ? { sequence: seq } : undefined;
        if (!instant) return undefined;
        return mode === "timestamp-sequence" && seq ? { ...instant, sequence: seq } : { ...instant };
    };
    return { page, lower: bound(timeFrom, sequenceFrom), upper: bound(timeUntil, sequenceUntil) };
}
