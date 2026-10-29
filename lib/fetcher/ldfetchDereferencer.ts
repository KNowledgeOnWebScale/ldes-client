import { Readable } from "stream";
import RdfParsers from "ldfetch/lib/RdfParsers.js";
import { FetchDocumentLoader } from "jsonld-context-parser";
import { JsonLdParser } from "jsonld-streaming-parser";
import { getLoggerFor } from "../utils/logUtil";

import type { Quad, Stream } from "@rdfjs/types";
import type { EventEmitter } from "events";

const logger = getLoggerFor("LdfetchDereferencer");

/**
 * Preference order: serializations that carry named graphs and RDF Messages come first.
 * Jelly-RDF is a compact binary RDF Message serialization.
 * NDJSON-LD is not supported by ldfetch (yet), so it is not advertised.
 */
export const DEFAULT_ACCEPT = [
    "application/trig",
    "application/n-quads;q=0.95",
    "application/x-jelly-rdf;q=0.95",
    "application/ld+json;q=0.9",
    "text/turtle;q=0.9",
    "application/n-triples;q=0.8",
    "application/rdf+xml;q=0.7",
    "text/n3;q=0.5",
].join(", ");

export const ORIGINAL_STATUS_HEADER = "x-ldes-client-original-status";

export type DereferenceOptions = {
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    localFiles?: boolean;
    /** How many messages of the log are buffered before the source is paused (default {@link MAX_BUFFERED_MESSAGES}) */
    bufferedMessages?: number;
};

/**
 * Result of dereferencing an IRI into one RDF dataset (all messages merged).
 */
export type DereferenceOutput = {
    url: string;
    data: Stream;
    headers: Headers;
    status: number;
};

/**
 * Anything that can dereference an IRI to a quad stream.
 * This is the part of rdf-dereference that the LDES client (and extract-cbd-shape) depend on.
 */
export interface Dereferencer {
    dereference(url: string, options?: DereferenceOptions): Promise<DereferenceOutput>;
}

/** A dereferencer that can also read an IRI as an RDF Message log, which LDES 2.0 pages are */
export interface MessageDereferencer extends Dereferencer {
    dereferenceMessages(url: string, options?: DereferenceOptions): Promise<MessageLog>;
}

const CONTEXT_TTL = 10 * 60 * 1000;
const MAX_CACHED_CONTEXTS = 100;

const JSON_TYPES = ["application/ld+json", "application/json"];

export const MAX_BUFFERED_MESSAGES = 512;

/**
 * An RDF Message log, read as a stream of messages (each an array of quads).
 *
 * A document without a notion of messages (such as plain Turtle) is read as a log of exactly one message,
 * as the LDES 2.0 specification prescribes. An empty such document is a log without messages.
 * Empty messages in a message-framed document are surfaced as empty arrays,
 * so that the caller can decide whether they are allowed.
 */
export class MessageLog implements AsyncIterable<Quad[]> {
    public readonly url: string;
    public readonly status: number;
    public readonly headers: Headers;
    public readonly contentType: string;
    /** Whether the serialization of the response has its own message delimiters */
    public framed = false;
    /** The number of messages that are buffered before the source is paused. It can be changed while reading. */
    public maxBuffered = MAX_BUFFERED_MESSAGES;

    private queue: Quad[][] = [];
    private ended = false;
    private failure?: unknown;
    private wake?: () => void;
    private source?: Readable;
    private paused = false;

    constructor(
        url: string,
        status: number,
        headers: Headers,
        contentType: string,
    ) {
        this.url = url;
        this.status = status;
        this.headers = headers;
        this.contentType = contentType;
    }

    /** A log without any messages, e.g. for 410 Gone */
    static empty(url: string, status: number, headers: Headers): MessageLog {
        const log = new MessageLog(url, status, headers, "");
        log.ended = true;
        return log;
    }

