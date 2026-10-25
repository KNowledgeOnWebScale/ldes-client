import { DataFactory } from "rdf-data-factory";
import { BasicLensM, extractShapes, pred } from "rdf-lens";
import { RdfStore } from "rdf-stores";
import { RDF, TREE, XSD } from "@treecg/types";
import { getLoggerFor, getObjects, parseQuads } from "../utils";
import { SHAPES } from "./shapes";
import { Range } from "./range";

import type { Quad, Term } from "@rdfjs/types";
import type { Cont } from "rdf-lens";
import type { PathRange } from "./range";
import type { Member, RelationValue } from "../fetcher";

const df = new DataFactory();

type RdfThing = {
    entry: Term;
    quads: Quad[];
};

export type Path = {
    store: RdfStore;
    id: Term;
};

type CompareTypes = "string" | "date" | "integer" | "float";

export interface Condition {
    matchRelation(range: Range | undefined, cbdId: Path): boolean;

    matchMember(member: Member): boolean;
    memberEmitted(member: Member): void;

    toString(): string;

    poll(): void;
}

export function empty_condition(): Condition {
    return new EmptyCondition();
}

export function parse_condition(source: string, baseIRI: string): Condition {
    const shapeQuads = parseQuads(SHAPES);
    const output = extractShapes(shapeQuads, {
        "http://vocab.deri.ie/csp#And": (obj) =>
            new AndCondition(
                <ConstructorParameters<typeof AndCondition>[0]>obj,
            ),
        "http://vocab.deri.ie/csp#MaxCount": (obj) =>
            new MaxCountCondition(
                <ConstructorParameters<typeof MaxCountCondition>[0]>obj,
            ),
        "http://vocab.deri.ie/csp#Or": (obj) =>
            new OrCondition(<ConstructorParameters<typeof OrCondition>[0]>obj),
        "http://vocab.deri.ie/csp#Condition": (obj) =>
            new LeafCondition(
                <ConstructorParameters<typeof LeafCondition>[0]>obj,
            ),
    });

    const dataQuads = parseQuads(source, { baseIRI: baseIRI });

    return <Condition>output.lenses[
        "https://w3id.org/rdf-lens/ontology#TypedExtract"
    ].execute({
        quads: dataQuads,
        id: df.namedNode(baseIRI),
    });
}

export function cbdEquals(a: Path, b: Path): boolean {
    const sort = (a: Quad, b: Quad) => {
        const ap = a.predicate.value;
        const bp = b.predicate.value;
        if (ap == bp) return 0;
        return ap < bp ? -1 : 1;
    };
    const alphaQuads = a.store.getQuads(a.id, null, null, null).sort(sort);
    const betaQuads = b.store.getQuads(b.id, null, null, null).sort(sort);

    if (alphaQuads.length != betaQuads.length) return false;

    for (let i = 0; i < alphaQuads.length; i++) {
        if (!alphaQuads[i].predicate.equals(betaQuads[i].predicate)) {
            return false;
        }

        const av = alphaQuads[i].object;
        const bv = betaQuads[i].object;

        if (av.termType !== bv.termType) return false;
        if (av.termType === "BlankNode") {
            if (
                !cbdEquals(
                    { id: av, store: a.store },
                    { id: bv, store: b.store },
                )
            ) {
                return false;
            }
        } else {
            if (av.value !== bv.value) {
                return false;
            }
        }
    }

    return true;
}

export class RelationCondition {
    store: RdfStore;

    defaultTimezone: string;

    ranges: PathRange[] = [];

    constructor(store: RdfStore, defaultTimezone: string) {
        this.store = store;
        this.defaultTimezone = defaultTimezone;
    }

    allowed(condition: Condition): boolean {
        return this.ranges.every((x) => {
            return condition.matchRelation(x.range, {
                id: x.cbdEntry,
                store: this.store,
            });
        });
    }

