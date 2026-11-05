import { DataFactory } from "rdf-data-factory";

const df = new DataFactory();

export const LDES_NS = "https://w3id.org/ldes#";
export const TREE_NS = "https://w3id.org/tree#";
export const XSD_NS = "http://www.w3.org/2001/XMLSchema#";
export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** Media type parameter that announces that a response is an LDES page */
export const LDES_PROFILE = "https://w3id.org/ldes/specification";

const ldes = (name: string) => df.namedNode(LDES_NS + name);

export const V = {
    EventStream: ldes("EventStream"),
    relation: ldes("relation"),
    page: ldes("page"),
    member: ldes("member"),
    immutable: ldes("immutable"),
    timeFrom: ldes("timeFrom"),
    timeUntil: ldes("timeUntil"),
    sequenceFrom: ldes("sequenceFrom"),
    sequenceUntil: ldes("sequenceUntil"),
    pageNumber: ldes("pageNumber"),
    pageNumberUntil: ldes("pageNumberUntil"),
    memberGraph: ldes("memberGraph"),
    memberType: ldes("memberType"),
    memberPath: ldes("memberPath"),
    timestampPath: ldes("timestampPath"),
    sequencePath: ldes("sequencePath"),
    versionOfPath: ldes("versionOfPath"),
    versionTimestampPath: ldes("versionTimestampPath"),
    versionSequencePath: ldes("versionSequencePath"),
    transactionFinalizedPath: ldes("transactionFinalizedPath"),
    transactionFinalizedObject: ldes("transactionFinalizedObject"),
    pollingInterval: ldes("pollingInterval"),
    defaultTimezone: ldes("defaultTimezone"),
    retentionPolicy: ldes("retentionPolicy"),
    shape: ldes("shape"),
    type: df.namedNode(RDF_TYPE),
};

/** The terms that mark a page as an LDES 1.0 (TREE based) page */
export const LDES1_PREDICATES = ["view", "member", "relation", "viewDescription"].map(
    (name) => TREE_NS + name,
);
/** The terms that mark a page as an LDES 2.0 page */
export const LDES2_PREDICATES = [V.relation.value, V.page.value, V.member.value];
