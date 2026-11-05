import { describe, expect, test } from "vitest";
import { readableToArray } from "../lib/utils";

describe("readableToArray", () => {
    test("collects all chunks of a stream", async () => {
        const stream = new ReadableStream<number>({
            start(controller) {
                [1, 2, 3].forEach((n) => controller.enqueue(n));
                controller.close();
            },
        });
        expect(await readableToArray(stream)).toEqual([1, 2, 3]);
    });

    test("gives an empty array for an empty stream", async () => {
        const stream = new ReadableStream<number>({
            start: (controller) => controller.close(),
        });
        expect(await readableToArray(stream)).toEqual([]);
    });

    test("rejects when the stream fails", async () => {
        const stream = new ReadableStream<number>({
            start(controller) {
                controller.enqueue(1);
                controller.error(new Error("broken stream"));
            },
        });
        await expect(readableToArray(stream)).rejects.toThrow("broken stream");
    });
});