    /** @internal wires the parser output of ldfetch to this log */
    attach(parser: EventEmitter, source: Readable) {
        this.source = source;
        const unframed: Quad[] = [];
        parser
            .on("data", (quad: Quad, messageCounter?: number) => {
                if (messageCounter === undefined) {
                    unframed.push(quad);
                }
            })
            .on("message", (quads: Quad[]) => {
                this.framed = true;
                this.push(quads);
            })
            .on("error", (error: unknown) => {
                this.failure = error;
                this.finish();
            })
            .on("end", () => {
                if (!this.framed && unframed.length > 0) {
                    this.push(unframed);
                }
                this.finish();
            });
    }

    private push(message: Quad[]) {
        this.queue.push(message);
        if (this.queue.length >= this.maxBuffered && !this.paused) {
            this.paused = true;
            this.source?.pause();
        }
        this.notify();
    }

    private finish() {
        this.ended = true;
        this.notify();
    }

    private notify() {
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }

    /** Reads the next message, or undefined when the log is finished */
    async next(): Promise<Quad[] | undefined> {
        while (true) {
            if (this.queue.length > 0) {
                const message = this.queue.shift()!;
                if (this.paused && this.queue.length < this.maxBuffered / 2) {
                    this.paused = false;
                    this.source?.resume();
                }
                return message;
            }
            if (this.failure) {
                throw this.failure;
            }
            if (this.ended) {
                return undefined;
            }
            await new Promise<void>((resolve) => (this.wake = resolve));
        }
    }

    /** Stop reading, and release the connection */
    close() {
        this.queue = [];
        this.ended = true;
        this.source?.destroy();
        this.notify();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Quad[]> {
        try {
            while (true) {
                const message = await this.next();
                if (!message) return;
                yield message;
            }
        } finally {
            this.close();
        }
    }
}

/**
 * Dereferences IRIs to RDF using the parsers of ldfetch: N3.js with RDF Message support (Turtle, TriG, N-Triples,
 * N-Quads), JSON-LD, RDF/XML, HTML and Jelly-RDF, with automatic decompression and content type sniffing.
 *
 * The HTTP layer is the `fetch` function that is given in the options (the client's retrying fetch),
 * so that HTTP semantics such as redirects, status codes, ETags and authentication stay in the hands of the client.
 */
export class LdfetchDereferencer implements MessageDereferencer {
    /**
     * External JSON-LD contexts, which clients SHOULD cache: the pages of an LDES usually share them.
     * ldfetch creates a new document loader for every document, which does not cache.
     */
    private contexts = new Map<string, { loaded: ReturnType<FetchDocumentLoader["load"]>; expires: number }>();

    constructor(private readonly accept: string = DEFAULT_ACCEPT) {}

    private cachedDocumentLoader(fetch_f: typeof fetch) {
        const loader = new FetchDocumentLoader(fetch_f);
        return {
            load: (url: string) => {
                const now = Date.now();
                let entry = this.contexts.get(url);
                if (!entry || entry.expires < now) {
                    const loaded = loader.load(url);
                    entry = { loaded, expires: now + CONTEXT_TTL };
                    if (this.contexts.size >= MAX_CACHED_CONTEXTS) {
                        this.contexts.delete(this.contexts.keys().next().value!);
                    }
                    this.contexts.set(url, entry);
                    loaded.catch(() => this.contexts.delete(url));
                }
                return entry.loaded;
            },
        };
    }

    /** Dereferences an IRI to a stream of quads, in which all messages (if any) are merged */
    async dereference(
        url: string,
        options: DereferenceOptions = {},
    ): Promise<DereferenceOutput> {
        const log = await this.dereferenceMessages(url, options);
        const data = new Readable({ objectMode: true, read() {} });
        (async () => {
            try {
                for await (const message of log) {
                    for (const quad of message) data.push(quad);
                }
                data.push(null);
            } catch (ex) {
                data.destroy(ex as Error);
            }
        })();
        return {
            url: log.url,
            data: data as unknown as Stream,
            headers: log.headers,
            status: log.status,
        };
    }

