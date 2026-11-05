/**
 * Responses arrive in chunks of arbitrary size. The parser must handle tokens that are split over chunks, for example
 * the language tag `@nl-nl` (https://github.com/rdfjs/N3.js/issues/578, fixed in N3.js 2.1.2).
 * The client used to protect itself against this with a line buffer, which is not needed anymore.
 */
import { describe, expect, test } from "vitest";
import { enhanced_fetch } from "../lib/fetcher";
import { ldfetchDereferencer } from "../lib/fetcher/ldfetchDereferencer";
import { streamToArray } from "../lib/utils";

const TURTLE = `@prefix ex: <http://example.org/> .
ex:s ex:p "hallo"@nl-nl , "hello"@en-gb-oed , "héllo wörld ✓"@fr ;
     ex:q "plain" .
`;

/** Serves a body as chunks of the given size (in bytes), which split tokens and multi-byte characters */
function chunked(body: string, size: number, contentType = "text/turtle"): typeof fetch {
    const bytes = new TextEncoder().encode(body);
    return (async () => {
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.slice(offset, offset + size));
                offset += size;
            },
        });
        return new Response(stream, { status: 200, headers: { "content-type": contentType } });
    }) as typeof fetch;
}

async function read(fetch_f: typeof fetch) {
    const { data } = await ldfetchDereferencer.dereference("http://example.org/doc", { fetch: fetch_f });
    return streamToArray(data);
}

describe("Responses that arrive in chunks", () => {
    // 1 byte: every token is split. The others: other boundaries, including within the multi-byte characters.
    test.each([1, 2, 3, 5, 7, 13])("a Turtle response in chunks of %i bytes is parsed completely", async (size) => {
        const quads = await read(chunked(TURTLE, size));
        const languages = quads
            .filter((q) => q.object.termType === "Literal" && q.object.language)
            .map((q) => (q.object as { language: string }).language)
            .sort();
        expect(quads).toHaveLength(4);
        expect(languages).toEqual(["en-gb-oed", "fr", "nl-nl"]);
        expect(quads.find((q) => q.object.value === "héllo wörld ✓")).toBeDefined();
    });

    test("the same holds through the enhanced fetch of the client", async () => {
        const quads = await read(enhanced_fetch({}, chunked(TURTLE, 1)));
        expect(quads).toHaveLength(4);
    });
});
