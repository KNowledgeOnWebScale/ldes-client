import { Readable } from "stream";
import RdfParsers from "ldfetch/lib/RdfParsers.js";
import { JsonLdParser } from "jsonld-streaming-parser";
import { getLoggerFor } from "../utils/logUtil";
import { errorMessage } from "../utils/general";
import { ContextCache, uncachedDocumentLoader } from "./contextCache";

import type { Quad, Stream } from "@rdfjs/types";
import type { EventEmitter } from "events";
import type HttpCache from "ldfetch/lib/HttpCache.js";
import type { ContextCacheOptions } from "./contextCache";

const logger = getLoggerFor("LdfetchDereferencer");

const isCloudflareWorker = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const isNode = !isCloudflareWorker && typeof process !== "undefined" && !!process.versions?.node;

/**
 * A readable of a web stream. Node.js has Readable.fromWeb. The polyfills of `stream` for browsers do not have a working
 * one (readable-stream defines it, but it throws), so there the stream is read through its reader.
 */
function toReadable(body: ReadableStream<Uint8Array>): Readable {
    if (isNode) {
        return Readable.fromWeb(body as never);
    }
    const reader = body.getReader();
    return new Readable({
        read() {
            reader.read().then(
                ({ done, value }) => this.push(done ? null : value),
                (error) => this.destroy(error),
            );
        },
        destroy(error, callback) {
            reader.cancel(error ?? undefined).then(
                () => callback(error),
                () => callback(error),
            );
        },
    });
}

/**
 * Preference order: serializations that carry named graphs and RDF Messages come first.
 * Jelly-RDF is a compact binary RDF Message serialization.
 * NDJSON-LD is not supported by ldfetch (yet), so it is not advertised.
 */
