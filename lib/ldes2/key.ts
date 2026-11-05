/**
 * Ordering keys of the LDES 2.0 specification (https://w3id.org/ldes/specification#ordering-keys)
 *
 * A key is the pair (timestamp, sequence), only a timestamp, only a sequence,
 * or, in implicit order, the pair (page number, index).
 * Keys are plain JSON objects, so that they can be stored in the client state.
 */

import { XSD_NS } from "./vocab";

export type SequenceValue = { value: string; datatype: string };

export type Key = {
    /** milliseconds since the epoch. Without a timezone (`local`), the time as if it were in UTC. */
    time?: number;
    /** The timestamp has no timezone, and no default timezone was given */
    local?: boolean;
    /** The digits of the fraction of a second beyond the milliseconds */
    fraction?: string;
    sequence?: SequenceValue;
    page?: number;
    index?: number;
};

const NUMERIC = new Set(
    [
        "byte", "decimal", "double", "float", "int", "integer", "long", "negativeInteger",
        "nonNegativeInteger", "nonPositiveInteger", "positiveInteger", "short",
        "unsignedByte", "unsignedInt", "unsignedLong", "unsignedShort",
    ].map((name) => XSD_NS + name),
);
const INTEGER = new Set(
    [
        "byte", "int", "integer", "long", "negativeInteger", "nonNegativeInteger",
        "nonPositiveInteger", "positiveInteger", "short", "unsignedByte", "unsignedInt",
        "unsignedLong", "unsignedShort",
    ].map((name) => XSD_NS + name),
);
const DATES = new Set(
    ["date", "dateTime", "dateTimeStamp"].map((name) => XSD_NS + name),
);

const numeric = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

const TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;
/** The timezone of an xsd:dateTime: Z, or an offset of at most 14 hours */
const OFFSET = /^(Z|[+-](0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;
/** The range of timezones is -14:00 to +14:00 */
const MARGIN = 14 * 60 * 60 * 1000;

export type Instant = Pick<Key, "time" | "local" | "fraction">;

export function isOffset(value: string): boolean {
    return OFFSET.test(value);
}

/**
 * Parses an xsd:dateTime. A value without timezone gets the default timezone when there is one (an offset such as
 * `+01:00` or `Z`). Otherwise it is `local`: in the same, unknown, timezone as all other literals without timezone.
 * Returns undefined when the value is not a valid xsd:dateTime.
 */
export function parseTimestamp(value: string, defaultOffset?: string): Instant | undefined {
    const trimmed = value.trim();
    const fraction = /\.(\d+)/.exec(trimmed)?.[1] ?? "";
    const milliseconds = trimmed.replace(/\.\d+/, "." + fraction.slice(0, 3).padEnd(3, "0"));
    const zoned = TIMEZONE.test(trimmed);
    const time = Date.parse(zoned ? milliseconds : milliseconds + (defaultOffset ?? "Z"));
    if (Number.isNaN(time) || !trimmed.includes("T")) return undefined;
    return { time, fraction: fraction.slice(3), local: !zoned && defaultOffset === undefined };
}

function compareNumbers(a: SequenceValue, b: SequenceValue): number {
    if (INTEGER.has(a.datatype) && INTEGER.has(b.datatype)) {
        const x = BigInt(a.value.trim());
        const y = BigInt(b.value.trim());
        return x < y ? -1 : x > y ? 1 : 0;
    }
    const x = Number(a.value);
    const y = Number(b.value);
    return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The XPath fn:compare-like comparison of two sequence literals: numbers numerically,
 * dates as points in time, and everything else by Unicode codepoints.
 */
export function compareSequences(a: SequenceValue, b: SequenceValue): number {
    if (NUMERIC.has(a.datatype) && NUMERIC.has(b.datatype)) {
        return compareNumbers(a, b);
    }
    if (DATES.has(a.datatype) && DATES.has(b.datatype)) {
        const x = pointInTime(a.value);
        const y = pointInTime(b.value);
        if (x && y) return numeric(x[0], y[0]) || compareDigits(x[1], y[1]);
    }
    const x = Array.from(a.value);
    const y = Array.from(b.value);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const diff = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/**
 * A point on the time line, for the comparison of sequences. A value without timezone is interpreted as UTC,
 * so that the comparison does not depend on the machine of the client.
 */
function pointInTime(value: string): [number, string] | undefined {
    const trimmed = value.trim();
    if (!trimmed.includes("T")) {
        const time = Date.parse(trimmed);
        return Number.isNaN(time) ? undefined : [time, ""];
    }
    const instant = parseTimestamp(trimmed);
    return instant ? [instant.time!, instant.fraction ?? ""] : undefined;
}

function compareDigits(a: string, b: string): number {
    const length = Math.max(a.length, b.length);
    const x = a.padEnd(length, "0");
    const y = b.padEnd(length, "0");
    return x < y ? -1 : x > y ? 1 : 0;
}

function compareOptional<T>(
    a: T | undefined,
    b: T | undefined,
    compare: (a: T, b: T) => number,
): number {
    // An absent component is the lowest possible value
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    return compare(a, b);
}

export type Comparison = {
    order: -1 | 0 | 1;
    /** False when the order depends on an unknown timezone */
    certain: boolean;
};

const earliest = (key: Instant) => key.time! - (key.local ? MARGIN : 0);
const latest = (key: Instant) => key.time! + (key.local ? MARGIN : 0);

/**
 * Compares two timestamps, see https://w3id.org/ldes/specification#no-timezone.
 * Two timestamps that both have no timezone, or both have one, are compared as is.
 * A timestamp without timezone that is compared to one with a timezone is a period of 28 hours: the order is only
 * certain when it holds for every timezone. Otherwise the order is that of the earliest instants.
 */
function compareTimes(a: Instant, b: Instant): Comparison {
    if (!!a.local === !!b.local) {
        const order = numeric(a.time!, b.time!) || compareDigits(a.fraction ?? "", b.fraction ?? "");
        return { order: Math.sign(order) as -1 | 0 | 1, certain: true };
    }
    if (latest(a) < earliest(b)) return { order: -1, certain: true };
    if (earliest(a) > latest(b)) return { order: 1, certain: true };
    return { order: numeric(earliest(a), earliest(b)) as -1 | 0 | 1, certain: false };
}

/**
 * Compares two keys, taking into account that the order of timestamps without timezone can be uncertain.
 * A client only skips a member or a relation, or reports a page that is not ordered, when the order is certain.
 */
export function compareKeysCertain(a: Key, b: Key): Comparison {
    const certain = (order: number): Comparison => ({ order: Math.sign(order) as -1 | 0 | 1, certain: true });
    if (a.page !== undefined || b.page !== undefined) {
        return certain(compareOptional(a.page, b.page, numeric) || compareOptional(a.index, b.index, numeric));
    }
    const time = a.time !== undefined && b.time !== undefined
        ? compareTimes(a, b)
        : certain(compareOptional(a.time, b.time, numeric));
    const sequence = compareOptional(a.sequence, b.sequence, compareSequences);
    if (time.certain) {
        return certain(time.order || sequence);
    }
    // The timestamps are indeterminate: the sequences give the order, but the outcome stays uncertain
    return { order: (sequence || time.order) as -1 | 0 | 1, certain: false };
}

/** The order in which keys are processed. When it is uncertain, that is by the earliest instant. */
export function compareKeys(a: Key, b: Key): number {
    return compareKeysCertain(a, b).order;
}

/** The lowest bound of a relation: an absent bound is the lowest possible key */
export function compareLower(a: Key | undefined, b: Key | undefined): number {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return compareKeys(a, b);
}

/**
 * Whether a relation with this upper bound can only lead to members that have been emitted: the upper key is
 * (certainly) smaller than or equal to the bookmark. With only one of the two timestamps without timezone,
 * that is when the latest instant of the upper key is not later than the earliest instant of the bookmark.
 */
export function isBeforeBookmark(upper: Key, bookmark: Key): boolean {
    if (
        upper.time !== undefined && bookmark.time !== undefined &&
        !!upper.local !== !!bookmark.local
    ) {
        return latest(upper) <= earliest(bookmark);
    }
    const comparison = compareKeysCertain(upper, bookmark);
    return comparison.certain && comparison.order <= 0;
}

/** Of two keys, the one of which the earliest instant is the latest. This is the bookmark after an uncertain comparison. */
export function latestEarliest(a: Key, b: Key): Key {
    if (a.time === undefined || b.time === undefined) return compareKeys(a, b) > 0 ? a : b;
    return earliest(b) >= earliest(a) ? b : a;
}
