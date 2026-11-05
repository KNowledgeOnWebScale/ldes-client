import { describe, expect, test } from "vitest";
import { intoConfig } from "../lib/config";

describe("intoConfig", () => {
    test("gives the defaults of everything that is not set", () => {
        const config = intoConfig({ url: "http://example.org/ldes" });
        expect(config.pollInterval).toBe(1000);
        expect(config.concurrentFetches).toBe(10);
        expect(config.polling).toBe(false);
    });

    test("keeps the default of an option that is set to undefined, as the RDF-Connect processor does", () => {
        const config = intoConfig({
            url: "http://example.org/ldes",
            pollInterval: undefined,
            concurrentFetches: undefined,
            polling: undefined,
        });
        expect(config.pollInterval).toBe(1000);
        // The LDES 2.0 client requests this many pages ahead: undefined would turn that off
        expect(config.concurrentFetches).toBe(10);
        expect(config.polling).toBe(false);
    });

    test("uses an option that is set", () => {
        const config = intoConfig({
            url: "http://example.org/ldes",
            pollInterval: 50,
            concurrentFetches: 2,
            polling: true,
        });
        expect(config.pollInterval).toBe(50);
        expect(config.concurrentFetches).toBe(2);
        expect(config.polling).toBe(true);
    });
});