export const DEFAULT_ACCEPT = [
    "application/trig",
    "application/n-quads;q=0.95",
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

/**
 * What to do when the transfer of a document is interrupted: the server drops the connection after it sent a successful
 * response and a part of the body, for example because it is overloaded.
 * A request is not retried for that by the HTTP layer, as its status was fine.
 */
export type TransferRetry = {
    /** How many times a document is requested again before the client gives up. 0 is unlimited, as for the HTTP codes. */
    maxRetries: number;
    /** The time (in milliseconds) before the first new request. It doubles every time, up to 30 seconds. */
    base: number;
};

/** The same schedule as the retries of HTTP codes: 500 ms, 1 s, 2 s, 4 s, 8 s */
export const DEFAULT_TRANSFER_RETRY: TransferRetry = { maxRetries: 5, base: 500 };

const MAX_RETRY_DELAY = 30_000;

const INTERRUPTED_CODES = new Set([
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ERR_STREAM_PREMATURE_CLOSE",
    "UND_ERR_SOCKET",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
]);

/** The messages of the errors that fetch implementations give for a connection that is lost (Node.js, Chrome, Firefox, Safari) */
const INTERRUPTED_MESSAGES =
    /^(terminated|network error|failed to fetch|load failed|networkerror)|other side closed|socket hang up|premature close|network connection was lost/i;

/**
 * Tells whether an error is that of a transfer that was interrupted: a temporary failure, of which a new request can succeed.
 * A document that cannot be parsed, or a server that is not there, is not.
 */
export function isInterruptedTransfer(error: unknown): boolean {
    for (let cause = error, depth = 0; cause instanceof Error && depth < 5; cause = cause.cause, depth++) {
        if (cause.name === "AbortError") return false;
        if (INTERRUPTED_CODES.has((cause as { code?: string }).code ?? "")) return true;
        if (INTERRUPTED_MESSAGES.test(cause.message)) return true;
    }
    return false;
}

/** Whether a transfer that failed `failures` times (this one included) is requested again, and the time to wait before that */
function nextAttempt(retry: TransferRetry, failures: number, error: unknown): { delay: number } | undefined {
    if (!isInterruptedTransfer(error) || (retry.maxRetries !== 0 && failures > retry.maxRetries)) return undefined;
    return { delay: Math.min(retry.base * 2 ** (failures - 1), MAX_RETRY_DELAY) };
}

function giveUp(url: string, failures: number, error: unknown): unknown {
    if (failures <= 1 || !isInterruptedTransfer(error)) return error;
    return new Error(`Reading ${url} failed after ${failures - 1} new requests: ${errorMessage(error)}`, { cause: error });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A rolling checksum of the sizes of the messages of a log, to see that a new request gives the same messages again */
const mix = (checksum: number, message: Quad[]) => (Math.imul(checksum, 31) + message.length + 1) | 0;

/** One transfer of a document: the parser, and the stream it reads from */
type Transfer = { parser: EventEmitter; stream: Readable };

/** What is known of a document when its parser is created */
type TransferInfo = { url: string; status: number; headers: Headers; contentType: string };

/**
 * Receives the parser of a transfer. It is called in the same tick as the parser is created, as the parser can emit events
 * (an error, for example) right away: a listener that comes later misses them.
 */
type Accept = (info: TransferInfo, transfer: Transfer) => void;

/** What a request for a document gave: a log without messages (not modified, gone), or a transfer that is being read */
type Opened = { kind: "empty"; log: MessageLog } | { kind: "parsed" };

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
    private closed = false;

    /** Present when a transfer that is interrupted is requested again, see {@link resumable} */
    private retry?: TransferRetry;
    private reopen?: () => Promise<void>;
    /** The messages that have been read from the transfers, and a checksum of them, to continue after them in a new transfer */
    private read = 0;
    private checksum = 0;
    /** The number of failed transfers in a row, without any message in between */
    private failures = 0;

    constructor(url: string, status: number, headers: Headers, contentType: string) {
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

    /**
     * When the transfer is interrupted, the document is requested again, and the log continues after the messages that
     * it had read. Pages of an LDES are append-only logs, so these messages are the same again: if they are not, the log fails.
     * `reopen` requests the document again, and attaches the new transfer to this log.
     * @internal
     */
    resumable(retry: TransferRetry, reopen: () => Promise<void>): this {
        this.retry = retry;
        this.reopen = reopen;
        return this;
    }

    /** @internal wires the parser output of ldfetch to this log */
    attach(parser: EventEmitter, source: Readable) {
        if (this.closed) {
            source.destroy();
            return;
        }
        this.source = source;
        this.paused = false;
        // A transfer that comes after an interrupted one starts with the messages that have been read already
        const skip = this.read;
        let seen = 0;
        let checksum = 0;
        let live = true;
        const unframed: Quad[] = [];
        const stop = () => {
            live = false;
            source.destroy();
        };
        const failed = (error: unknown) => {
            if (!live) return;
            stop();
            void this.recover(error);
        };
        parser
            .on("data", (quad: Quad, messageCounter?: number) => {
                if (messageCounter === undefined) {
                    unframed.push(quad);
                }
            })
            .on("message", (quads: Quad[]) => {
                if (!live) return;
                this.framed = true;
                if (seen < skip) {
                    checksum = mix(checksum, quads);
                    if (++seen === skip && checksum !== this.checksum) {
                        stop();
                        this.failure = new Error(
                            `${this.url} is not the same any more: the messages that were read before the interruption have changed`,
                        );
                        this.finish();
                    }
                    return;
                }
                this.push(quads);
            })
            .on("error", failed)
            .on("end", () => {
                if (!live) return;
                if (seen < skip) {
                    this.failure = new Error(`${this.url} is not the same any more: it has fewer messages than were read before the interruption`);
                    this.finish();
                    return;
                }
                if (!this.framed && unframed.length > 0) {
                    this.push(unframed);
                }
                this.finish();
            });
        // The connection can be lost without the parser noticing
        source.on("error", failed);
    }

    /** Called when a transfer failed: a new request continues the log, or else the log fails */
    private async recover(error: unknown) {
        let cause = error;
        while (!this.closed) {
            this.failures++;
            const next = this.retry && this.reopen ? nextAttempt(this.retry, this.failures, cause) : undefined;
            if (!next) {
                this.failure = giveUp(this.url, this.failures, cause);
                this.finish();
                return;
            }
            logger.warn(`Reading ${this.url} was interrupted (${errorMessage(cause)}), requesting it again in ${next.delay} ms`);
            await sleep(next.delay);
            if (this.closed) return;
            try {
                await this.reopen!();
                return;
            } catch (ex) {
                cause = ex;
            }
        }
    }

    private push(message: Quad[]) {
        this.read++;
        this.checksum = mix(this.checksum, message);
        this.failures = 0;
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
        this.closed = true;
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
     * They are cached following HTTP caching semantics, with a minimum TTL (see {@link ContextCacheOptions}).
     * Pages themselves are never cached. Undefined when caching contexts is disabled.
     */
    private contexts?: ContextCache;

    /**
     * @param accept the Accept header for IRIs that are dereferenced
     * @param contextCache how external JSON-LD contexts are cached: options of the HTTP cache of ldfetch
     * (`minTTL`, `maxTTL`, `store`, ...), an `HttpCache` to share, or `false` to not cache them.
     * The default follows the cache headers, but keeps a context for at least 10 minutes.
     * @param transferRetry what to do when the transfer of a document is interrupted
     */
    constructor(
        private readonly accept: string = DEFAULT_ACCEPT,
        contextCache?: ContextCacheOptions | HttpCache | false,
        private readonly transferRetry: TransferRetry = DEFAULT_TRANSFER_RETRY,
    ) {
        if (contextCache !== false) this.contexts = new ContextCache(contextCache);
    }

    /** Statistics of the context cache (hits, misses, revalidations, stores), undefined when it is disabled */
    getContextCacheStats() {
        return this.contexts?.getStats();
    }

    /** Dereferences an IRI to a stream of quads, in which all messages (if any) are merged */
    async dereference(url: string, options: DereferenceOptions = {}): Promise<DereferenceOutput> {
        const log = await this.dereferenceMessages(url, options);
        const data = new Readable({ objectMode: true, read() {} });
        // Nobody waits for this: a failure destroys the stream, which reports it
        void (async () => {
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

    /**
     * Dereferences an IRI to an RDF Message log.
     * A transfer that is interrupted is requested again, see {@link TransferRetry}: that is up to the log, which continues
     * after the messages that were read.
     */
    async dereferenceMessages(url: string, options: DereferenceOptions = {}): Promise<MessageLog> {
        if (!/^https?:\/\//i.test(url)) {
            return this.dereferenceFile(url, options);
        }

        let log: MessageLog | undefined;
        const reopen = async () => {
            const again = await this.transfer(url, options, (_info, transfer) => log!.attach(transfer.parser, transfer.stream));
            if (again.kind === "empty") {
                throw new Error(`${url} is not the same any more: it answered HTTP ${again.log.status} when it was requested again`);
            }
        };
        let failures = 0;
        while (true) {
            try {
                const opened = await this.transfer(url, options, (info, transfer) => {
                    log = new MessageLog(info.url, info.status, info.headers, info.contentType).resumable(this.transferRetry, reopen);
                    log.attach(transfer.parser, transfer.stream);
                });
                if (opened.kind === "empty") return opened.log;
                break;
            } catch (error) {
                const next = nextAttempt(this.transferRetry, ++failures, error);
                if (!next) throw giveUp(url, failures, error);
                logger.warn(`Requesting ${url} was interrupted (${errorMessage(error)}), requesting it again in ${next.delay} ms`);
                await sleep(next.delay);
            }
        }
        if (options.bufferedMessages !== undefined) log!.maxBuffered = options.bufferedMessages;
        return log!;
    }

    /** One request for a document, up to the point where it is being parsed */
    private async transfer(url: string, options: DereferenceOptions, accept: Accept): Promise<Opened> {
        const headers = new Headers(options.headers);
        if (!headers.has("accept")) {
            headers.set("accept", this.accept);
        }
        const response = await (options.fetch ?? fetch)(url, { headers });

        const originalStatus = Number(response.headers.get(ORIGINAL_STATUS_HEADER) ?? response.status);
        if (response.status >= 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Could not dereference ${url}: HTTP ${response.status}`);
        }
        if (originalStatus === 304 || originalStatus === 410 || !response.body) {
            // The client's fetch hides these statuses behind an empty 200 response
            await response.body?.cancel().catch(() => undefined);
            return { kind: "empty", log: MessageLog.empty(response.url || url, originalStatus, response.headers) };
        }

        const finalUrl = response.url || url;
        const source = toReadable(response.body);
        await this.parse(
            source,
            finalUrl,
            url,
            response.headers.get("content-type") ?? "",
            response.headers.get("content-disposition"),
            options.fetch ?? fetch,
            (contentType, transfer) => accept({ url: finalUrl, status: response.status, headers: response.headers, contentType }, transfer),
        );
        return { kind: "parsed" };
    }

    private async dereferenceFile(location: string, options: DereferenceOptions): Promise<MessageLog> {
        if (!options.localFiles) {
            throw new Error(`Tried to read local file ${location} without enabling localFiles`);
        }
        const { createReadStream } = await import("fs");
        const { fileURLToPath, pathToFileURL } = await import("url");
        const { resolve } = await import("path");
        const path = location.startsWith("file://") ? fileURLToPath(location) : resolve(location);
        const source = createReadStream(path);
        const url = pathToFileURL(path).href;
        let log: MessageLog | undefined;
        await this.parse(source, url, url, "", null, options.fetch ?? fetch, (contentType, transfer) => {
            log = new MessageLog(url, 200, new Headers(), contentType);
            log.attach(transfer.parser, transfer.stream);
        });
        if (options.bufferedMessages !== undefined) log!.maxBuffered = options.bufferedMessages;
        return log!;
    }

    private async parse(
        source: Readable,
        url: string,
        requestUrl: string,
        declaredType: string,
        contentDisposition: string | null,
        fetch_f: typeof fetch,
        accept: (contentType: string, transfer: Transfer) => void,
    ): Promise<void> {
        const base = declaredType.split(";")[0].trim();
        const prepared = await RdfParsers.prepareStream(source, {
            contentType: base || "application/octet-stream",
            url,
            requestUrl,
            contentDisposition,
        });
        const contentType = RdfParsers.resolveContentType(prepared.contentType, url, requestUrl);
        logger.debug(`Parsing ${url} as ${contentType}`);

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
                documentLoader: this.contexts?.documentLoader(fetch_f) ?? uncachedDocumentLoader(fetch_f),
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
        accept(contentType, { parser, stream: prepared.stream });
    }
}

export const ldfetchDereferencer = new LdfetchDereferencer();
