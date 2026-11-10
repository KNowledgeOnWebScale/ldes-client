/**
 * A server may drop the TCP connection after it sent a successful response and a part of the body, for example when it is overloaded
 * (https://github.com/KNowledgeOnWebScale/ldes-client/issues/107). The status was fine, so the request is not retried, and the error
 * only shows up while the body is read and parsed.
 *
 * Such an interrupted transfer is a temporary failure: the client has to request the page again, and still emit every member once.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { replicateLDES } from "../lib/client";
import { PREFIXES } from "./ldes2/server";

import type { Member } from "../lib/types";

/** Serves pages, and drops the connection halfway the body of the first requests of the pages that are marked to be interrupted */
class InterruptingServer {
    public pages = new Map<string, { body: string; type: string }>();
    /** Paths of which the first `n` requests are interrupted */
    public interrupt = new Map<string, number>();
    public requests: string[] = [];
    public interrupted = 0;
    private server = http.createServer((req, res) => this.handle(req, res));

    constructor(private port: number) {}

    get base() {
        return `http://localhost:${this.port}`;
    }

    reset() {
        this.pages.clear();
        this.interrupt.clear();
        this.requests = [];
        this.interrupted = 0;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse) {
        const path = (req.url ?? "").split("?")[0];
        this.requests.push(path);
        const page = this.pages.get(path);
        if (!page) {
            res.writeHead(404).end("not found");
            return;
        }
        const body = Buffer.from(page.body);
        const headers = { "content-type": page.type, "content-length": body.length };
        const attempt = this.requests.filter((request) => request === path).length;
        if (attempt > (this.interrupt.get(path) ?? 0)) {
            res.writeHead(200, headers).end(body);
            return;
        }
        // The status is 200 and the headers promise the whole body, but the connection drops halfway
        this.interrupted++;
        res.writeHead(200, headers);
        res.write(body.subarray(0, Math.floor(body.length * 0.6)));
        setTimeout(() => res.socket?.destroy(), 20);
    }

    start() {
        return new Promise<void>((resolve) => this.server.listen(this.port, resolve));
    }

