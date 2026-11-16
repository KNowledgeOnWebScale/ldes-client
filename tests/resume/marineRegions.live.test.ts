import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicateLDES } from "../../lib/client";

// The live reproduction from https://github.com/KNowledgeOnWebScale/ldes-client/issues/173.
// Run explicitly: MARINE_REGIONS=1 npx vitest run tests/resume/marineRegions.live.test.ts
test.skipIf(process.env.MARINE_REGIONS !== "1")(
    "#173: interrupted Marine Regions replication emits the same members as an uninterrupted run, exactly once",
    async () => {
        const state = fs.mkdtempSync(path.join(os.tmpdir(), "ldes-marine-regions-"));
        const url = "https://www.marineregions.org/feed.ttl";
        const after = new Date("2026-10-17T00:00:00Z");
        const limit = 200;

        async function run(name: string, limit: number) {
            const client = replicateLDES({ url, after, statePath: path.join(state, name) });
            const ids: string[] = [];
            try {
                for await (const member of client.stream({ highWaterMark: 10 })) {
                    ids.push(member.id.value);
                    if (ids.length >= limit) break;
                }
            } finally {
                await client.close();
            }
            return ids;
        }

        try {
            const seen: string[] = [];
            let finished = false;
            for (let i = 0; i < 20; i++) {
                const ids = await run("interrupted", limit);
                seen.push(...ids);
                if (ids.length === 0) {
                    finished = true;
                    break;
                }
            }
            const once = await run("uninterrupted", Infinity);
            expect(once.length, "the live feed must have enough members to interrupt replication").toBeGreaterThan(limit);
            expect(finished, "the interrupted replication must finish").toBe(true);
            expect(new Set(seen).size, "no member is emitted twice").toBe(seen.length);
            expect(seen.sort(), "all members from the uninterrupted run are emitted").toEqual(once.sort());
        } finally {
            fs.rmSync(state, { recursive: true, force: true });
        }
    },
    180_000,
);
