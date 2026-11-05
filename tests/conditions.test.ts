import { describe, expect, it } from "vitest";
import { TREE } from "@treecg/types";
import { DataFactory } from "rdf-data-factory";
import type { Term } from "@rdfjs/types";
import { RdfStore } from "rdf-stores";
import { Range, cbdEquals } from "../lib/condition";

const lessers = [
    new Range(5, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.LessThanRelation, "AoE"),
    new Range(4, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(4, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(3, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(3, TREE.GreaterThanRelation, "AoE"),

    new Range(4, TREE.EqualToRelation, "AoE"),
];

const not_lessers = [
    new Range(4, TREE.GreaterThanRelation, "AoE"),
    new Range(5, TREE.GreaterThanRelation, "AoE"),
    new Range(5, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.EqualToRelation, "AoE"),
];

const equals = [
    new Range(6, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(6, TREE.LessThanRelation, "AoE"),
    new Range(5, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(4, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(4, TREE.GreaterThanRelation, "AoE"),
    new Range(5, TREE.EqualToRelation, "AoE"),
];

const not_equals = [
    new Range(4, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.GreaterThanRelation, "AoE"),
    new Range(5, TREE.LessThanRelation, "AoE"),
    new Range(6, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(4, TREE.EqualToRelation, "AoE"),
    new Range(6, TREE.EqualToRelation, "AoE"),
];

const greaters = [
    new Range(7, TREE.LessThanRelation, "AoE"),
    new Range(7, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(6, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(6, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.GreaterThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.GreaterThanRelation, "AoE"),

    new Range(6, TREE.EqualToRelation, "AoE"),
];

const not_greater = [
    new Range(6, TREE.LessThanRelation, "AoE"),
    new Range(5, TREE.LessThanRelation, "AoE"),
    new Range(5, TREE.LessThanOrEqualToRelation, "AoE"),
    new Range(5, TREE.EqualToRelation, "AoE"),
];

describe("contains", () => {
    lessers.forEach((x) =>
        it(`${x.toString()} contains 4}`, () => {
            expect(x.contains(4)).toBeTruthy();
        }),
    );
    equals.forEach((x) =>
        it(`${x.toString()} contains 5}`, () => {
            expect(x.contains(5)).toBeTruthy();
        }),
    );
    greaters.forEach((x) =>
        it(`${x.toString()} contains 6}`, () => {
            expect(x.contains(6)).toBeTruthy();
        }),
    );

    not_lessers.forEach((x) =>
        it(`${x.toString()} does not contain 4}`, () => {
            expect(x.contains(4)).toBeFalsy();
        }),
    );
    not_equals.forEach((x) =>
        it(`${x.toString()} does not contain 5}`, () => {
            expect(x.contains(5)).toBeFalsy();
        }),
    );
    not_greater.forEach((x) =>
        it(`${x.toString()} does not contain 6}`, () => {
            expect(x.contains(6)).toBeFalsy();
        }),
    );
});

describe("range", () => {
    describe("things 4 or less)", () => {
        const tests = [
            new Range(4, TREE.EqualToRelation, "AoE"),
            new Range(4, TREE.LessThanOrEqualToRelation, "AoE"),
        ];

        describe("overlaps", () => {
            lessers.forEach((x) => {
                tests.forEach((y) => {
                    it(`${x.toString()} overlaps ${y.toString()}`, () => {
                        expect(x.overlaps(y)).toBeTruthy();
                    });
                    it(`${y.toString()} overlaps ${x.toString()}`, () => {
                        expect(y.overlaps(x)).toBeTruthy();
                    });
                });
            });
        });
        describe("does not overlap", () => {
            not_lessers.forEach((x) => {
                tests.forEach((y) => {
                    it(`${x.toString()} not overlaps ${y.toString()}`, () => {
                        expect(x.overlaps(y)).toBeFalsy();
                    });
                    it(`${y.toString()} not overlaps ${x.toString()}`, () => {
                        expect(y.overlaps(x)).toBeFalsy();
                    });
                });
            });
        });
    });

    describe("things 6 or more)", () => {
        const tests = [
            new Range(6, TREE.EqualToRelation, "AoE"),
            new Range(6, TREE.GreaterThanOrEqualToRelation, "AoE"),
        ];

        describe("overlaps", () => {
            greaters.forEach((x) => {
                tests.forEach((y) => {
                    it(`${x.toString()} overlaps ${y.toString()}`, () => {
                        expect(x.overlaps(y)).toBeTruthy();
                    });
                    it(`${y.toString()} overlaps ${x.toString()}`, () => {
                        expect(y.overlaps(x)).toBeTruthy();
                    });
                });
            });
        });
        describe("does not overlap", () => {
            not_greater.forEach((x) => {
                tests.forEach((y) => {
                    it(`${x.toString()} not overlaps ${y.toString()}`, () => {
                        expect(x.overlaps(y)).toBeFalsy();
                    });
                    it(`${y.toString()} not overlaps ${x.toString()}`, () => {
                        expect(y.overlaps(x)).toBeFalsy();
                    });
                });
            });
        });
    });
});

describe("cbdEquals", () => {
    const df = new DataFactory();
    const store = RdfStore.createDefault();
    const path = (iri: string) => ({ id: df.namedNode(iri), store });

    it("treats the same predicate as equal, and different predicates as different", () => {
        expect(cbdEquals(path("http://example.org/a"), path("http://example.org/a"))).toBe(true);
        expect(cbdEquals(path("http://example.org/a"), path("http://example.org/b"))).toBe(false);
    });

    it("treats a relation without a path as only equal to another one without a path, and does not fail on it", () => {
        const none = { id: undefined as unknown as Term, store };
        expect(cbdEquals(none, none)).toBe(true);
        expect(cbdEquals(none, path("http://example.org/a"))).toBe(false);
        expect(cbdEquals(path("http://example.org/a"), none)).toBe(false);
    });
});
