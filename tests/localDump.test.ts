import { describe, expect, test } from "vitest";
import { replicateLDES } from "../lib/client";

import type { Ordered } from "../lib/client";

/**
 * tests/data/ldes-dump.ttl is a dump of a real LDES, and its tree:view is an IRI on the Web
 * (https://www.marineregions.org/export/MRGID-LDES-export.zip). The dump has all that is needed to read it:
 * the client must not go to the Web for it. A test that depends on a remote server is slow, and fails when
 * that server is slow, or when there is no network, such as on a CI runner.
 */
describe("Replicating a local dump", () => {
    test.each<Ordered>(["none", "ascending"])("makes no HTTP request at all, ordered: %s", async (ordered) => {
        const requests: string[] = [];
        const noNetwork: typeof fetch = async (input) => {
            requests.push(input instanceof Request ? input.url : String(input));
            throw new Error("A local dump must not be fetched from the Web");
        };

        const ids: string[] = [];
        for await (const member of replicateLDES({ url: "./tests/data/ldes-dump.ttl", fetch: noNetwork }, ordered).stream()) {
            ids.push(member.id.value);
        }

        expect(requests).toEqual([]);
        expect(ids).toHaveLength(4);
    });
});
