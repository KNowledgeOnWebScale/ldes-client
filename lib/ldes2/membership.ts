/**
 * Member identification, see https://w3id.org/ldes/specification#membership
 */
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { resolveShaclPath } from "../utils/general";
import { V } from "./vocab";

import type { NamedNode, Quad, Term } from "@rdfjs/types";

const df = new DataFactory();

export type MembershipRule =
    | { kind: "direct"; stream: Term }
    | { kind: "graph" }
    | { kind: "type"; type: Term }
    | { kind: "path"; path: Term; pathStore: RdfStore };

/**
 * Derives the rule that is used to find the member identifier in every member message
 * from the description of the `ldes:EventStream`.
 * At most one of the indirect membership properties may be set.
 */
export function membershipRule(
    description: RdfStore,
    stream: Term,
): MembershipRule {
    const graphs = description
        .getQuads(stream, V.memberGraph, null, null)
        .filter((q) => q.object.value === "true" || q.object.value === "1");
    const types = description.getQuads(stream, V.memberType, null, null);
    const paths = description.getQuads(stream, V.memberPath, null, null);

    const set = [graphs.length > 0, types.length > 0, paths.length > 0].filter(Boolean).length;
    if (set > 1 || types.length > 1 || paths.length > 1) {
        throw new Error(
            "The ldes:EventStream sets more than one of ldes:memberGraph, ldes:memberType and ldes:memberPath, " +
            "or sets one of them more than once",
        );
    }
    if (graphs.length > 0) return { kind: "graph" };
    if (types.length > 0) return { kind: "type", type: types[0].object };
    if (paths.length > 0) {
        return { kind: "path", path: paths[0].object, pathStore: description };
    }
    return { kind: "direct", stream };
}

function onlyIri(candidates: Term[], what: string): NamedNode {
    const unique = new Map(candidates.map((term) => [term.termType + term.value, term]));
    if (unique.size !== 1) {
        throw new Error(
            `Expected exactly one ${what} in the member message, found ${unique.size}`,
        );
    }
    const term = [...unique.values()][0];
    if (term.termType !== "NamedNode") {
        throw new Error(`The member identifier found using ${what} is not an IRI: ${term.value}`);
    }
    return term;
}

/** Finds the member identifier of one member message, or throws when the message does not satisfy the rule */
export function findMemberId(rule: MembershipRule, quads: Quad[]): NamedNode {
    switch (rule.kind) {
        case "direct":
            return onlyIri(
                quads
                    .filter(
                        (q) =>
                            q.subject.equals(rule.stream) && q.predicate.equals(V.member),
                    )
                    .map((q) => q.object),
                "<ES> ldes:member triple",
            );
        case "graph":
            return onlyIri(
                quads
                    .map((q) => q.graph)
                    .filter((graph) => graph.termType !== "DefaultGraph"),
                "named graph",
            );
        case "type":
            return onlyIri(
                quads
                    .filter((q) => q.predicate.equals(V.type) && q.object.equals(rule.type))
                    .map((q) => q.subject),
                `subject with rdf:type ${rule.type.value}`,
            );
        case "path": {
            const subjects = new Map<string, Term>();
            for (const quad of quads) {
                subjects.set(quad.subject.termType + quad.subject.value, quad.subject);
            }
            let candidates: Term[];
            if (rule.path.termType === "NamedNode") {
                // Plain predicate path: a scan over the quads suffices
                candidates = quads
                    .filter((q) => q.predicate.equals(rule.path))
                    .map((q) => q.subject);
            } else {
                const store = RdfStore.createDefault();
                quads.forEach((quad) => store.addQuad(quad));
                candidates = [...subjects.values()].filter(
                    (subject) =>
                        resolveShaclPath(store, subject, rule.path, rule.pathStore).length > 0,
                );
            }
            return onlyIri(candidates, "subject from which ldes:memberPath leads to a value");
        }
    }
}

/** Evaluates a SHACL path in the union graph of a member message, with the member identifier as the focus node */
export function evaluatePath(
    path: Term,
    pathStore: RdfStore,
    member: Term,
    quads: Quad[],
): Term[] {
    if (path.termType === "NamedNode" && pathStore.getQuads(path, null, null, null).length === 0) {
        return quads
            .filter((q) => q.subject.equals(member) && q.predicate.equals(path))
            .map((q) => q.object);
    }
    const store = RdfStore.createDefault();
    quads.forEach((quad) => store.addQuad(quad));
    return resolveShaclPath(store, member, path, pathStore);
}

export { df };
