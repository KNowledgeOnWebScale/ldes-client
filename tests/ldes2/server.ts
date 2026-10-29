import { fastify } from "fastify";
import type { FastifyInstance } from "fastify";

export type Page = {
    body: string | Buffer;
    type?: string;
    status?: number;
    headers?: Record<string, string>;
    /** Milliseconds before the page is sent */
    delay?: number;
};

export const PREFIXES = `PREFIX ldes: <https://w3id.org/ldes#>
PREFIX tree: <https://w3id.org/tree#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX ex: <http://example.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
`;

/**
 * A mock LDES server that serves in-memory pages, and that keeps a log of the requests it receives.
 * A page in a message serialization has to announce it: `VERSION "1.2-messages"`.
 */
export class MockServer {
    public pages = new Map<string, Page>();
    public requests: string[] = [];
    /** The requests that are being answered, and the largest number there have been at the same time */
    public inFlight = 0;
    public maxInFlight = 0;
    private server?: FastifyInstance;

    constructor(private port: number) {}

    get base() {
        return `http://localhost:${this.port}`;
    }

    /** Serves a TriG message log, in which messages are separated by MESSAGE */
    trig(path: string, ...messages: string[]) {
        this.pages.set(path, {
            body: `VERSION "1.2-messages"\n${PREFIXES.replace(/PREFIX /g, "PREFIX ")}\n` +
                messages.map((message) => message.replaceAll("<>", `<${this.base}${path}>`)).join("\nMESSAGE\n"),
            type: "application/trig",
        });
    }

    set(path: string, page: Page) {
        this.pages.set(path, page);
    }

    async start() {
        this.server = fastify();
        this.server.get("/*", async (request, reply) => {
            const path = request.url.split("?")[0];
            this.requests.push(path);
            const page = this.pages.get(path);
            if (!page) {
                return reply.status(404).send("not found");
            }
            this.inFlight++;
            this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
            try {
                if (page.delay) await new Promise((resolve) => setTimeout(resolve, page.delay));
            } finally {
                this.inFlight--;
            }
            reply.status(page.status ?? 200);
            reply.header("content-type", page.type ?? "text/plain");
            for (const [key, value] of Object.entries(page.headers ?? {})) {
                reply.header(key, value);
            }
            return reply.send(page.body);
        });
        await this.server.listen({ port: this.port });
    }

    async stop() {
        await this.server?.close();
    }
}
