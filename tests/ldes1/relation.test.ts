import { describe, expect, test } from "vitest";
import Heap from "heap-js";
import { RelationChain } from "../../lib/ldes1";

import type { SimpleRelation } from "../../lib/ldes1";

import type { OrderValue } from "../../lib/types";

describe("Chain relations", () => {
    test("correct chaining", () => {
        let chain = new RelationChain("", "");
        chain = chain.push("", { value: 0, important: false });

        expect(chain.relations.length).toBe(1);
        chain = chain.push("", { value: 0, important: false });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: false, value: 0 });

        chain = chain.push("", { value: 1, important: true });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: true, value: 1 });

        chain = chain.push("", { value: 2, important: true });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: true, value: 1 });

        chain = chain.push("", { value: 2, important: false });
        expect(chain.relations.length).toBe(2);
        expect(chain.relations[0]).toEqual({ important: true, value: 1 });
        expect(chain.relations[1]).toEqual({ important: false, value: 2 });

        chain = chain.push("", { value: 2, important: false });
        expect(chain.relations.length).toBe(2);
        expect(chain.relations[0]).toEqual({ important: true, value: 1 });
        expect(chain.relations[1]).toEqual({ important: false, value: 2 });

        chain = chain.push("", { value: 2, important: true });
        expect(chain.relations.length).toBe(1);
    });

    test("correct chaining with ord", () => {
        let chain = new RelationChain("", "", [], undefined, (a, b) =>
            a < b ? -1 : 1,
        );
        chain = chain.push("", { value: 0, important: false });

        expect(chain.relations.length).toBe(1);
        chain = chain.push("", { value: 0, important: false });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: false, value: 0 });

        chain = chain.push("", { value: 1, important: true });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: true, value: 1 });

        chain = chain.push("", { value: 2, important: true });
        expect(chain.relations.length).toBe(1);
        expect(chain.relations[0]).toEqual({ important: true, value: 2 });

        chain = chain.push("", { value: 2, important: false });
        expect(chain.relations.length).toBe(2);
        expect(chain.relations[0]).toEqual({ important: true, value: 2 });
        expect(chain.relations[1]).toEqual({ important: false, value: 2 });

        chain = chain.push("", { value: 2, important: false });
        expect(chain.relations.length).toBe(2);
        expect(chain.relations[0]).toEqual({ important: true, value: 2 });
        expect(chain.relations[1]).toEqual({ important: false, value: 2 });

        chain = chain.push("", { value: 2, important: true });
        expect(chain.relations.length).toBe(1);
    });

    test("correct ordering", () => {
        let value1 = new RelationChain("", "").push("", {
            value: 0,
            important: false,
        });
        let value2 = new RelationChain("", "").push("", {
            value: 0,
            important: true,
        });

        // unimportant should be handled first!
        expect(value1.ordering(value2)).toBe(-1);
        expect(value2.ordering(value1)).toBe(1);

        value1 = new RelationChain("", "").push("", { value: 0, important: false });
        value2 = new RelationChain("", "")
            .push("", { value: 0, important: true })
            .push("", {
                value: 1,
                important: false,
            });
        // unimportant should be handled first!
        expect(value1.ordering(value2)).toBe(-1);
        expect(value2.ordering(value1)).toBe(1);

        value1 = new RelationChain("", "").push("", { value: 0, important: false });
        value2 = new RelationChain("", "")
            .push("", { value: 0, important: false })
            .push("", {
                value: 1,
                important: false,
            });

        // both are not important so they are not ordered
        expect(value1.ordering(value2)).toBe(0);
        expect(value2.ordering(value1)).toBe(0);

        value1 = new RelationChain("", "").push("", { value: 0, important: true });
        value2 = new RelationChain("", "").push("", { value: 10, important: true });

        // both are imporant, smallest value first
        expect(value1.ordering(value2)).toBe(-1);
        expect(value2.ordering(value1)).toBe(1);

        value1 = new RelationChain("", "")
            .push("", { value: 0, important: true })
            .push("", {
                value: 0,
                important: false,
            });
        value2 = new RelationChain("", "").push("", { value: 0, important: true });

        expect(value1.ordering(value2)).toBe(0);
        expect(value2.ordering(value1)).toBe(0);
    });

    test("correct ordering with ord", () => {
        const params: [
            SimpleRelation[],
            SimpleRelation | undefined,
            (a: OrderValue, b: OrderValue) => number,
        ] = [[], undefined, (a: OrderValue, b: OrderValue) => (a == b ? 0 : a < b ? 1 : -1)];

        let value1 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: false,
        });
        let value2 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: true,
        });

        // unimportant should be handled first!
        expect(value1.ordering(value2)).toBe(-1);
        expect(value2.ordering(value1)).toBe(1);

        value1 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: false,
        });
        value2 = new RelationChain("", "", ...params)
            .push("", { value: 0, important: true })
            .push("", {
                value: 1,
                important: false,
            });
        // unimportant should be handled first!
        expect(value1.ordering(value2)).toBe(-1);
        expect(value2.ordering(value1)).toBe(1);

        value1 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: false,
        });
        value2 = new RelationChain("", "", ...params).push("", {
            value: 1,
            important: false,
        });

        // both are not important so they are not ordered
        expect(value1.ordering(value2)).toBe(0);
        expect(value2.ordering(value1)).toBe(0);

        value1 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: true,
        });
        value2 = new RelationChain("", "", ...params).push("", {
            value: 10,
            important: true,
        });

        // both are imporant, smallest value first
        expect(value1.ordering(value2)).toBe(1);
        expect(value2.ordering(value1)).toBe(-1);

        value1 = new RelationChain("", "", ...params)
            .push("", { value: 0, important: true })
            .push("", {
                value: 0,
                important: false,
            });
        value2 = new RelationChain("", "", ...params).push("", {
            value: 0,
            important: true,
        });

        expect(value1.ordering(value2)).toBe(0);
        expect(value2.ordering(value1)).toBe(0);
    });

    test("heap works with relation", () => {
        const params: [
            SimpleRelation[],
            SimpleRelation | undefined,
            (a: OrderValue, b: OrderValue) => number,
        ] = [[], undefined, (a: OrderValue, b: OrderValue) => (a == b ? 0 : a < b ? 1 : -1)];

        const value1 = new RelationChain("", "", ...params);
        const value2 = new RelationChain("", "", ...params).push("", {
            value: new Date("2001-03-01T00:00:00.000Z"),
            important: true,
        });

        const heap = new Heap<RelationChain>((a, b) => a.ordering(b));
        heap.add(value2);
        heap.add(value1);
        // heap.add(value1);

        expect(heap.length).toBe(2);
        expect(heap.toArray()).toEqual([value1, value2]);

        const eq_value1 = new RelationChain("", "", ...params);
        heap.remove(eq_value1, (a, b) => a.ordering(b) === 0);

        expect(heap.length).toBe(1);
        expect(heap.toArray()).toEqual([value2]);
    });

    test("heap works with relation (important)", () => {
        const params: [
            SimpleRelation[],
            SimpleRelation | undefined,
            (a: OrderValue, b: OrderValue) => number,
        ] = [[], undefined, (a: OrderValue, b: OrderValue) => (a == b ? 0 : a < b ? 1 : -1)];

        const value0 = new RelationChain("", "", ...params).push("", {
            value: new Date("2001-03-01T00:00:00.000Z"),
            important: true,
        });
        const value1 = new RelationChain("", "", ...params).push("", {
            value: new Date("2001-03-01T00:01:00.000Z"),
            important: true,
        });
        const value2 = new RelationChain("", "", ...params).push("", {
            value: new Date("2001-03-01T00:02:00.000Z"),
            important: true,
        });

        const heap = new Heap<RelationChain>((a, b) => a.ordering(b));
        heap.add(value1);
        heap.add(value2);
        heap.add(value0);
        // heap.add(value1);

        heap.toArray().map(({ relations }) => relations);
        // expect(heap.length).toBe(3);
        expect(heap.toArray()).toEqual([value2, value1, value0]);
    });
});
