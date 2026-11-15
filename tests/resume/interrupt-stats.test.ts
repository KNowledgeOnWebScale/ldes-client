import { afterAll, beforeAll, test } from "vitest";

/**
 * Not a test: a measurement. It interrupts every feed again and again, 15 times, and counts how often members are lost,
 * emitted twice, or fail with an error. It takes minutes, and only runs when asked:
 *   RESUME_STATS=1 [FEED=mint] [ORDER=ascending] [HWM=1,10] [DETAIL=1] [EXPLORE_OUT=file] npx vitest run tests/resume/interrupt-stats.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicateLDES } from "../../lib/client";
import { FeedServer } from "./feedServer";
import { feeds, items } from "./feeds";

const server = new FeedServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
const first = [...items(8, 0, Date.parse("2025-12-31T22:00:00Z")), ...items(22, 8, Date.parse("2026-01-31T20:00:00Z"))];

test.skipIf(!process.env.RESUME_STATS)(
    "how often are members lost when a replication is interrupted again and again",
    async () => {
        const out: string[] = [];
        for (const feed of feeds.filter((f) => !process.env.FEED || f.name === process.env.FEED)) {
            feed.publish(server, first);
            for (const ordered of feed.orders.filter((o) => !process.env.ORDER || o === process.env.ORDER))
                for (const hwm of (process.env.HWM ?? "1,10").split(",").map(Number)) {
                    const tally: Record<string, number> = {};
                    for (let rep = 0; rep < 15; rep++) {
                        const state = fs.mkdtempSync(path.join(os.tmpdir(), "ldes-explore-"));
                        const emitted: string[] = [];
                        const errors: string[] = [];
                        let finished = false;
                        for (let run = 0; run < 60 && !finished; run++) {
                            const client = replicateLDES({ url: feed.entry(server), statePath: state, ...feed.options }, ordered);
                            client.on("error", (e) => errors.push(String((e as Error)?.message ?? e).slice(0, 40)));
                            let n = 0;
                            try {
                                for await (const m of client.stream({ highWaterMark: hwm })) {
                                    emitted.push(m.id.value);
                                    if (++n >= 7) {
                                        await client.close();
                                        break;
                                    }
                                }
                            } catch (e) {
                                errors.push(String((e as Error)?.message ?? e).slice(0, 40));
                            }
                            finished = n < 7;
                        }
                        const unique = new Set(emitted).size;
                        const key = [
                            `lost=${first.length - unique > 0 ? "yes" : "no"}`,
                            `dup=${emitted.length - unique > 0 ? "yes" : "no"}`,
                            errors.length ? `err(${[...new Set(errors)].join("|")})` : "noerr",
                        ].join(" ");
                        tally[key] = (tally[key] ?? 0) + 1;
                        if (process.env.DETAIL && (unique < first.length || emitted.length > unique)) {
                            const all = first.map((i) => feed.memberId(server, i));
                            out.push(
                                `  rep ${rep}: lost=[${all.map((id, i) => (emitted.includes(id) ? null : `#${i}`)).filter(Boolean)}] dup=[${[...new Set(emitted.filter((id, i) => emitted.indexOf(id) !== i))].map((id) => `#${all.indexOf(id)}`)}] order=[${emitted.map((id) => all.indexOf(id)).join(",")}]`,
                            );
                        }
                        fs.rmSync(state, { recursive: true, force: true });
                    }
                    out.push(`${feed.name} ordered=${ordered} hwm=${hwm}: ${JSON.stringify(tally)}`);
                }
        }
        fs.writeFileSync(process.env.EXPLORE_OUT ?? path.join(os.tmpdir(), "resume-interrupt-stats.txt"), out.join("\n") + "\n");
    },
    600_000,
);
