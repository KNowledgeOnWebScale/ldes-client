/**
 * Runs a replication in a Web Worker: a browser environment without `window`.
 * See https://github.com/KNowledgeOnWebScale/ldes-client/issues/177
 */
import "../setup";
import { replicateLDES } from "../../../lib/client";

type Request = { url: string; statePath?: string };

self.onmessage = async (event: MessageEvent<Request>) => {
    try {
        const client = replicateLDES({ url: event.data.url, statePath: event.data.statePath });
        let count = 0;
        for await (const member of client.stream()) {
            if (member.id) count += 1;
        }
        await client.close();
        self.postMessage({ count });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
};