    addRelation(relationId: Term) {
        const ty =
            getObjects(this.store, relationId, RDF.terms.type, null)[0] ||
            TREE.Relation;

        const path = getObjects(
            this.store,
            relationId,
            TREE.terms.path,
            null,
        )[0];

        const value = getObjects(
            this.store,
            relationId,
            TREE.terms.value,
            null,
        )[0];

        let range = this.ranges.find((range) =>
            cbdEquals(
                { id: path, store: this.store },
                { id: range.cbdEntry, store: this.store },
            ),
        );

        if (!range) {
            const newRange: PathRange = {
                cbdEntry: path,
                range: Range.empty(this.defaultTimezone),
            };
            this.ranges.push(newRange);
            range = newRange;
        }

        if (!value) {
            range.range = undefined;
            return;
        }

        let dataType;
        if (value.termType === "Literal") {
            dataType = value.datatype.value;
        }

        range.range?.add(value.value, ty.value, dataType);
    }
}

export class LeafCondition implements Condition {
    relationType: Term;
    value: Term;
    compareType: CompareTypes;

    path: BasicLensM<Cont, Cont>;
    pathQuads: Path;

    range: Range;

    defaultTimezone: string;

    private logger = getLoggerFor(this);

    constructor(inp: {
        relationType: Term;
        value: Term;
        compareType?: string;
        path: BasicLensM<Cont, Cont>;
        pathQuads: RdfThing;
        defaultTimezone: string;
    }) {
        this.relationType = inp.relationType;
        this.value = inp.value;
        this.compareType = <CompareTypes>inp.compareType || "string";
        this.path = inp.path;
        const store = RdfStore.createDefault();
        inp.pathQuads.quads.forEach((x) => store.addQuad(x));
        this.pathQuads = { id: inp.pathQuads.entry, store };
        this.defaultTimezone = inp.defaultTimezone;
        let dataType;
        if (inp.value.termType === "Literal") {
            dataType = inp.value.datatype.value;
        }

        this.range = new Range(
            this.parseValue(inp.value.value),
            inp.relationType.value,
            this.defaultTimezone,
            dataType,
        );
    }

    memberEmitted(): void {
        // empty
    }

    toString(): string {
        const vts =
            this.compareType === "date"
                ? (x: RelationValue) => (<Date>x).toISOString()
                : undefined;
        return `${this.pathQuads.id.value} ∈ ${this.range.toString(vts)}`;
    }

    matchRelation(range: Range | undefined, cbdId: Path): boolean {
        if (!cbdEquals(this.pathQuads, cbdId)) {
            return true;
        }
        if (!range) {
            this.logger.debug(
                "[matchRelation] Range is here also undefined, returning false",
            );
            return false;
        }

        const vts =
            this.compareType === "date"
                ? (x: RelationValue) => new Date(x).toISOString()
                : undefined;
        this.logger.debug(
            `${this.range.toString(vts)} contains ${range.toString(vts)}. Overlaps: ${this.range.overlaps(
                range,
            )}`,
        );

        return this.range.overlaps(range);
    }

    matchMember(member: Member): boolean {
        const rawPathValue = this.path.execute(member)[0];
        if (rawPathValue !== undefined) {
            const value = this.parseValue(rawPathValue.id.value);
            return this.range.contains(value);
        } else {
            throw new Error(
                `Property Path <${this.pathQuads.id.value}> does not exist in member <${member.id.value}>`,
            );
        }
    }

    private parseValue(value: string): RelationValue {
        switch (this.compareType) {
            case "string":
                return value;
            case "date":
                return new Date(value);
            case "integer":
                return parseInt(value);
            case "float":
                return parseFloat(value);
            default:
                return value;
        }
    }

    poll(): void {
        // pass
    }
}

abstract class BiCondition implements Condition {
    items: Condition[];

    constructor(inp: { items: Condition[] }) {
        this.items = inp.items;
    }

    abstract combine(alpha: boolean, beta: boolean): boolean;

    abstract memberEmitted(member: Member): void;

    matchRelation(range: Range | undefined, cbdId: Path): boolean {
        return this.items
            .map((x) => x.matchRelation(range, cbdId))
            .reduce(this.combine.bind(this));
    }

    matchMember(member: Member): boolean {
        return this.items
            .map((x) => x.matchMember(member))
            .reduce(this.combine.bind(this));
    }

    poll(): void {
        this.items.forEach((x) => x.poll());
    }
}

