import { TREE } from "@treecg/types";
import { Member, FetchedPage } from "../fetcher";

import type { NamedNode } from "@rdfjs/types";

export type Ordered = "ascending" | "descending" | "none";

/**
 * Predicates representing greater than relations
 */
export const GTRs: NamedNode[] = [
    TREE.terms.GreaterThanRelation,
    TREE.terms.GreaterThanOrEqualToRelation,
];

/**
 * Predicates representing less than relations
 */
export const LTR: NamedNode[] = [
    TREE.terms.LessThanRelation,
    TREE.terms.LessThanOrEqualToRelation,
];

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
