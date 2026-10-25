import { Parser, Writer } from "n3";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { RDF, SHACL } from "@treecg/types";
import { getLoggerFor } from "./logUtil";

import type { LDESInfo, Member, Modulator } from "../fetcher";
import type { NumericOrderValue, OrderValue } from "../fetcher";
import type { SerializedMember } from "../strategy";
import type { ParserOptions } from "n3";
import type {
    NamedNode,
    Quad,
    BaseQuad,
    Quad_Predicate,
    Quad_Subject,
    Quad_Object,
    Stream,
    Term,
} from "@rdfjs/types";

const logger = getLoggerFor("Utils");

const df = new DataFactory();

// N3.js already scopes blank node labels per parser instance
export function parseQuads(source: string, options?: ParserOptions): Quad[] {
    return new Parser(options).parse(source);
}

export function serializeQuads(quads: Quad[]): string {
    return new Writer().quadsToString(quads);
}

export function getSubjects(
    store: RdfStore,
    predicate: Term | null,
    object: Term | null,
    graph?: Term | null,
): Quad_Subject[] {
    return store.getQuads(null, predicate, object, graph).map((quad) => {
        return quad.subject;
    });
}

export function getObjects(
    store: RdfStore,
    subject: Term | null,
    predicate: Term | null,
    graph?: Term | null,
): Quad_Object[] {
    return store.getQuads(subject, predicate, null, graph).map((quad) => {
        return quad.object;
    });
}

export function readableToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
    const out: T[] = [];
    const reader = stream.getReader();
    return new Promise((res, rej) => {
        const next = () => {
            reader
                .read()
                .catch(rej)
                .then((obj) => {
                    if (obj) {
                        if (obj.done) {
                            res(out);
                        } else {
                            out.push(obj.value);
                            next();
                        }
                    } else {
                        res(out);
                    }
                });
        };
        next();
    });
}

/**
 * Converts a stream to an array, pushing all elements to an array
 * Resolving the promise with the 'end' event
 */
export function streamToArray<T extends BaseQuad>(
    stream: Stream<T>,
): Promise<T[]> {
    const out: T[] = [];
    return new Promise((res, rej) => {
        stream.on("end", () => res(out));
        stream.on("data", (x) => {
            out.push(x);
        });
        stream.on("error", (ex) => {
            logger.error("[streamToArray] Stream to Array failed");
            rej(ex);
        });
    });
}

export function streamToString(stream: Stream): Promise<string> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        stream.on("data", (chunk: ArrayBuffer) =>
            chunks.push(Buffer.from(chunk)),
        );
        stream.on("error", (err: unknown) => reject(err));
        stream.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8")),
        );
    });
}

/**
 * Find the main sh:NodeShape subject of a given Shape Graph.
 * We determine this by assuming that the main node shape
 * is not referenced by any other shape description.
 * If more than one is found an exception is thrown.
 */
export function extractMainNodeShape(store: RdfStore): NamedNode {
    const nodeShapes = getSubjects(
        store,
        RDF.terms.type,
        SHACL.terms.NodeShape,
        null,
    );
    let mainNodeShape = null;

    if (nodeShapes && nodeShapes.length > 0) {
        for (const ns of nodeShapes) {
            const isNotReferenced =
                getSubjects(store, null, ns, null).length === 0;

            if (isNotReferenced) {
                if (!mainNodeShape) {
                    mainNodeShape = ns;
                } else {
                    throw new Error(
                        "There are multiple main node shapes in a given shape graph. Unrelated shapes must be given as separate shape graphs",
                    );
                }
            }
        }
        if (mainNodeShape) {
            return <NamedNode>mainNodeShape;
        } else {
            throw new Error(
                "No main SHACL Node Shapes found in given shape graph",
            );
        }
    } else {
        throw new Error("No SHACL Node Shapes found in given shape graph");
    }
}

export function urlToUrl(input: Parameters<typeof fetch>[0]): URL {
    if (typeof input === "string") {
        return new URL(input);
    } else if (input instanceof URL) {
        return input;
    } else if (input instanceof Request) {
        return new URL(input.url);
    } else {
        throw "Not a real url";
    }
}

