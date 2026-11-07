// One fresh process per replication. Imports and full RDF verification are outside reported timings.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { member, turtlePrefixes } from "./fixtures.mjs";

const [, , dist, url, ordered, expected, verify] = process.argv;
const { replicateLDES } = await import(
    pathToFileURL(path.join(dist, "lib/client.js")).href
);

const { Parser } = await import("n3");
const canonical = (quads) =>
    quads
        .map((q) =>
            [q.subject, q.predicate, q.object, q.graph]
                .map((t) =>
                    t.termType === "BlankNode"
                        ? "_:detail"
                        : JSON.stringify([
                              t.termType,
                              t.value,
                              t.language || "",
                              t.datatype?.value || "",
                          ]),
                )
                .join(" "),
        )
        .sort()
        .join("\n");
const seen = new Uint8Array(Number(expected));
let firstMemberSeconds;
let last = performance.now();
let maxBlocked = 0;
let peakRss = 0;
const sampler = setInterval(() => {
    const now = performance.now();
    maxBlocked = Math.max(maxBlocked, now - last - 10);
    last = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);

const started = performance.now();
// Extra configuration of the client, as JSON (for example {"concurrentFetches": 2}), for experiments
const extra = process.env.LDES_CLIENT_CONFIG
    ? JSON.parse(process.env.LDES_CLIENT_CONFIG)
    : {};
const client = replicateLDES({ url, ...extra }, ordered);
let members = 0;
for await (const item of client.stream({ highWaterMark: 100 })) {
    firstMemberSeconds ??= (performance.now() - started) / 1000;
    const id = Number(item.id.value.replace("http://example.org/m", ""));
    if (!Number.isInteger(id) || id < 0 || id >= seen.length || seen[id])
        throw new Error(`Invalid/duplicate member: ${item.id.value}`);
    seen[id] = 1;
    if (item.quads.length !== 8)
        throw new Error(
            `Member ${id}: expected 8 quads, got ${item.quads.length}`,
        );
    if (verify === "verify") {
        const source = new Parser().parse(turtlePrefixes + member(id));
        if (canonical(source) !== canonical(item.quads))
            throw new Error(`Data mismatch for member ${id}`);
    }
    members++;
}
if (members !== Number(expected))
    throw new Error(`Expected ${expected} members, got ${members}`);
const seconds = (performance.now() - started) / 1000;
clearInterval(sampler);
console.log(
    JSON.stringify({
        members,
        seconds,
        firstMemberSeconds,
        maxBlocked,
        peakRss: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    }),
);
process.exit(0);
