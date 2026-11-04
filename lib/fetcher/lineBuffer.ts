import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/**
 * A Transform stream that buffers incomplete lines before emitting them.
 * This prevents language tags and other tokens from being split across chunk boundaries,
 * working around an N3.js bug: https://github.com/rdfjs/N3.js/issues/578
 */
export function createLineBufferedFetch(baseFetch?: typeof fetch): typeof fetch {
    const fetchFn = baseFetch || (typeof fetch !== "undefined" ? fetch : undefined);

    if (!fetchFn) {
        throw new Error("No fetch function available");
    }

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await fetchFn(input, init);

        // Only buffer for readable streams (skip if body is already consumed or unavailable)
        if (!response.body) {
            return response;
        }

        // Check if we're in a Node.js environment
        const isNode = typeof process !== "undefined" && process.versions && process.versions.node;

        if (isNode) {
            // In Node.js, convert web stream to Node stream and apply buffer
            const { Readable, Transform } = await import("stream");

            // Create the line buffer transform
            class LineBufferTransform extends Transform {
                private remainder = "";

                _transform(chunk: Buffer, _encoding: string, callback: () => void) {
                    const data = this.remainder + chunk.toString();
                    const lines = data.split("\n");
                    this.remainder = lines.pop() ?? "";

                    if (lines.length > 0) {
                        this.push(lines.join("\n") + "\n");
                    }

                    callback();
                }

                _flush(callback: () => void) {
                    if (this.remainder.length > 0) {
                        this.push(this.remainder);
                    }
                    callback();
                }
            }

            const nodeStream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
            const lineBuffer = new LineBufferTransform();
            const bufferedStream = nodeStream.pipe(lineBuffer);

            return new Response(bufferedStream as unknown as BodyInit, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } else {
            // In browser environment, return response as-is (browsers don't have chunking issues)
            return response;
        }
    };
}