export function memberFromQuads(
    member: Term,
    quads: Quad[],
    timestampPath: Term | undefined,
    sequencePath: Term | undefined,
    sequencePathTerms: Term[] | undefined,
    transactionFinalizedPath: Term | undefined,
    transactionFinalizedPathTerms: Term[] | undefined,
    transactionFinalizedObject: Term | undefined,
    isVersionOfPath: Term | undefined,
    created?: Date,
    pathStore?: RdfStore,
): Member {
    // Indexing every member into its own store is expensive, so only do it when
    // a path actually requires the store (complex SHACL paths). Plain predicate
    // paths are resolved with a direct scan over the member quads.
    let memberStore: RdfStore | undefined;
    const getMemberStore = () => {
        if (!memberStore) {
            memberStore = RdfStore.createDefault();
            quads.forEach((quad) => memberStore!.addQuad(quad));
        }
        return memberStore;
    };
    const resolvePath = (path: Term): Term | undefined => {
        if (isPlainPredicate(path, quads, pathStore)) {
            return quads.find(
                (x) => x.subject.equals(member) && x.predicate.equals(path),
            )?.object;
        }
        const store = getMemberStore();
        return resolveShaclPath(store, member, path, pathStore ?? store)[0];
    };

    // Get timestamp
    let timestamp: OrderValue | undefined;
    if (timestampPath) {
        const value = resolvePath(timestampPath);
        if (value) {
            const date = new Date(value.value);
            timestamp = Number.isNaN(date.getTime())
                ? termToOrderValue(value)
                : date;
        }
    }
    const sequence = extractSequenceValue(sequencePath, resolvePath);
    const order = timestamp ?? sequence;
    const transactionFinalized = extractFinalizedValue(
        transactionFinalizedPath,
        transactionFinalizedObject,
        resolvePath,
    );

    // Get isVersionof
    let isVersionOf: string | undefined;
    if (isVersionOfPath) {
        isVersionOf = quads.find(
            (x) =>
                x.subject.equals(member) && x.predicate.equals(isVersionOfPath),
        )?.object.value;
    }

    // Get type
    const type: Term | undefined = quads.find(
        (x) => x.subject.equals(member) && x.predicate.value === RDF.type,
    )?.object;
    return { quads, id: member, isVersionOf, order, timestamp, sequence, transactionFinalized, type, created };
}

/**
 * A path is a plain predicate when it is a named node that carries no SHACL
 * path description (sequence, alternative, inverse, ...) in the path store.
 */
function isPlainPredicate(
    path: Term,
    quads: Quad[],
    pathStore?: RdfStore,
): boolean {
    if (path.termType !== "NamedNode") {
        return false;
    }
    if (pathStore) {
        return pathStore.getQuads(path, null, null, null).length === 0;
    }
    return !quads.some((quad) => quad.subject.equals(path));
}

function extractSequenceValue(
    sequencePath: Term | undefined,
    resolvePath: (path: Term) => Term | undefined,
): OrderValue | undefined {
    if (!sequencePath) {
        return;
    }
    const sequence = resolvePath(sequencePath);
    if (!sequence) {
        return;
    }
    return termToOrderValue(sequence);
}

function extractFinalizedValue(
    path: Term | undefined,
    finalizedObject: Term | undefined,
    resolvePath: (path: Term) => Term | undefined,
): boolean | undefined {
    if (!path) {
        return;
    }
    const value = resolvePath(path);
    if (!value) {
        return;
    }
    const expected = finalizedObject ??
        df.literal("true", df.namedNode("http://www.w3.org/2001/XMLSchema#boolean"));
    return value.equals(expected);
}

