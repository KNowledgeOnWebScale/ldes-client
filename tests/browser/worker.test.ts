import { describe, expect, test } from "vitest";

// Note: The globalSetup runs the server on port 3042
const LDES = "http://localhost:3042/mock-ldes.ttl";

type Result = { count?: number; error?: string };

function replicateInWorker(statePath?: string): Promise<Result> {
    const worker = new Worker(new URL("./worker/replicate.worker.ts", import.meta.url), { type: "module" });
    return new Promise<Result>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Result>) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ url: LDES, statePath });
    }).finally(() => worker.terminate());
}

describe("Client in a Web Worker (Browser)", () => {
    test("replicates without a statePath", async () => {
        const result = await replicateInWorker();
        expect(result.error).toBeUndefined();
        expect(result.count).toBeGreaterThan(0);
    });

    test("replicates with a statePath", async () => {
        const result = await replicateInWorker(`ldes-worker-${Date.now()}-${Math.random()}`);
        expect(result.error).toBeUndefined();
        expect(result.count).toBeGreaterThan(0);
    });
});