    /** Dereferences an IRI to an RDF Message log */
    async dereferenceMessages(
        url: string,
        options: DereferenceOptions = {},
    ): Promise<MessageLog> {
        if (!/^https?:\/\//i.test(url)) {
            return this.dereferenceFile(url, options);
        }

        const headers = new Headers(options.headers);
        if (!headers.has("accept")) {
            headers.set("accept", this.accept);
        }
        const response = await (options.fetch ?? fetch)(url, { headers });

        const originalStatus = Number(
            response.headers.get(ORIGINAL_STATUS_HEADER) ?? response.status,
        );
        if (response.status >= 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Could not dereference ${url}: HTTP ${response.status}`);
        }
        if (originalStatus === 304 || originalStatus === 410 || !response.body) {
            // The client's fetch hides these statuses behind an empty 200 response
            await response.body?.cancel().catch(() => undefined);
            return MessageLog.empty(response.url || url, originalStatus, response.headers);
        }

        const finalUrl = response.url || url;
        const source = Readable.fromWeb(response.body as never);
        const log = await this.parse(
            source,
            finalUrl,
            url,
            response.status,
            response.headers,
            response.headers.get("content-type") ?? "",
            response.headers.get("content-disposition"),
            options.fetch ?? fetch,
        );
        if (options.bufferedMessages !== undefined) log.maxBuffered = options.bufferedMessages;
        return log;
    }

    private async dereferenceFile(
        location: string,
        options: DereferenceOptions,
    ): Promise<MessageLog> {
        if (!options.localFiles) {
            throw new Error(
                `Tried to read local file ${location} without enabling localFiles`,
            );
        }
        const { createReadStream } = await import("fs");
        const { fileURLToPath, pathToFileURL } = await import("url");
        const { resolve } = await import("path");
        const path = location.startsWith("file://")
            ? fileURLToPath(location)
            : resolve(location);
        const source = createReadStream(path);
        const url = pathToFileURL(path).href;
        const log = await this.parse(source, url, url, 200, new Headers(), "", null, options.fetch ?? fetch);
        if (options.bufferedMessages !== undefined) log.maxBuffered = options.bufferedMessages;
        return log;
    }

    private async parse(
        source: Readable,
        url: string,
        requestUrl: string,
        status: number,
        headers: Headers,
        declaredType: string,
        contentDisposition: string | null,
        fetch_f: typeof fetch,
    ): Promise<MessageLog> {
        const base = declaredType.split(";")[0].trim();
        const prepared = await RdfParsers.prepareStream(source, {
            contentType: base || "application/octet-stream",
            url,
            requestUrl,
            contentDisposition,
        });
        const contentType = RdfParsers.resolveContentType(
            prepared.contentType,
            url,
            requestUrl,
        );
        logger.debug(`Parsing ${url} as ${contentType}`);

        const log = new MessageLog(url, status, headers, contentType);
        let parser: EventEmitter;
        if (RdfParsers.isStreamable(contentType)) {
            parser = RdfParsers.parseStream(prepared.stream, {
                contentType,
                baseIRI: url,
            });
        } else if (JSON_TYPES.includes(contentType.split(";")[0].trim())) {
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                prepared.stream
                    .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
                    .on("end", resolve)
                    .on("error", reject);
            });
            const jsonld = new JsonLdParser({
                baseIRI: url,
                documentLoader: this.cachedDocumentLoader(fetch_f),
            });
            jsonld.write(Buffer.concat(chunks).toString("utf8"));
            jsonld.end();
            parser = jsonld as unknown as EventEmitter;
        } else {
            // No incremental parser for this serialization (e.g. RDF/XML): buffer the body
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                prepared.stream
                    .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
                    .on("end", resolve)
                    .on("error", reject);
            });
            const bodyBuffer = Buffer.concat(chunks);
            parser = RdfParsers.parse({
                bodyText: bodyBuffer.toString("utf8"),
                bodyBuffer,
                contentType,
                baseIRI: url,
                requestUrl,
            });
        }
        log.attach(parser, prepared.stream);
        return log;
    }
}

export const ldfetchDereferencer = new LdfetchDereferencer();