const numericDatatypes = new Set([
    "http://www.w3.org/2001/XMLSchema#byte",
    "http://www.w3.org/2001/XMLSchema#decimal",
    "http://www.w3.org/2001/XMLSchema#double",
    "http://www.w3.org/2001/XMLSchema#float",
    "http://www.w3.org/2001/XMLSchema#int",
    "http://www.w3.org/2001/XMLSchema#integer",
    "http://www.w3.org/2001/XMLSchema#long",
    "http://www.w3.org/2001/XMLSchema#negativeInteger",
    "http://www.w3.org/2001/XMLSchema#nonNegativeInteger",
    "http://www.w3.org/2001/XMLSchema#nonPositiveInteger",
    "http://www.w3.org/2001/XMLSchema#positiveInteger",
    "http://www.w3.org/2001/XMLSchema#short",
    "http://www.w3.org/2001/XMLSchema#unsignedByte",
    "http://www.w3.org/2001/XMLSchema#unsignedInt",
    "http://www.w3.org/2001/XMLSchema#unsignedLong",
    "http://www.w3.org/2001/XMLSchema#unsignedShort",
]);
const dateDatatypes = new Set([
    "http://www.w3.org/2001/XMLSchema#date",
    "http://www.w3.org/2001/XMLSchema#dateTime",
    "http://www.w3.org/2001/XMLSchema#dateTimeStamp",
]);

function termToOrderValue(term: Term): OrderValue {
    if (term.termType === "Literal") {
        if (numericDatatypes.has(term.datatype.value)) {
            return { type: "numeric", value: term.value };
        }
        if (dateDatatypes.has(term.datatype.value)) {
            const date = new Date(term.value);
            if (!Number.isNaN(date.getTime())) {
                return date;
            }
        }
    }
    return term.value;
}

export function resolveShaclPath(
    data: RdfStore,
    focus: Term,
    path: Term,
    pathStore = data,
): Term[] {
    return resolveShaclPathInternal(data, focus, path, pathStore, new Set());
}

function resolveShaclPathInternal(
    data: RdfStore,
    focus: Term,
    path: Term,
    pathStore: RdfStore,
    active: Set<string>,
): Term[] {
    const key = `${termKey(focus)}|${termKey(path)}`;
    if (active.has(key)) return [];
    const nextActive = new Set(active).add(key);

    const sequence = rdfListToArray(pathStore, path);
    if (sequence) {
        return sequence.reduce<Term[]>(
            (subjects, item) => subjects.flatMap((subject) =>
                resolveShaclPathInternal(data, subject, item, pathStore, nextActive),
            ),
            [focus],
        );
    }

    const alternative = pathStore.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#alternativePath"),
        null,
        null,
    )[0]?.object;
    if (alternative) {
        return uniqueTerms(
            (rdfListToArray(pathStore, alternative) ?? []).flatMap((item) =>
                resolveShaclPathInternal(data, focus, item, pathStore, nextActive),
            ),
        );
    }

    const inverse = pathStore.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#inversePath"),
        null,
        null,
    )[0]?.object;
    if (inverse) {
        if (inverse.termType === "NamedNode") {
            return data.getQuads(null, inverse, focus, null).map((quad) => quad.subject);
        }
        return uniqueTerms(
            data.getQuads(null, null, null, null)
                .map((quad) => quad.subject)
                .filter((subject, index, subjects) =>
                    subjects.findIndex((candidate) => candidate.equals(subject)) === index
                )
                .filter((subject) =>
                    resolveShaclPathInternal(data, subject, inverse, pathStore, nextActive)
                        .some((value) => value.equals(focus))
                ),
        );
    }

    const zeroOrMore = pathStore.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#zeroOrMorePath"),
        null,
        null,
    )[0]?.object;
    if (zeroOrMore) {
        return uniqueTerms([
            focus,
            ...resolveTransitiveShaclPath(data, focus, zeroOrMore, pathStore, nextActive),
        ]);
    }

    const oneOrMore = pathStore.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#oneOrMorePath"),
        null,
        null,
    )[0]?.object;
    if (oneOrMore) {
        return resolveTransitiveShaclPath(data, focus, oneOrMore, pathStore, nextActive);
    }

    const zeroOrOne = pathStore.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#zeroOrOnePath"),
        null,
        null,
    )[0]?.object;
    if (zeroOrOne) {
        return uniqueTerms([
            focus,
            ...resolveShaclPathInternal(data, focus, zeroOrOne, pathStore, nextActive),
        ]);
    }

    return data.getQuads(focus, path, null, null).map((quad) => quad.object);
}

