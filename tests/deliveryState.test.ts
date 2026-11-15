import { expect, test } from "vitest";
import { MemoryStorage, replicateLDES } from "../lib/client";

const url = "http://example.org/ldes";
const body = `@prefix tree: <https://w3id.org/tree#> .
@prefix ldes: <https://w3id.org/ldes#> .
@prefix dc: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${url}> a ldes:EventStream ; ldes:timestampPath dc:created ; tree:view <${url}> ; tree:member <http://example.org/m> .
<http://example.org/m> dc:created "2026-01-01T00:00:00Z"^^xsd:dateTime .`;
const fetchPage: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/turtle" } });

test.each(["none", "ascending"] as const)("a failed delivery write errors the %s stream and leaves state available for retry", async (ordered) => {
    const storage = new MemoryStorage();
    const emitted = storage.store("emitted");
    const put = emitted.put.bind(emitted);
    const failure = new Error("state write failed");
    emitted.put = async () => {
        throw failure;
    };
    let storageClosed = false;
    storage.close = async () => {
        storageClosed = true;
    };
    const client = replicateLDES({ url, storage, fetch: fetchPage }, ordered);
    const errors: unknown[] = [];
    client.on("error", (error) => errors.push(error));

    await expect(async () => {
        for await (const _member of client.stream()) {
            /* read until completion or failure */
        }
    }).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(storageClosed).toBe(true);
    await expect(client.close()).rejects.toBe(failure);

    emitted.put = put;
    const resumed = replicateLDES({ url, storage, fetch: fetchPage }, ordered);
    const ids: string[] = [];
    for await (const member of resumed.stream()) ids.push(member.id.value);
    expect(ids).toEqual(["http://example.org/m"]);
});

test("concurrent close calls report a delivery write that fails during shutdown, after closing storage", async () => {
    const storage = new MemoryStorage();
    const failure = new Error("state write failed during shutdown");
    let rejectWrite!: (error: Error) => void;
    const write = new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
    });
    storage.store("emitted").put = () => {
        signalStarted();
        return write;
    };
    let storageClosed = false;
    storage.close = async () => {
        storageClosed = true;
    };
    const client = replicateLDES({ url, storage, fetch: fetchPage });
    const reader = client.stream().getReader();
    expect((await reader.read()).value?.id.value).toBe("http://example.org/m");
    await started;

    const closing = client.close();
    expect(client.close()).toBe(closing);
    const failedClose = expect(closing).rejects.toBe(failure);
    rejectWrite(failure);
    await failedClose;
    await expect(reader.read()).rejects.toBe(failure);
    expect(storageClosed).toBe(true);
});
