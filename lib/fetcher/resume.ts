/**
 * Continuing a page with an HTTP Range request (draft, see https://github.com/SEMICeu/LinkedDataEventStreams/issues/119).
 *
 * A page with `ldes:rangeRequests true` opts in to this: every response (per media type, without Content-Encoding) is a
 * byte prefix of every later one, and it always ends at the end of a complete RDF Message. A file that is compressed
 * itself only grows by new gzip members (incremental compression). A client that read N bytes can therefore request
 * `Range: bytes=N-` and get only the messages that were appended.
 *
 * Those bytes cannot be parsed on their own: they depend on the state of the parser at byte N.
 * - Turtle family (TriG, N-Quads, ...): the `VERSION` that announces messages, and the prefixes.
 * - Jelly-RDF: the stream options, and the lookup tables of prefixes, names and datatypes.
 * The client keeps that state as a *preamble*: bytes in the same serialization that put a fresh parser in that state
 * without producing any statement. The appended bytes are parsed as `preamble + appended`, with an unmodified parser.
 *
 * Jelly 1.1 also has state that is not in the lookup tables: a statement can leave out a term that is the same as in the
 * previous statement, and a prefix or name identifier 0 refers to the previous identifier. A preamble cannot restore
 * that, so the first statement of the first appended frame must not depend on it. That is checked before anything is
 * parsed: when it does depend on it, the page is read again from the start.
 * Jelly 1.2 (column batches) has no such state: the lookup tables are all that crosses batches. A publisher only has to
 * end every publication at the end of a batch (flush), which is also the end of a message.
 */

/** Bytes before the resume offset that are requested again, to check that the page still starts with what was read */
export const OVERLAP = 32;

/** What the client keeps of a page with range requests, to request only what was appended to it */
export type ResumeState = {
    /** The byte offset, in the representation without Content-Encoding, after the last complete RDF Message */
    offset: number;
    /** The media type of the response, without parameters: the bytes are only the same for the same media type */
    contentType: string;
    /** The RDF serialization inside it, as the parser read it (the same as `contentType`, unless the file is compressed) */
    syntax: string;
    /**
     * The file itself is gzip compressed (not a Content-Encoding): it can be continued when the publisher appends new gzip
     * members to it, so that the offset is the end of a member
     */
    compression?: "gzip";
    /** Base64: what is parsed before the appended bytes, to give the parser the state that it had at the offset (uncompressed) */
    preamble: string;
    /** Base64: the last bytes before the offset (at most {@link OVERLAP}) */
    tail: string;
};

/** The resume state is not valid any more: the page is not what it was, or the server does not keep its promise */
export class ResumeInvalid extends Error {}

type Format = "turtle" | "jelly";

const TURTLE_FAMILY = ["application/trig", "application/n-quads", "text/turtle", "application/n-triples"];
export const JELLY = "application/x-jelly-rdf";

