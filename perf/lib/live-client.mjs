// A polling client in a process of its own, for perf/latency.mjs. It prints one line for every member:
// "<member id>\t<Date.now() when it was emitted>", and "ready\t<Date.now()>" when it starts.
// Usage: node live-client.mjs <dist> <url> <ordered> <pollIntervalMs> <memory|none> [extra client configuration as JSON]
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , dist, url, ordered, pollInterval, state, extra] = process.argv;
const { replicateLDES, MemoryStorage } = await import(pathToFileURL(path.join(dist, "lib/client.js")).href);

process.stdout.write(`ready\t${Date.now()}\n`);
const client = replicateLDES(
    {
        url,
        polling: true,
        pollInterval: Number(pollInterval),
        ...(state === "memory" ? { storage: new MemoryStorage() } : {}),
        ...(extra ? JSON.parse(extra) : {}),
    },
    ordered,
);
process.on("SIGTERM", () => process.exit(0));
for await (const member of client.stream({ highWaterMark: 100 })) {
    process.stdout.write(`${member.id.value}\t${Date.now()}\n`);
}
