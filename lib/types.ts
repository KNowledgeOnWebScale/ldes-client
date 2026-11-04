/**
 * Types that are shared between the LDES 1.0 engine (`lib/ldes1`), the LDES 2.0 engine
 * (`lib/ldes2`), the client and the utilities.
 */
import type { CBDShapeExtractor } from "extract-cbd-shape";
import type { RdfStore } from "rdf-stores";
import type { Quad, Term } from "@rdfjs/types";

export type RelationValue = string | Date | number;

export type Ordered = "ascending" | "descending" | "none";

export type NumericOrderValue = {
    type: "numeric";
    value: string;
};

export type OrderValue = string | Date | number | NumericOrderValue;

export interface Member {
    id: Term;
    quads: Quad[];
    order?: OrderValue;
    timestamp?: OrderValue;
    sequence?: OrderValue;
    transactionFinalized?: boolean;
    isVersionOf?: string;
    type?: Term;
    created?: Date;
}

export type SerializedMember = {
    id: string;
    quads: string;
    order?: string;
    timestamp?: string;
    sequence?: string;
    transactionFinalized?: boolean;
    isVersionOf?: string;
    type?: string;
    created?: string;
};

export type LDESInfo = {
    shape: Term;
    shapeQuads: Quad[];
    contextQuads?: Quad[];
    extractor: CBDShapeExtractor;
    rootNode?: Term;
    shapes?: Term[];
    viewDescriptions?: Term[];
    retentionPolicies?: Term[];
    emptyRetentionPolicies?: Term[];
    timestampPath?: Term;
    timestampPathKey?: string;
    sequencePath?: Term;
    sequencePathTerms?: Term[];
    sequencePathKey?: string;
    transactionFinalizedPath?: Term;
    transactionFinalizedPathTerms?: Term[];
    transactionFinalizedObject?: Term;
    versionOfPath?: Term;
    versionTimestampPath?: Term;
    versionSequencePath?: Term;
    pollingInterval?: number;
    /** The version of the LDES specification of the LDES that is replicated */
    ldesVersion?: 1 | 2;
};

export type FetchedPage = {
    url: string;
    data: RdfStore;
    immutable: boolean;
    memberCount: number;
    etag?: string;
    status?: number;
    created?: Date;
    updated?: Date;
};

export type Notifier<Events, S> = {
    [K in keyof Events]: (event: Events[K], state: S) => unknown;
};

export type StrategyEvents = {
    member: Member;
    fragment: FetchedPage;
    /* eslint-disable  @typescript-eslint/no-empty-object-type */
    mutable: {};
    /* eslint-disable  @typescript-eslint/no-empty-object-type */
    pollCycle: {};
    /* eslint-disable  @typescript-eslint/no-empty-object-type */
    close: {};
    error: unknown;
};
