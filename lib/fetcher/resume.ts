/**
 * Continuing a page with an HTTP Range request (draft, see https://github.com/SEMICeu/LinkedDataEventStreams/issues/119).
 *
 * A page with `ldes:rangeRequests true` opts in to this: every response (per media type, without Content-Encoding) is a
 * byte prefix of every later one, and it always ends at the end of a complete RDF Message. A file that is compressed
 * itself only grows by new gzip members (incremental compression). A client that read N bytes can therefore request
 * `Range: bytes=N-` and get only the messages that were appended.
 *
 * Those bytes cannot be parsed on their own: they depend on the state of the parser at byte N (the prefixes of a TriG
 * message log, the lookup tables of a Jelly stream, ...). ldfetch hands that state over at the end of a parse of an RDF
 * Message log, and takes it back to continue it. The client keeps it as it is, without looking into it.
 */

/** Bytes before the resume offset that are requested again, to check that the page still starts with what was read */
export const OVERLAP = 32;

/** The parser state at the end of an RDF Message log (ldfetch's `parserState`): JSON data the client does not read */
export type ParserState = Record<string, unknown>;

/** What the client keeps of a page with range requests, to request only what was appended to it */
export type ResumeState = {
    /** The byte offset, in the representation without Content-Encoding, after the last complete RDF Message */
    offset: number;
    /** The media type of the response, without parameters: the bytes are only the same for the same media type */
    contentType: string;
    /**
     * The file itself is gzip compressed (not a Content-Encoding): it can be continued when the publisher appends new gzip
     * members to it, so that the offset is the end of a member
     */
    compression?: "gzip";
    /** The parser state at the offset, from which the parser continues */
    parserState: ParserState;
    /** Base64: the last bytes before the offset (at most {@link OVERLAP}) */
    tail: string;
};

/** The resume state is not valid any more: the page is not what it was, or the server does not keep its promise */
export class ResumeInvalid extends Error {}

export function baseType(contentType: string | null | undefined): string {
    return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Follows the bytes of one transfer of a page, to tell where the next request can continue.
 * It counts the bytes of the response body (which `fetch` has already decoded when it had a Content-Encoding: that is
 * the representation the offset applies to), and keeps the parser state that ldfetch gives at the end.
 */
export class ResumeTracker {
    private readonly base: number;
    private bytes = 0;
    private tail: Uint8Array;
    private head: Uint8Array = new Uint8Array(0);
    private compression?: "gzip" | "zstd";
    private parserState?: ParserState;

    /**
     * @param contentType the media type of the response
     * @param resumed when the transfer continues an earlier one: its offset, the bytes before the offset, and the compression
     */
    constructor(
        readonly contentType: string,
        resumed?: { offset: number; tail: Uint8Array; compression?: "gzip" },
    ) {
        this.base = resumed?.offset ?? 0;
        this.tail = resumed?.tail ?? new Uint8Array(0);
        this.compression = resumed?.compression;
    }

    /** Counts the bytes of the response body as they pass */
    stream(): TransformStream<Uint8Array, Uint8Array> {
        return new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
                this.observe(chunk);
                controller.enqueue(chunk);
            },
        });
    }

    /** The parser state at the end of the parse */
    setParserState(state: ParserState) {
        this.parserState = state;
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
     * ldfetch gave no parser state (not an RDF Message log), or a zstd file (Node.js only decompresses its first frame).
     */
    state(): ResumeState | undefined {
        if (!this.parserState || this.compression === "zstd") return undefined;
        return {
            offset: this.base + this.bytes,
            contentType: this.contentType,
            ...(this.compression && { compression: this.compression }),
            parserState: this.parserState,
            tail: toBase64(this.tail),
        };
    }
}

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

/** Reads the first `length` bytes of a body (all there are, when it is shorter), and gives the body that remains after them */
export async function readHead(body: ReadableStream<Uint8Array>, length: number): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
    const reader = body.getReader();
    let read: Uint8Array = new Uint8Array(0);
    let done = false;
    while (!done && read.length < length) {
        const next = await reader.read();
        if (next.done) done = true;
        else read = concat(read, next.value);
    }
    const head = read.subarray(0, Math.min(length, read.length));
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
