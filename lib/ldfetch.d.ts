declare module "ldfetch/lib/RdfParsers.js" {
    import type { Readable } from "stream";
    import type { EventEmitter } from "events";

    export type ParseOptions = {
        contentType: string;
        baseIRI: string;
        requestUrl?: string;
        bodyText?: string;
        bodyBuffer?: Buffer;
    };

    export function parse(options: ParseOptions): EventEmitter;
    export function parseStream(
        stream: Readable,
        options: { contentType: string; baseIRI: string },
    ): EventEmitter;
    export function prepareStream(
        stream: Readable,
        options: {
            contentType: string;
            url: string;
            requestUrl?: string;
            contentDisposition?: string | null;
        },
    ): Promise<{ stream: Readable; contentType: string; decompressed: boolean }>;
    export function isStreamable(contentType: string): boolean;
    export function resolveContentType(
        contentType: string,
        url: string,
        fallbackUrl?: string,
    ): string;
}
