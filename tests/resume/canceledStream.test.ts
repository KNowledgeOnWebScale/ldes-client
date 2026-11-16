import { expect, test } from "vitest";
import { MemoryStorage, replicateLDES } from "../../lib/client";

const url = "http://example.org/ldes";
const pageUrl = "http://example.org/page";
const ids = [1, 2, 3].map((n) => `http://example.org/m${n}`);
const description = `@prefix tree: <https://w3id.org/tree#> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix dc: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${url}> a ldes:EventStream ; ldes:timestampPath dc:created ; tree:view <${url}> ;
    tree:relation [ a tree:Relation ; tree:node <${pageUrl}> ] .`;
const page = `${description}
<${url}> tree:member ${ids.map((id) => `<${id}>`).join(", ")} .
${ids.map((id) => `<${id}> dc:created "2026-11-09T06:00:00Z"^^xsd:dateTime .`).join("\n")}`;

function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

test.each(["immutable", "etag"])("#173: canceling a stream leaves refused members available on a resumed %s page", async (cache) => {
    const storage = new MemoryStorage();
    const closeStarted = signal();
    const extracted = signal();
    const fetchPage: typeof fetch = async (input, init) => {
        const leaf = String(input) === pageUrl;
        const headers = new Headers({ "content-type": "text/turtle" });
        if (leaf) {
            if (cache === "immutable") headers.set("cache-control", "public, max-age=31536000, immutable");
            else headers.set("etag", '"v1"');
            if (cache === "etag" && new Headers(init?.headers).get("if-none-match") === '"v1"') {
                return new Response(null, { status: 304, headers });
            }
        }
        return new Response(leaf ? page : description, { headers });
    };
    const config = { url, storage, fetch: fetchPage, after: new Date("2026-10-17T00:00:00Z") };
    const client = replicateLDES(config);
    const emitted = storage.store("emitted");
    const put = emitted.put.bind(emitted);
    // close() waits for delivery writes. Keep that window open until extraction finishes,
    // as a disk write can do, so the remaining members reach the canceled stream.
    emitted.put = async (key, value) => {
        await extracted.promise;
        await put(key, value);
    };
    const close = client.close.bind(client);
    client.close = () => {
        closeStarted.resolve();
        return close();
    };
    client.on("description", ({ extractor }) => {
        const bulkExtract = extractor.bulkExtract.bind(extractor);
        extractor.bulkExtract = async (store, members, shape, ignored, itemExtracted) => {
            const first = await bulkExtract(store, members.slice(0, 1), shape, ignored, itemExtracted);
            // Extract the rest only after the consumer has canceled, with no unread
            // members buffered. This makes the race independent of extraction speed.
            await closeStarted.promise;
            return [...first, ...(await bulkExtract(store, members.slice(1), shape, ignored, itemExtracted))];
        };
    });
    client.on("fragment", (fragment) => {
        if (fragment.url === pageUrl) extracted.resolve();
    });

    const seen: string[] = [];
    try {
        for await (const member of client.stream({ highWaterMark: 10 })) {
            seen.push(member.id.value);
            break;
        }
    } finally {
        extracted.resolve();
        await client.close();
        emitted.put = put;
    }
    expect(seen).toEqual(ids.slice(0, 1));

    const resumed = replicateLDES(config);
    try {
        for await (const member of resumed.stream({ highWaterMark: 10 })) seen.push(member.id.value);
    } finally {
        await resumed.close();
    }
    expect(seen.sort()).toEqual(ids);

    const again = replicateLDES(config);
    try {
        const remaining = [];
        for await (const member of again.stream()) remaining.push(member.id.value);
        expect(remaining).toEqual([]);
    } finally {
        await again.close();
    }
});
