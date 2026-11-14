import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

export type Route = {
    body: string;
    type: string;
    /** Sent as is, for example Cache-Control */
    headers?: Record<string, string>;
    /** Served with an ETag, and answered with a 304 to a matching If-None-Match, as most LDES servers do */
    etag?: boolean;
    /** A redirect: the status and the Location, the body is not used */
    redirect?: { status: number; to: string };
    /** Milliseconds before the response is sent */
    delay?: number;
    /** An answer with this status, such as 410 for a page that was removed, instead of 200 */
    status?: number;
};

export type LoggedRequest = {
    /** Path and query, as requested */
    url: string;
    status: number;
    conditional: boolean;
};

/**
 * A server of mock feeds. Unlike the servers of the other tests, it logs the status of every response, because what
 * happens at the start of a resumed replication is the point of the tests that use it: 404s, redirects and 304s.
 * A route that is not defined is a 404 with an HTML body, which is what the nginx of a real LDES server sends.
 */
export class FeedServer {
    public routes = new Map<string, Route>();
    public log: LoggedRequest[] = [];
    /** The requests that have arrived and are not answered yet */
    public inFlight = 0;
    private server?: Server;
    private port = 0;

    get base() {
        return `http://127.0.0.1:${this.port}`;
    }

    route(url: string, route: Route) {
        this.routes.set(url, route);
    }

    redirect(from: string, to: string, status = 302) {
        this.routes.set(from, { body: "", type: "text/html", redirect: { status, to } });
    }

    /** Starts a new log, and returns the one that was kept so far */
    takeLog(): LoggedRequest[] {
        const log = this.log;
        this.log = [];
        return log;
    }

    /** Waits until every request has been answered: a client that was closed can have requests in flight */
    async settle() {
        while (this.inFlight > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    async start() {
        this.server = createServer((request, response) => {
            const url = request.url ?? "/";
            const conditional = request.headers["if-none-match"] !== undefined;
            const route = this.routes.get(url);
            // Logged when the request arrives, so that the order is the order of the requests, also when answers are delayed
            const entry: LoggedRequest = { url, status: 0, conditional };
            this.log.push(entry);
            this.inFlight++;
            response.on("close", () => this.inFlight--);
            const answer = () => {
                if (!route) {
                    entry.status = 404;
                    response.writeHead(404, { "content-type": "text/html" }).end("<html><body><h1>404 Not Found</h1></body></html>");
                    return;
                }
                if (route.status) {
                    entry.status = route.status;
                    response.writeHead(route.status, { "content-type": route.type, ...route.headers }).end(route.body);
                    return;
                }
                if (route.redirect) {
                    entry.status = route.redirect.status;
                    response.writeHead(route.redirect.status, { location: this.base + route.redirect.to, "content-length": "0" }).end();
                    return;
                }
                const headers: Record<string, string> = { "content-type": route.type, ...route.headers };
                if (route.etag) {
                    const etag = `"${createHash("sha1").update(route.body).digest("hex")}"`;
                    headers.etag = etag;
                    if (request.headers["if-none-match"] === etag) {
                        entry.status = 304;
                        response.writeHead(304, headers).end();
                        return;
                    }
                }
                entry.status = 200;
                response.writeHead(200, headers).end(route.body);
            };
            if (route?.delay) setTimeout(answer, route.delay);
            else answer();
        });
        await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
        const address = this.server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
    }

    async stop() {
        this.server?.closeAllConnections();
        await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
}