function resolveTransitiveShaclPath(
    data: RdfStore,
    focus: Term,
    path: Term,
    pathStore: RdfStore,
    active: Set<string>,
): Term[] {
    const results: Term[] = [];
    const queue = resolveShaclPathInternal(data, focus, path, pathStore, active);
    const seen = new Set<string>();

    for (let index = 0; index < queue.length; index++) {
        const term = queue[index];
        const key = termKey(term);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push(term);
        queue.push(...resolveShaclPathInternal(data, term, path, pathStore, active));
    }

    return results;
}

function uniqueTerms(terms: Term[]): Term[] {
    return terms.filter((term, index) =>
        terms.findIndex((candidate) => candidate.equals(term)) === index
    );
}

function termKey(term: Term): string {
    if (term.termType === "Literal") {
        return `${term.termType}:${term.value}:${term.language}:${term.datatype.value}`;
    }
    return `${term.termType}:${term.value}`;
}

export function resolveShaclPathTerms(
    data: RdfStore,
    focus: Term,
    pathTerms: Term[],
): Term[] {
    return pathTerms.reduce<Term[]>(
        (subjects, predicate) => subjects.flatMap((subject) =>
            data.getQuads(subject, predicate, null, null).map((quad) => quad.object),
        ),
        [focus],
    );
}

export function shaclPathKey(store: RdfStore, path: Term | undefined): string | undefined {
    if (!path) {
        return;
    }
    const sequence = rdfListToArray(store, path);
    if (sequence) {
        return `sequence:${sequence.map((term) => shaclPathKey(store, term)).join("/")}`;
    }
    const alternative = store.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#alternativePath"),
        null,
        null,
    )[0]?.object;
    if (alternative) {
        const choices = rdfListToArray(store, alternative) ?? [];
        return `alternative:${choices.map((term) => shaclPathKey(store, term)).join("|")}`;
    }
    const inverse = store.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#inversePath"),
        null,
        null,
    )[0]?.object;
    if (inverse) {
        return `inverse:${shaclPathKey(store, inverse)}`;
    }
    const zeroOrMore = store.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#zeroOrMorePath"),
        null,
        null,
    )[0]?.object;
    if (zeroOrMore) {
        return `zeroOrMore:${shaclPathKey(store, zeroOrMore)}`;
    }
    const oneOrMore = store.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#oneOrMorePath"),
        null,
        null,
    )[0]?.object;
    if (oneOrMore) {
        return `oneOrMore:${shaclPathKey(store, oneOrMore)}`;
    }
    const zeroOrOne = store.getQuads(
        path,
        df.namedNode("http://www.w3.org/ns/shacl#zeroOrOnePath"),
        null,
        null,
    )[0]?.object;
    if (zeroOrOne) {
        return `zeroOrOne:${shaclPathKey(store, zeroOrOne)}`;
    }
    return `term:${path.value}`;
}

export function shaclPathTerms(store: RdfStore, path: Term | undefined): Term[] | undefined {
    if (!path) {
        return;
    }
    return rdfListToArray(store, path);
}

function rdfListToArray(store: RdfStore, head: Term): Term[] | undefined {
    if (head.equals(RDF.terms.nil)) {
        return [];
    }
    const out: Term[] = [];
    const seen = new Set<string>();
    let current: Term | undefined = head;

    while (current && !current.equals(RDF.terms.nil)) {
        if (seen.has(current.value)) {
            return;
        }
        seen.add(current.value);

        const first = store.getQuads(current, RDF.terms.first, null, null)[0]?.object;
        const rest: Term | undefined = store.getQuads(current, RDF.terms.rest, null, null)[0]?.object;
        if (!first || !rest) {
            return;
        }
        out.push(first);
        current = rest;
    }

    return out.length > 0 ? out : undefined;
}

export function serializeMember(member: Member): SerializedMember {
    return {
        id: member.id.value,
        quads: serializeQuads(member.quads),
        order: serializeOrderValue(member.order),
        timestamp: serializeOrderValue(member.timestamp),
        sequence: serializeOrderValue(member.sequence),
        transactionFinalized: member.transactionFinalized,
        isVersionOf: member.isVersionOf,
        type: member.type?.value,
        created: member.created?.toISOString(),
    };
}

