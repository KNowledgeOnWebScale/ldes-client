
import { TREE, XSD } from "@treecg/types";
import { getLoggerFor, parseInBetweenRelation } from "../utils";

import type { Term } from "@rdfjs/types";
import type { RelationValue } from "../types";

export type PathRange = {
    cbdEntry: Term;
    range?: Range;
};

export class Range {
    min?: RelationValue;
    eqMin: boolean = true;

    max?: RelationValue;
    eqMax: boolean = true;

    private logger = getLoggerFor(this);

    private defaultTimezone: string;

    constructor(
        value: RelationValue,
        type: string,
        defaultTimezone: string,
        dataType?: string,
    ) {
        value = this.parseValue(value, dataType);

        const tzRegex = /^(AoE|Z|[+-]((0[0-9]|1[0-3]):([0-5][0-9])|14:00))$/;
        if (!tzRegex.test(defaultTimezone)) {
            this.logger.warn(
                `Invalid timezone: '${defaultTimezone}'. Using default Anywhere on Earth (AoE) instead.`,
            );
            this.defaultTimezone = "AoE";
        } else {
            this.defaultTimezone = defaultTimezone;
        }
        switch (type) {
            case TREE.EqualToRelation:
                this.min = value;
                this.max = value;
                return;
            case TREE.LessThanRelation:
                this.max = value;
                this.eqMax = false;
                return;
            case TREE.LessThanOrEqualToRelation:
                this.max = value;
                return;
            case TREE.GreaterThanRelation:
                this.min = value;
                this.eqMin = false;
                return;
            case TREE.GreaterThanOrEqualToRelation:
                this.min = value;
                return;
            case TREE.custom("InBetweenRelation"): {
                if (typeof value !== "string") {
                    throw (
                        "InBetweenRelation can only handle string values, not" +
                        typeof value
                    );
                }
                const between = parseInBetweenRelation(
                    value,
                    dataType,
                    this.defaultTimezone,
                );
                if (between) {
                    this.min = between.min;
                    this.eqMin = true;
                    this.max = between.max;
                    this.eqMax = false;
                }
                return;
            }
        }
    }

    static empty(defaultTimezone: string): Range {
        return new Range("", TREE.Relation, defaultTimezone);
    }

    add(value: RelationValue, type: string, dataType?: string) {
        value = this.parseValue(value, dataType);

        switch (type) {
            case TREE.EqualToRelation:
                this.min = value;
                this.max = value;
                return;
            case TREE.LessThanRelation:
                if (!this.max || value < this.max) {
                    this.max = value;
                    this.eqMax = false;
                }
                return;
            case TREE.LessThanOrEqualToRelation:
                if (!this.max || value < this.max) {
                    this.max = value;
                }
                return;
            case TREE.GreaterThanRelation:
                if (!this.min || value > this.min) {
                    this.min = value;
                    this.eqMin = false;
                }
                return;
            case TREE.GreaterThanOrEqualToRelation:
                if (!this.min || value > this.min) {
                    this.min = value;
                }
                return;
            case TREE.custom("InBetweenRelation"): {
                if (typeof value !== "string") {
                    throw (
                        "InBetweenRelation can only handle string values, not" +
                        typeof value
                    );
                }
                const between = parseInBetweenRelation(
                    value,
                    dataType,
                    this.defaultTimezone,
                );
                if (between) {
                    if (this.min === undefined || between.min < this.min) {
                        this.min = between.min;
                        this.eqMin = true;
                    }
                    if (this.max === undefined || between.max < this.max) {
                        this.max = between.max;
                        this.eqMax = false;
                    }
                }
                return;
            }
        }
    }

    contains(value: RelationValue | Date | number): boolean {
        if (this.min) {
            if (this.eqMin) {
                if (this.min > value) return false;
            } else {
                if (this.min >= value) return false;
            }
        }
        if (this.max) {
            if (this.eqMax) {
                if (this.max < value) return false;
            } else {
                if (this.max <= value) return false;
            }
        }
        return true;
    }

    overlaps(other: Range): boolean {
        if (this.min && other.max) {
            if (this.eqMin && other.eqMax) {
                if (this.min > other.max) return false;
            } else {
                if (this.min >= other.max) return false;
            }
        }

        if (this.max && other.min) {
            if (this.eqMax && other.eqMin) {
                if (other.min > this.max) return false;
            } else {
                if (other.min >= this.max) return false;
            }
        }

        return true;
    }

    toString(valueToString?: (value: RelationValue) => string): string {
        const vts = valueToString || ((x: RelationValue) => x.toString());
        const start = this.min ? (this.eqMin ? "[" : "]") + vts(this.min) : "]∞";
        const end = this.max ? vts(this.max) + (this.eqMax ? "]" : "[") : "∞[";
        return start + "," + end;
    }

    parseValue(value: RelationValue, dataType?: string): RelationValue {
        if (dataType === XSD.dateTime) {
            return new Date(value);
        } else if (dataType === XSD.integer) {
            return parseInt(value.toString());
        } else if (dataType === XSD.custom("float")) {
            return parseFloat(value.toString());
        } else if (dataType === XSD.custom("double")) {
            return parseFloat(value.toString());
        } else if (dataType === XSD.custom("decimal")) {
            return parseFloat(value.toString());
        }
        return value;
    }
}
