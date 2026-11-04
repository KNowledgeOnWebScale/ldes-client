import { BaseQuad, Writer, Parser } from "n3";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { RDF, SHACL } from "@treecg/types";
import { getLoggerFor } from "./logUtil";

import type { LDESInfo, Member, Modulator } from "../fetcher";
import type { SerializedMember } from "../strategy";
import type {
    NamedNode,
    Quad,
    Quad_Predicate,
    Quad_Subject,
    Quad_Object,
    Stream,
    Term,
} from "@rdfjs/types";

const logger = getLoggerFor("Utils");

const df = new DataFactory();

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
    isVersionOfPath: Term | undefined,
    created?: Date,
): Member {
    // Get timestamp
    let timestamp: string | Date | undefined;
    if (timestampPath) {
        const ts = quads.find(
            (x) =>
                x.subject.equals(member) && x.predicate.equals(timestampPath),
        )?.object.value;
        if (ts) {
            try {
                timestamp = new Date(ts);
            } catch (ex: unknown) {
                timestamp = ts;
            }
        }
    }

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
    return { quads, id: member, isVersionOf, timestamp, type, created };
}

export function serializeMember(member: Member): SerializedMember {
    return {
        id: member.id.value,
        quads: new Writer().quadsToString(member.quads),
        timestamp: member.timestamp instanceof Date
            ? member.timestamp.toISOString()
            : member.timestamp?.toString(),
        isVersionOf: member.isVersionOf,
        type: member.type?.value,
        created: member.created?.toISOString(),
    };
}

export function deserializeMember(serialized: SerializedMember): Member {
    let timestamp: string | Date | undefined;
    if (serialized.timestamp) {
        try {
            timestamp = new Date(serialized.timestamp);
        } catch {
            timestamp = serialized.timestamp;
        }
    }
    return {
        id: df.namedNode(serialized.id),
        quads: new Parser().parse(serialized.quads),
        timestamp,
        isVersionOf: serialized.isVersionOf,
        type: serialized.type ? df.namedNode(serialized.type) : undefined,
        created: serialized.created ? new Date(serialized.created) : undefined,
    };
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
    const version = member.timestamp instanceof Date ?
        member.timestamp.getTime() : new Date(member.timestamp).getTime();
    return await modulator.filterLatest(member.isVersionOf, version);
}