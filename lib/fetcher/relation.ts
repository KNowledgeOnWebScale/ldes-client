import { RDF, TREE } from "@treecg/types";
import { RdfStore } from "rdf-stores";
import { RelationCondition } from "../condition";
import { getObjects, getLoggerFor, shaclPathKey } from "../utils";

import type { Term } from "@rdfjs/types";
import type { Condition } from "../condition";

export interface FoundRelation {
    source: string;
    node: string;
    allowed: boolean;
    relations: RelationKind[];
}

export interface RelationKind {
    id?: Term;
    type: Term;
    value?: Term[];
    path?: Term;
    pathKey?: string;
}

export type RelationValue = string | Date | number;

export type SimpleRelation = {
    important: boolean;
    value: RelationValue;
};

export function extractRelations(
    store: RdfStore,
    node: Term,
    loose: boolean,
    condition: Condition,
    defaultTimezone: string,
): FoundRelation[] {
    const logger = getLoggerFor("extractRelations");

    const relationIds = loose
        ? getObjects(store, null, TREE.terms.relation, null)
        : getObjects(store, node, TREE.terms.relation, null);

    const source = node.value;

    const conditions = new Map<
        string,
        { cond: RelationCondition; relation: FoundRelation }
    >();

    for (const relationId of relationIds) {
        const nodes = getObjects(store, relationId, TREE.terms.node, null);
        const ty =
            getObjects(store, relationId, RDF.terms.type, null)[0] ||
            TREE.Relation;
        const path = getObjects(store, relationId, TREE.terms.path, null)[0];
        const value = getObjects(store, relationId, TREE.terms.value, null);

        const relation = {
            type: ty,
            path,
            pathKey: shaclPathKey(store, path),
            value,
            id: relationId,
        };
        for (const node of nodes) {
            const found = conditions.get(node.value);
            if (!found) {
                const condition = new RelationCondition(store, defaultTimezone);
                condition.addRelation(relationId);
                conditions.set(node.value, {
                    cond: condition,
                    relation: {
                        node: node.value,
                        source,
                        allowed: false,
                        relations: [relation],
                    },
                });
            } else {
                found.relation.relations.push(relation);
                found.cond.addRelation(relationId);
            }
        }
    }

    const found = [];
    for (const cond of conditions.values()) {
        logger.debug(`Checking ${condition.toString()} for relation(s) towards <${cond.relation.node}>`);
        if (cond.cond.allowed(condition)) {
            cond.relation.allowed = true;
        }
        found.push(cond.relation);
    }
    return found;
}

/**
 * This relation chain is important to better understand the order of fragments to fetch
 * First fetch all not important relations
 * Then fetch an important relation with the smallest value (for timestamp path)
 * This new relation can access other unimportant relations, but these should only be fetched after full unimportant relation chains
 */
export class RelationChain {
    source: string;
    relations: SimpleRelation[];
    target: string;
    private cmp?: (a: RelationValue, b: RelationValue) => number;

    constructor(
        source: string,
        target: string,
        relations: SimpleRelation[] = [],
        additional?: SimpleRelation,
        cmp?: (a: RelationValue, b: RelationValue) => number,
    ) {
        this.source = source;
        this.target = target;
        this.cmp = cmp;
        this.relations = relations.map(({ value, important }) => ({
            value,
            important,
        }));
        if (additional) {
            this.relations.push(additional);
            while (this.relations.length >= 2) {
                // Second to last element
                const a = this.relations[this.relations.length - 2];
                // Last element
                const b = this.relations[this.relations.length - 1];

                if (a.important && !b.important) {
                    break; // This cannot be compacted
                }
                // A and B are important, compact on value
                if (a.important) {
                    const va = a.value;
                    const vb = b.value;
                    if (this.cmp) {
                        if (this.cmp(va, vb) < 0) {
                            a.value = b.value;
                        }
                    } else {
                        a.value = va < vb ? va : vb;
                    }
                } else {
                    // a is not important, so we can just take b values
                    a.important = b.important;
                    a.value = b.value;
                }

                this.relations.pop();
            }
        }
    }

    push(target: string, relation: SimpleRelation): RelationChain {
        return new RelationChain(
            this.target,
            target,
            this.relations,
            relation,
            this.cmp,
        );
    }

    important(): boolean {
        if (this.relations.length > 0) {
            return this.relations[0].important;
        } else {
            return false;
        }
    }

    /**
     * If the returned number is less than 0, it indicates that the first item should come before the second item in the sorted order.
     * If the returned number is greater than 0, it indicates that the first item should come after the second item in the sorted order.
     * If the returned number is equal to 0, it means that the two items are considered equivalent in terms of sorting order.
     */
    ordering(other: RelationChain): number {
        if (this.important() && !other.important()) {
            return 1;
        }
        if (!this.important() && other.important()) {
            return -1;
        }

        const la = this.relations.length;
        const lb = other.relations.length;
        for (let i = 0; i < Math.min(la, lb); i++) {
            const a = this.relations[i];
            const b = other.relations[i];

            if (a.important && !b.important) return 1;
            if (!a.important && b.important) return -1;
            if (!a.important && !b.important) continue;

            // Both are important
            if (this.cmp) {
                const v = this.cmp(a.value, b.value);
                if (v !== 0) return v;
            } else {
                if (a.value < b.value) return -1;
                if (a.value > b.value) return 1;
            }
        }

        return 0;
    }
}