export function deserializeMember(serialized: SerializedMember): Member {
    const order = serialized.order === undefined
        ? undefined
        : deserializeOrderValue(serialized.order);
    let timestamp: OrderValue | undefined;
    if (serialized.timestamp) {
        try {
            timestamp = new Date(serialized.timestamp);
        } catch {
            timestamp = serialized.timestamp;
        }
    }
    let sequence: OrderValue | undefined;
    if (serialized.sequence !== undefined) {
        sequence = deserializeOrderValue(serialized.sequence);
    }
    return {
        id: df.namedNode(serialized.id),
        quads: parseQuads(serialized.quads),
        order,
        timestamp,
        sequence,
        transactionFinalized: serialized.transactionFinalized,
        isVersionOf: serialized.isVersionOf,
        type: serialized.type ? df.namedNode(serialized.type) : undefined,
        created: serialized.created ? new Date(serialized.created) : undefined,
    };
}

function deserializeOrderValue(value: string): OrderValue {
    if (value.startsWith("numeric:")) {
        return <NumericOrderValue>{ type: "numeric", value: value.slice("numeric:".length) };
    }
    const number = Number(value);
    if (!Number.isNaN(number)) {
        return number;
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date;
    }
    return value;
}

function serializeOrderValue(value: OrderValue | undefined): string | undefined {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (isNumericOrderValue(value)) {
        return `numeric:${value.value}`;
    }
    return value?.toString();
}

function isNumericOrderValue(value: OrderValue | undefined): value is NumericOrderValue {
    return typeof value === "object" && value !== undefined && !(value instanceof Date) && value.type === "numeric";
}

/**
 * Version materialization function that sets the declared ldes:versionOfPath property value
 * as the member's subject IRI
 */
export function maybeVersionMaterialize(
    member: Member,
    materialize: boolean,
    ldesInfo: LDESInfo,
): Member {
    if (materialize && ldesInfo.versionOfPath) {
        // Create RDF store with member quads
        const memberStore = RdfStore.createDefault();
        member.quads.forEach((q) => memberStore.addQuad(q));
        // Get materialized subject IRI
        const newSubject = getObjects(
            memberStore,
            member.id,
            ldesInfo.versionOfPath,
        )[0];
        if (newSubject) {
            // Remove version property
            memberStore.removeQuad(
                df.quad(
                    <Quad_Subject>member.id,
                    <Quad_Predicate>ldesInfo.versionOfPath,
                    newSubject,
                ),
            );
            // Updated all quads with materialized subject
            for (const q of memberStore.getQuads(member.id)) {
                //q.subject = <Quad_Subject>newSubject;
                const newQ = df.quad(
                    <Quad_Subject>newSubject,
                    q.predicate,
                    q.object,
                    q.graph,
                );
                memberStore.removeQuad(q);
                memberStore.addQuad(newQ);
            }
            // Update member object
            member.id = newSubject;
            member.quads = memberStore.getQuads();
        } else {
            logger.warn(`No version property found in Member (${member.id.value}) as specified by ldes:isVersionOfPath ${ldesInfo.versionOfPath.value}`);
        }
    }

    return member;
}

export async function memberIsOld(member: Member, modulator: Modulator<unknown, unknown>) {
    if (!modulator.hasLatestVersions() || !member.isVersionOf || !member.timestamp) {
        return false;
    }
    logger.silly(`[memberIsOld] Checking if member <${member.id.value}> (version of: ${member.isVersionOf}) is old`);
    // We are emitting latest versions only
    const version = member.timestamp instanceof Date
        ? member.timestamp.getTime()
        : isNumericOrderValue(member.timestamp)
            ? Number.NaN
            : new Date(member.timestamp).getTime();
    if (Number.isNaN(version)) {
        return false;
    }
    try {
        return await modulator.filterLatest(member.isVersionOf, version);
    } catch (ex) {
        throw ex;
    }
}