export class AndCondition extends BiCondition {
    combine(alpha: boolean, beta: boolean): boolean {
        return alpha && beta; // TODO those might be null if something cannot make a statement about it, important for not condition
    }
    memberEmitted(member: Member): void {
        this.items.forEach((x) => x.memberEmitted(member));
    }
    toString(): string {
        const contents = this.items.map((x) => x.toString()).join(" ^ ");
        return `(${contents})`;
    }
}

export class OrCondition extends BiCondition {
    combine(alpha: boolean, beta: boolean): boolean {
        return alpha || beta; // TODO those might be null if something cannot make a statement about it, important for not condition
    }
    memberEmitted(member: Member): void {
        for (const item of this.items) {
            if (item.matchMember(member)) {
                item.memberEmitted(member);
            }
        }
    }
    toString(): string {
        const contents = this.items.map((x) => x.toString()).join(" V ");
        return `(${contents})`;
    }
}

export class EmptyCondition implements Condition {

    matchRelation(_range: Range, _cbdId: Path): boolean {
        return true;
    }

    matchMember(_member: Member): boolean {
        return true;
    }

    memberEmitted(): void {
        // empty
    }

    toString() {
        return "EmptyCondition (always true)";
    }
    poll(): void {
        // empty
    }
}

export class MaxCountCondition implements Condition {
    maxCount: number;
    current: number;
    reset_on_poll: boolean;
    constructor(inp: { count: number; reset_on_poll?: boolean }) {
        this.maxCount = inp.count;
        this.current = 0;
        this.reset_on_poll = inp.reset_on_poll || false;
    }

    matchRelation(): boolean {
        return this.current < this.maxCount;
    }

    memberEmitted(): void {
        this.current += 1;
    }

    matchMember(): boolean {
        return this.current < this.maxCount;
    }
    toString(): string {
        return `${this.current} < ${this.maxCount}`;
    }

    poll(): void {
        if (this.reset_on_poll) {
            this.current = 0;
        }
    }
}

export async function processConditionFile(
    conditionFile?: string,
): Promise<Condition> {
    let condition: Condition = empty_condition();

    /* eslint-disable  @typescript-eslint/no-require-imports */
    const fs =
        typeof require === "undefined"
            ? await import("fs/promises")
            : require("fs/promises");

    if (conditionFile) {
        try {
            condition = parse_condition(
                await fs.readFile(conditionFile, { encoding: "utf8" }),
                conditionFile,
            );
        } catch (ex) {
            console.error(`Failed to read condition file: ${conditionFile}`);
            throw ex;
        }
    }

    return condition;
}

/**
 * Function that handles any given condition, together with the "before" and "after" options,
 * and builds the corresponding unified Condition.
 */
export function handleConditions(
    condition: Condition,
    defaultTimezone: string,
    before?: Date,
    after?: Date,
    timestampPath?: Term,
): Condition {
    if ((before || after) && !timestampPath) {
        throw "Cannot apply 'before' or 'after' filters since the target LDES does not define a ldes:timestampPath predicate";
    }

    // Check if before and after conditions are defined and build corresponding Condition object
    let handledCondition: Condition = empty_condition();
    const toDateLiteral = (date: Date) => {
        return df.literal(date.toISOString(), XSD.terms.dateTime);
    };

    const predLens = pred(timestampPath);

    if (before) {
        handledCondition = new LeafCondition({
            relationType: TREE.terms.LessThanRelation,
            value: toDateLiteral(before),
            compareType: "date",
            path: predLens,
            pathQuads: { entry: timestampPath!, quads: [] },
            defaultTimezone,
        });
    }

    if (after) {
        const afterCond = new LeafCondition({
            relationType: TREE.terms.GreaterThanRelation,
            value: toDateLiteral(after),
            compareType: "date",
            path: predLens,
            pathQuads: { entry: timestampPath!, quads: [] },
            defaultTimezone,
        });
        if (handledCondition instanceof EmptyCondition) {
            handledCondition = afterCond;
        } else {
            // Got bi-condition with before & after filters
            handledCondition = new AndCondition({
                items: [handledCondition, afterCond],
            });
        }
    }

    // See if condition file was defined too
    if (!(condition instanceof EmptyCondition)) {
        return new AndCondition({
            items: [condition, handledCondition],
        });
    } else {
        return handledCondition;
    }
}