    stop() {
        return new Promise<void>((resolve) => {
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }
}

async function collect(url: string): Promise<Member[]> {
    const client = replicateLDES({ url, noShape: true });
    const members: Member[] = [];
    for await (const member of client.stream({ highWaterMark: 10 })) {
        members.push(member);
    }
    return members;
}

const LABEL = "a label that makes the member a bit larger, so that the interrupted body holds several members ".repeat(2);

describe("A transfer that is interrupted", () => {
    describe("in an LDES 1.0", () => {
        const server = new InterruptingServer(3107);
        const PAGES = 3;
        const PER_PAGE = 10;

        beforeAll(() => server.start());
        afterAll(() => server.stop());
        beforeEach(() => {
            server.reset();
            for (let page = 0; page < PAGES; page++) {
                const next =
                    page + 1 < PAGES
                        ? ` ; tree:relation [ a tree:GreaterThanOrEqualToRelation ; tree:node <${server.base}/page/${page + 1}> ; tree:path ex:modified ; tree:value "2024-01-0${page + 2}T00:00:00.000Z"^^xsd:dateTime ]`
                        : "";
                const lines = [
                    PREFIXES.replaceAll("PREFIX ", "@prefix ").replace(/>\n/g, "> .\n"),
                    `<${server.base}/ldes> a ldes:EventStream ; ldes:timestampPath ex:modified ; tree:view <${server.base}/page/0> .`,
                    `<${server.base}/page/${page}> a tree:Node${next} .`,
                ];
                for (let member = 0; member < PER_PAGE; member++) {
                    const id = `${server.base}/member/${page}-${member}`;
                    lines.push(`<${server.base}/ldes> tree:member <${id}> .`);
                    lines.push(
                        `<${id}> a ex:Thing ; ex:modified "2024-01-0${page + 1}T00:00:${String(member).padStart(2, "0")}.000Z"^^xsd:dateTime ; ex:label "${LABEL}${member}" .`,
                    );
                }
                server.pages.set(`/page/${page}`, { body: lines.join("\n") + "\n", type: "text/turtle" });
            }
            server.pages.set("/ldes", server.pages.get("/page/0")!);
        });
        afterEach(() => {
            // The scenario has to have happened, or the tests below pass for the wrong reason
            expect(server.interrupted).toBeGreaterThan(0);
        });

        test("is requested again, and every member is emitted once", async () => {
            server.interrupt.set("/page/1", 1);

            const members = await collect(`${server.base}/ldes`);

            const ids = members.map((member) => member.id.value);
            expect(ids).toHaveLength(PAGES * PER_PAGE);
            expect(new Set(ids).size).toBe(PAGES * PER_PAGE);
        });

        test("on every page is requested again, also when the first page is interrupted", async () => {
            for (let page = 0; page < PAGES; page++) {
                server.interrupt.set(`/page/${page}`, 1);
            }
            server.interrupt.set("/ldes", 1);

            const members = await collect(`${server.base}/ldes`);

            expect(new Set(members.map((member) => member.id.value)).size).toBe(PAGES * PER_PAGE);
        });
    });

    describe("in an LDES 2.0", () => {
        const server = new InterruptingServer(3207);
        const description = `ex:ES a ldes:EventStream ;
    ldes:timestampPath dcterms:created ;
    ldes:memberType ex:Record .`;

        /** A message log in TriG: messages are separated by MESSAGE */
        function trig(path: string, ...messages: string[]) {
            server.pages.set(path, {
                body:
                    `VERSION "1.2-messages"\n${PREFIXES}\n` +
                    messages.map((message) => message.replaceAll("<>", `<${server.base}${path}>`)).join("\nMESSAGE\n"),
                type: "application/trig",
            });
        }
        const record = (name: string, time: string) =>
            `ex:${name} a ex:Record ; dcterms:created "${time}"^^xsd:dateTime ; ex:label "${LABEL}${name}" .`;

        beforeAll(() => server.start());
        afterAll(() => server.stop());
        beforeEach(() => {
            server.reset();
            trig(
                "/root",
                `${description}
<> ldes:relation
   [ ldes:page <${server.base}/a> ; ldes:timeFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ; ldes:timeUntil "2026-01-10T00:00:00Z"^^xsd:dateTime ] ,
   [ ldes:page <${server.base}/b> ; ldes:timeFrom "2026-01-02T00:00:00Z"^^xsd:dateTime ; ldes:timeUntil "2026-01-10T00:00:00Z"^^xsd:dateTime ] .`,
            );
            // A page that holds several members: some of its messages are complete when the connection drops
            trig(
                "/a",
                record("a1", "2026-01-01T00:00:00Z"),
                record("a2", "2026-01-03T00:00:00Z"),
                record("a3", "2026-01-05T00:00:00Z"),
                record("a4", "2026-01-07T00:00:00Z"),
                record("a5", "2026-01-09T00:00:00Z"),
            );
            trig("/b", record("b1", "2026-01-02T00:00:00Z"), record("b2", "2026-01-04T00:00:00Z"));
        });
        afterEach(() => {
            expect(server.interrupted).toBeGreaterThan(0);
        });

        const ids = (members: Member[]) => members.map((member) => member.id.value.replace("http://example.org/", ""));

        test("is requested again, and every member is emitted once, in order", async () => {
            server.interrupt.set("/a", 1);

            const members = await collect(`${server.base}/root`);

            expect(ids(members)).toEqual(["a1", "b1", "a2", "b2", "a3", "a4", "a5"]);
        });

        test("of the first page is requested again", async () => {
            server.interrupt.set("/root", 1);

            const members = await collect(`${server.base}/root`);

            expect(ids(members)).toEqual(["a1", "b1", "a2", "b2", "a3", "a4", "a5"]);
        });
    });
});
