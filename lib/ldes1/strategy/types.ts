import { TREE } from "@treecg/types";

import type { NamedNode } from "@rdfjs/types";

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