export function baseType(contentType: string | null | undefined): string {
    return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function formatOf(syntax: string | undefined): Format | undefined {
    if (syntax && TURTLE_FAMILY.includes(syntax)) return "turtle";
    if (syntax === JELLY) return "jelly";
    return undefined;
}

/** Compresses bytes as one gzip member */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Follows the bytes of one transfer of a page, to tell where the next request can continue.
 * It counts the bytes of the response body (which `fetch` has already decoded when it had a Content-Encoding: that is
 * the representation the offset applies to), and reads what is needed to build the preamble from the bytes the parser
 * reads (after decompression of a compressed file).
 */
export class ResumeTracker {
    private syntax?: string;
    private format?: Format;
    private readonly base: number;
    private readonly preamble: Uint8Array;
    private bytes = 0;
    private tail: Uint8Array;
    private head: Uint8Array = new Uint8Array(0);
    private compression?: "gzip" | "zstd";
    private readonly prefixes = new Map<string, string>();
    private jelly?: JellyScanner;

    /**
     * @param contentType the media type of the response
     * @param resumed when the transfer continues an earlier one: its offset, preamble, the bytes before the offset, and the compression
     */
    constructor(
        readonly contentType: string,
        resumed?: { offset: number; preamble: Uint8Array; tail: Uint8Array; compression?: "gzip" },
    ) {
        this.base = resumed?.offset ?? 0;
        this.preamble = resumed?.preamble ?? new Uint8Array(0);
        this.tail = resumed?.tail ?? new Uint8Array(0);
        this.compression = resumed?.compression;
    }

    /**
     * The body as it is received: the preamble, followed by the bytes of the response. The preamble of a gzip file is
     * compressed as a gzip member of its own, so that it is decompressed together with the members that were appended.
     */
    stream(): TransformStream<Uint8Array, Uint8Array> {
        return new TransformStream<Uint8Array, Uint8Array>({
            start: async (controller) => {
                if (this.preamble.length > 0) controller.enqueue(this.compression === "gzip" ? await gzip(this.preamble) : this.preamble);
            },
            transform: (chunk, controller) => {
                this.observe(chunk);
                controller.enqueue(chunk);
            },
        });
    }

    /** The serialization that the parser reads, once it is known */
    setSyntax(syntax: string) {
        this.syntax = baseType(syntax);
        this.format = formatOf(this.syntax);
        if (this.format === "jelly") this.jelly ??= new JellyScanner();
    }

    /** Whether the bytes that the parser reads need to be scanned (Jelly: for the lookup tables) */
    get scans(): boolean {
        return this.jelly !== undefined;
    }

    /** Bytes as the parser reads them: the preamble and the response body, decompressed */
    scan(chunk: Uint8Array) {
        this.jelly?.push(chunk);
    }

    /** A prefix that the parser read: a preamble declares it again */
    prefix(prefix: string, iri: string) {
        this.prefixes.set(prefix, iri);
    }

    private observe(chunk: Uint8Array) {
        if (this.base === 0 && this.head.length < 4) {
            this.head = concat(this.head, chunk.subarray(0, 4 - this.head.length));
            const h = this.head;
            if (h[0] === 0x1f && h[1] === 0x8b) this.compression = "gzip";
            else if (h[0] === 0x28 && h[1] === 0xb5 && h[2] === 0x2f && h[3] === 0xfd) this.compression = "zstd";
        }
        this.bytes += chunk.length;
        this.tail = concat(this.tail.subarray(Math.max(0, this.tail.length + chunk.length - OVERLAP)), chunk.subarray(-OVERLAP));
    }

    /**
     * Where a next request continues, when the transfer was read completely. Undefined when the page cannot be continued:
     * a serialization without a preamble, a zstd file (Node.js only decompresses its first frame), a Turtle document
     * without messages, an unfinished Jelly frame...
     * @param framed whether the serialization had message delimiters
     */
    state(framed: boolean): ResumeState | undefined {
        if (!this.format || !this.syntax || this.compression === "zstd") return undefined;
        let preamble: Uint8Array;
        if (this.format === "jelly") {
            if (!this.jelly!.ok || this.jelly!.leftover > 0) return undefined;
            const built = this.jelly!.preamble();
            if (!built) return undefined;
            preamble = built;
        } else {
            // A document without messages is one message: appending to it would change that message
            if (!framed) return undefined;
            preamble = turtlePreamble(this.syntax, this.prefixes);
        }
        return {
            offset: this.base + this.bytes,
            contentType: this.contentType,
            syntax: this.syntax,
            ...(this.compression && { compression: this.compression }),
            preamble: toBase64(preamble),
            tail: toBase64(this.tail),
        };
    }
}

/** The VERSION that announces messages, and the prefixes (only Turtle and TriG have them) */
function turtlePreamble(contentType: string, prefixes: Map<string, string>): Uint8Array {
    let text = 'VERSION "1.2-messages"\n';
    if (contentType === "application/trig" || contentType === "text/turtle") {
        for (const [prefix, iri] of prefixes) text += `PREFIX ${prefix}: <${iri}>\n`;
    }
    return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------------------------------------------------
// Jelly-RDF: a delimited stream of RdfStreamFrames. Only what is needed for a preamble is read: the options row, and the
// lookup entries. Statements are skipped without being decoded; the parsing itself is done by rdfjs-jelly.
// Field numbers are those of rdf.proto:
// - Jelly 1.1 (protocol version 1, 2): rows; a lookup entry is a row of its own (name, prefix, datatype).
// - Jelly 1.2 (protocol version 3): column batches (field 2 of the frame), each with the lookup entries it adds, as runs
//   of consecutive identifiers (RdfLookupEntryPacked). The lookup tables are the only state that crosses batches.

const ROW = { options: 1, triple: 2, quad: 3, graphStart: 4, graphEnd: 5, name: 9, prefix: 10, datatype: 11 } as const;
const OPTIONS = { physicalType: 2, maxPrefixTableSize: 10, version: 15 } as const;
const FRAME = { rows: 1, columns: 2 } as const;
/** The lookup tables, with their field number in a Jelly 1.1 row and in a Jelly 1.2 column batch */
const TABLES = {
    prefix: { row: ROW.prefix, column: 3 },
    name: { row: ROW.name, column: 2 },
    datatype: { row: ROW.datatype, column: 4 },
} as const;
type TableName = keyof typeof TABLES;
const PHYSICAL_QUADS = 2;
const COLUMN_VERSION = 3;

type Table = { entries: Map<number, string>; last: number };

/** Reads the frames of a Jelly stream as they arrive, and keeps the stream options and the lookup tables */
export class JellyScanner {
    ok = true;
    private pending: Uint8Array = new Uint8Array(0);
    private options?: Uint8Array;
    private version = 0;
    private readonly tables = new Map<TableName, Table>((Object.keys(TABLES) as TableName[]).map((name) => [name, { entries: new Map(), last: 0 }]));

    /** Bytes of a frame that is not complete yet */
    get leftover() {
        return this.pending.length;
    }

    push(chunk: Uint8Array) {
        if (!this.ok) return;
        const buffer = this.pending.length > 0 ? concat(this.pending, chunk) : chunk;
        let pos = 0;
        try {
            while (pos < buffer.length) {
                const frame = nextFrame(buffer, pos);
                if (!frame) break;
                this.frame(buffer.subarray(frame.start, frame.end));
                pos = frame.end;
            }
        } catch {
            this.ok = false;
        }
        this.pending = buffer.slice(pos);
    }

    private frame(frame: Uint8Array) {
        for (const field of fields(frame)) {
            if (field.number === FRAME.columns && field.bytes) {
                if (this.version !== COLUMN_VERSION) throw new Error("A column batch in a stream that is not Jelly 1.2");
                this.columnBatch(field.bytes);
                continue;
            }
            if (field.number !== FRAME.rows || !field.bytes) continue;
            const row = fields(field.bytes).next().value;
            if (!row?.bytes) continue;
            if (row.number === ROW.options) {
                const version = readUint(row.bytes, OPTIONS.version);
                if (version > COLUMN_VERSION) throw new Error(`Jelly protocol version ${version} cannot be resumed`);
                this.version ||= version;
                this.options ??= row.bytes.slice();
            } else if (!this.options) {
                throw new Error("A Jelly stream starts with its options");
            } else {
                const name = (Object.keys(TABLES) as TableName[]).find((table) => TABLES[table].row === row.number);
                if (!name) continue;
                let id = 0;
                let value = "";
                for (const entry of fields(row.bytes)) {
                    if (entry.number === 1) id = entry.value;
                    else if (entry.number === 2 && entry.bytes) value = new TextDecoder().decode(entry.bytes);
                }
                this.assign(name, id, [value]);
            }
        }
    }

    /** The lookup entries of a Jelly 1.2 column batch: runs of values for consecutive identifiers */
    private columnBatch(batch: Uint8Array) {
        if (!this.options) throw new Error("A Jelly stream starts with its options");
        for (const field of fields(batch)) {
            const name = (Object.keys(TABLES) as TableName[]).find((table) => TABLES[table].column === field.number);
            if (!name || !field.bytes) continue;
            let id = 0;
            const values: string[] = [];
            for (const part of fields(field.bytes)) {
                if (part.number === 1) id = part.value;
                else if (part.number === 2 && part.bytes) values.push(new TextDecoder().decode(part.bytes));
            }
            this.assign(name, id, values);
        }
    }

    /** Assigns values to consecutive identifiers from `id`; identifier 0 is the one after the last assigned */
    private assign(name: TableName, id: number, values: string[]) {
        const table = this.tables.get(name)!;
        values.forEach((value, i) => {
            const index = i === 0 && id !== 0 ? id : table.last + 1;
            table.entries.set(index, value);
            table.last = index;
        });
    }

    /**
     * One frame with the options row, and every lookup entry with its identifier. The entry that was assigned last
     * comes last in its table, so that an entry with identifier 0 (the one after the last) means the same afterwards.
     * It has no statements: parsing it gives an empty message (Jelly 1.1) or none (Jelly 1.2).
     */
    preamble(): Uint8Array | undefined {
        if (!this.options) return undefined;
        const parts = [field(FRAME.rows, field(ROW.options, this.options))];
        if (this.version === COLUMN_VERSION) {
            // Jelly 1.2: one column batch without statements, with the entries as runs of consecutive identifiers
            const entries: Uint8Array[] = [];
            for (const [name, table] of this.tables) {
                for (const run of runs(table)) {
                    const values = run.values.map((value) => field(2, new TextEncoder().encode(value)));
                    entries.push(field(TABLES[name].column, concat(varintField(1, run.id), ...values)));
                }
            }
            if (entries.length > 0) parts.push(field(FRAME.columns, concat(...entries)));
        } else {
            // Jelly 1.1: a row for every entry
            for (const [name, table] of this.tables) {
                for (const run of runs(table)) {
                    run.values.forEach((value, i) => {
                        const entry = concat(varintField(1, run.id + i), field(2, new TextEncoder().encode(value)));
                        parts.push(field(FRAME.rows, field(TABLES[name].row, entry)));
                    });
                }
            }
        }
        const frame = concat(...parts);
        return concat(varint(frame.length), frame);
    }
}

/**
 * The entries of a table as runs of consecutive identifiers, in order, except that the entry that was assigned last is
 * a run of its own at the end
 */
function runs(table: Table): { id: number; values: string[] }[] {
    const ids = [...table.entries.keys()].filter((id) => id !== table.last).sort((a, b) => a - b);
    const out: { id: number; values: string[] }[] = [];
    for (const id of ids) {
        const previous = out.at(-1);
        if (previous && previous.id + previous.values.length === id) previous.values.push(table.entries.get(id)!);
        else out.push({ id, values: [table.entries.get(id)!] });
    }
    if (table.entries.has(table.last)) out.push({ id: table.last, values: [table.entries.get(table.last)!] });
    return out;
}

/**
 * Checks that the first appended frame can be read with only the stream options and the lookup tables: its first
 * statement gives all its terms, and its first IRI has an explicit prefix and name identifier.
 * @param preamble the preamble, for the stream options
 * @param appended the first bytes that were appended, at least one complete frame (or all there is)
 * @returns undefined when the frame can be read, otherwise the reason why not
 */
export function checkJellyResume(preamble: Uint8Array, appended: Uint8Array): string | undefined {
    const optionsFrame = nextFrame(preamble, 0);
    const optionsRow = optionsFrame && fields(fields(preamble.subarray(optionsFrame.start, optionsFrame.end)).next().value!.bytes!).next().value;
    if (!optionsRow?.bytes) return "the preamble has no stream options";
    // Jelly 1.2: a column batch depends on nothing of the batches before it but the lookup tables, which the preamble has
    if (readUint(optionsRow.bytes, OPTIONS.version) === COLUMN_VERSION) return undefined;
    const quads = readUint(optionsRow.bytes, OPTIONS.physicalType) === PHYSICAL_QUADS;
    const prefixes = readUint(optionsRow.bytes, OPTIONS.maxPrefixTableSize) > 0;

    const frame = nextFrame(appended, 0);
    if (!frame) return undefined; // nothing was appended, or not a complete frame: the parser reports that
    for (const row of fields(appended.subarray(frame.start, frame.end))) {
        if (row.number !== 1 || !row.bytes) continue;
        const content = fields(row.bytes).next().value;
        if (!content?.bytes) continue;
        if (content.number === ROW.graphStart || content.number === ROW.graphEnd) return "the frame continues a graph";
        if (content.number !== ROW.triple && content.number !== ROW.quad) continue;
        const slots = new Set<number>();
        let firstIri: Uint8Array | undefined;
        for (const term of fields(content.bytes)) {
            // 1-4 subject, 5-8 predicate, 9-12 object, 13-16 graph
            slots.add(Math.ceil(term.number / 4));
            if ((term.number === 1 || term.number === 5 || term.number === 9 || term.number === 13) && !firstIri) firstIri = term.bytes;
            if (term.number === 4 || term.number === 8 || term.number === 12) return "the first statement has a triple term";
        }
        if (slots.size < (quads ? 4 : 3)) return "the first statement repeats a term of the statement before it";
        if (firstIri) {
            if (readUint(firstIri, 2) === 0) return "the first IRI refers to the name identifier before it";
            if (prefixes && readUint(firstIri, 1) === 0) return "the first IRI refers to the prefix identifier before it";
        }
        return undefined;
    }
    return undefined;
}

/** The position of the next delimited frame, when it is complete */
export function nextFrame(buffer: Uint8Array, pos: number): { start: number; end: number } | undefined {
    const length = readVarint(buffer, pos);
    if (!length) return undefined;
    const end = length.next + length.value;
    if (end > buffer.length) return undefined;
    return { start: length.next, end };
}

type Field = { number: number; value: number; bytes?: Uint8Array };

function* fields(buffer: Uint8Array): Generator<Field> {
    let pos = 0;
    while (pos < buffer.length) {
        const tag = readVarint(buffer, pos);
        if (!tag) throw new Error("Truncated field");
        pos = tag.next;
        const number = Math.floor(tag.value / 8);
        const wireType = tag.value & 7;
        if (wireType === 0) {
            const value = readVarint(buffer, pos);
            if (!value) throw new Error("Truncated varint");
            pos = value.next;
            yield { number, value: value.value };
        } else if (wireType === 2) {
            const length = readVarint(buffer, pos);
            if (!length || length.next + length.value > buffer.length) throw new Error("Truncated field");
            pos = length.next + length.value;
            yield { number, value: 0, bytes: buffer.subarray(length.next, pos) };
        } else if (wireType === 1 || wireType === 5) {
            pos += wireType === 1 ? 8 : 4;
        } else {
            throw new Error(`Unsupported wire type ${wireType}`);
        }
    }
}

function readUint(buffer: Uint8Array, number: number): number {
    let value = 0;
    for (const field of fields(buffer)) if (field.number === number && field.bytes === undefined) value = field.value;
    return value;
}

function readVarint(buffer: Uint8Array, pos: number): { value: number; next: number } | undefined {
    let value = 0;
    let multiplier = 1;
    for (let i = pos; i < buffer.length && i < pos + 10; i++) {
        value += (buffer[i] & 0x7f) * multiplier;
        multiplier *= 128;
        if ((buffer[i] & 0x80) === 0) return { value, next: i + 1 };
    }
    return undefined;
}

function varint(value: number): Uint8Array {
    const bytes: number[] = [];
    while (value >= 0x80) {
        bytes.push((value % 128) | 0x80);
        value = Math.floor(value / 128);
    }
    bytes.push(value);
    return Uint8Array.from(bytes);
}

function varintField(number: number, value: number): Uint8Array {
    return concat(varint(number * 8), varint(value));
}

function field(number: number, bytes: Uint8Array): Uint8Array {
    return concat(varint(number * 8 + 2), varint(bytes.length), bytes);
}

// ---------------------------------------------------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Reads the first bytes of a body (all there are, when it is shorter), and gives the body that remains after them.
 * @param wanted the number of bytes that are wanted, given what has been read so far
 */
export async function readHead(
    body: ReadableStream<Uint8Array>,
    wanted: (read: Uint8Array) => number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
    const reader = body.getReader();
    let read: Uint8Array = new Uint8Array(0);
    let done = false;
    while (!done && read.length < wanted(read)) {
        const next = await reader.read();
        if (next.done) done = true;
        else read = concat(read, next.value);
    }
    const head = read.subarray(0, Math.min(wanted(read), read.length));
    const remainder = read.subarray(head.length);
    const rest = new ReadableStream<Uint8Array>({
        start(controller) {
            if (remainder.length > 0) controller.enqueue(remainder);
            if (done) controller.close();
        },
        async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return { head, rest };
}

/** A body that starts with the given bytes, followed by another body */
export function prependBytes(bytes: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
        },
        async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}
