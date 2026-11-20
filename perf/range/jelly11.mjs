/**
 * A Jelly-RDF 1.1 writer for a log that is published by appending frames, and read with HTTP Range requests.
 *
 * It compresses like any Jelly writer (lookup tables of prefixes, names and datatypes, repeated terms, relative
 * identifiers), with one difference: a frame does not depend on the statement before it. Its first statement gives all its
 * terms, and the first IRI has explicit identifiers. The lookup tables are shared across frames, so a client that kept
 * them (see lib/fetcher/resume.ts) can read the appended frames on their own.
 *
 * Every frame is one RDF Message. The first frame carries the stream options.
 */

const QUADS = 2;
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const ROW = { options: 1, quad: 3, name: 9, prefix: 10, datatype: 11 };

function varint(n) {
    const bytes = [];
    while (n >= 0x80) {
        bytes.push((n % 128) | 0x80);
        n = Math.floor(n / 128);
    }
    bytes.push(n);
    return Buffer.from(bytes);
}
const num = (field, value) => (value === 0 ? Buffer.alloc(0) : Buffer.concat([varint(field * 8), varint(value)]));
const len = (field, bytes) => Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
const text = (field, value) => len(field, Buffer.from(value, "utf8"));

/** A lookup table with least-recently-used eviction: an entry that the current statement uses is never evicted */
class Lookup {
    constructor(size) {
        this.size = size;
        this.ids = new Map(); // value -> id, in order of last use
        this.free = 1;
    }

    /** The id of a value, and whether it has to be sent as a new entry */
    get(value) {
        let id = this.ids.get(value);
        if (id !== undefined) {
            this.ids.delete(value);
            this.ids.set(value, id);
            return { id, added: false };
        }
        if (this.free <= this.size) {
            id = this.free++;
        } else {
            const [oldest, oldId] = this.ids.entries().next().value;
            this.ids.delete(oldest);
            id = oldId;
        }
        this.ids.set(value, id);
        return { id, added: true };
    }
}

export class ResumableJellyWriter {
    constructor({ maxNames = 4000, maxPrefixes = 150, maxDatatypes = 32 } = {}) {
        this.sizes = { maxNames, maxPrefixes, maxDatatypes };
        this.names = new Lookup(maxNames);
        this.prefixes = new Lookup(maxPrefixes);
        this.datatypes = new Lookup(maxDatatypes);
        this.started = false;
    }

    /** One message as one delimited frame */
    frame(quads) {
        const rows = [];
        if (!this.started) {
            this.started = true;
            const { maxNames, maxPrefixes, maxDatatypes } = this.sizes;
            // physical type QUADS, table sizes, protocol version 2 (Jelly 1.1)
            rows.push(len(ROW.options, Buffer.concat([num(2, QUADS), num(9, maxNames), num(10, maxPrefixes), num(11, maxDatatypes), num(15, 2)])));
        }
        // Per frame: nothing is relative to a statement of an earlier frame
        let previous = [];
        let lastPrefix = 0;
        let lastName = 0;
        let explicit = true;
        const iri = (value) => {
            const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("#")) + 1;
            const prefix = this.prefixes.get(value.slice(0, cut));
            const name = this.names.get(value.slice(cut));
            if (prefix.added) rows.push(len(ROW.prefix, Buffer.concat([num(1, prefix.id), text(2, value.slice(0, cut))])));
            if (name.added) rows.push(len(ROW.name, Buffer.concat([num(1, name.id), text(2, value.slice(cut))])));
            const prefixId = !explicit && prefix.id === lastPrefix ? 0 : prefix.id;
            const nameId = !explicit && name.id === lastName + 1 ? 0 : name.id;
            explicit = false;
            lastPrefix = prefix.id;
            lastName = name.id;
            return Buffer.concat([num(1, prefixId), num(2, nameId)]);
        };
        // slot 0..3: the field numbers of an IRI, blank node, literal and default graph in that slot
        const FIELDS = [
            { iri: 1, bnode: 2, literal: 3 },
            { iri: 5, bnode: 6, literal: 7 },
            { iri: 9, bnode: 10, literal: 11 },
            { iri: 13, bnode: 14, literal: 16, defaultGraph: 15 },
        ];
        const term = (t, slot) => {
            const f = FIELDS[slot];
            if (t.termType === "NamedNode") return len(f.iri, iri(t.value));
            if (t.termType === "BlankNode") return text(f.bnode, t.value);
            if (t.termType === "DefaultGraph") return len(f.defaultGraph, Buffer.alloc(0));
            if (t.termType === "Literal") {
                let tail = Buffer.alloc(0);
                if (t.language) tail = text(2, t.language);
                else if (t.datatype.value !== XSD_STRING) {
                    const datatype = this.datatypes.get(t.datatype.value);
                    if (datatype.added) rows.push(len(ROW.datatype, Buffer.concat([num(1, datatype.id), text(2, t.datatype.value)])));
                    tail = num(3, datatype.id);
                }
                return len(f.literal, Buffer.concat([text(1, t.value), tail]));
            }
            throw new Error(`Unsupported term ${t.termType}`);
        };
        for (const quad of quads) {
            const terms = [quad.subject, quad.predicate, quad.object, quad.graph];
            const parts = terms.map((t, slot) => (previous[slot] && previous[slot].equals(t) ? Buffer.alloc(0) : term(t, slot)));
            rows.push(len(ROW.quad, Buffer.concat(parts)));
            previous = terms;
        }
        const frame = Buffer.concat(rows.map((row) => len(1, row)));
        return Buffer.concat([varint(frame.length), frame]);
    }
}
