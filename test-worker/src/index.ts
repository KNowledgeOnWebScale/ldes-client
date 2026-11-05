/**
 * Test Cloudflare Worker that consumes an LDES stream using the adapted client
 * with Durable Object SQLite storage.
 *
 * Routes:
 *   GET  /replicate?url=<ldes-url>&count=<n>&urlIsView=true
 *   GET  /mock/<name>/stream.ttl    — mock LDES root
 *   GET  /mock/<name>/page.ttl      — mock LDES page (members depend on phase)
 *   POST /mock/<name>/advance       — advance mock to next phase
 *   GET  /                          — healthcheck
 */

import { replicateLDES, intoConfig, enhanced_fetch } from "ldes-client";
import { DOSqliteStorage } from "ldes-client/storage/do-sqlite";

interface Env {
    LDES_STATE: DurableObjectNamespace;
    MOCK_LDES: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Mock LDES routes: /mock/<name>/<path>
        const mockMatch = url.pathname.match(/^\/mock\/([^/]+)\/(.+)$/);
        if (mockMatch) {
            const [, name, path] = mockMatch;
            const id = env.MOCK_LDES.idFromName(name);
            const stub = env.MOCK_LDES.get(id);
            return stub.fetch(new Request(
                `http://internal/${path}${url.search}`,
                { method: request.method },
            ));
        }

        if (url.pathname === "/replicate") {
            const ldesUrl = url.searchParams.get("url");
            const count = parseInt(url.searchParams.get("count") || "10", 10);
            const urlIsView = url.searchParams.get("urlIsView") === "true";

            if (!ldesUrl) {
                return new Response("Missing ?url= parameter", { status: 400 });
            }

            const startFresh = url.searchParams.get("startFresh") === "true";

            const id = env.LDES_STATE.idFromName(ldesUrl);
            const stub = env.LDES_STATE.get(id);
            return stub.fetch(
                new Request(
                    `http://internal/replicate?url=${encodeURIComponent(ldesUrl)}&count=${count}&urlIsView=${urlIsView}&startFresh=${startFresh}`,
                    { headers: request.headers },
                ),
            );
        }

        return new Response("LDES Client Test Worker", { status: 200 });
    },
};

// ---------------------------------------------------------------------------
// LDESState — runs the LDES client with DO SQLite storage
// ---------------------------------------------------------------------------

export class LDESState implements DurableObject {
    private ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, _env: Env) {
        this.ctx = ctx;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const ldesUrl = url.searchParams.get("url")!;
        const count = parseInt(url.searchParams.get("count") || "10", 10);
        const urlIsView = url.searchParams.get("urlIsView") === "true";
        const startFresh = url.searchParams.get("startFresh") === "true";
        const authHeader = request.headers.get("Authorization");

        try {
            const storage = new DOSqliteStorage(this.ctx.storage);

            const client = replicateLDES(
                intoConfig({
                    url: ldesUrl,
                    urlIsView,
                    startFresh,
                    storage,
                    fetch: enhanced_fetch({}, (input: RequestInfo | URL, init?: RequestInit) => {
                        const headers = new Headers(init?.headers);
                        if (authHeader) {
                            headers.set("Authorization", authHeader);
                        }
                        return fetch(input, { ...init, headers });
                    }),
                }),
            );

            const reader = client.stream({ highWaterMark: 10 }).getReader();
            const members: { id: string | undefined; quads: number }[] = [];

            while (members.length < count) {
                const { done, value } = await reader.read();
                if (done) break;
                members.push({
                    id: value.id?.value,
                    quads: value.quads.length,
                });
            }

            await reader.cancel();

            return Response.json({
                url: ldesUrl,
                requested: count,
                received: members.length,
                members,
            });
        } catch (err) {
            return Response.json(
                { error: String(err), stack: (err as Error).stack },
                { status: 500 },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// MockLDES — serves a fake LDES stream with controllable phases
// ---------------------------------------------------------------------------

/**
 * Phase 1: page has 3 members (mem1, mem2, mem3)
 * Phase 2: page has 6 members (mem1..mem6)
 *
 * POST /advance transitions from phase 1 → 2.
 */
export class MockLDES implements DurableObject {
    private ctx: DurableObjectState;
    private phase = 1;

    constructor(ctx: DurableObjectState, _env: Env) {
        this.ctx = ctx;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Restore phase from SQLite (survives across requests)
        this.phase = (await this.ctx.storage.get<number>("phase")) ?? 1;

        if (request.method === "POST" && url.pathname === "/advance") {
            this.phase++;
            await this.ctx.storage.put("phase", this.phase);
            return Response.json({ phase: this.phase });
        }

        if (url.pathname === "/stream.ttl") {
            return this.serveStream(request);
        }

        if (url.pathname === "/page.ttl") {
            return this.servePage(request);
        }

        return new Response("Not found", { status: 404 });
    }

    private serveStream(_request: Request): Response {
        const turtle = `
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://example.org/> .

<stream.ttl> a ldes:EventStream ;
    ldes:timestampPath ex:modified ;
    ldes:versionOfPath ex:isVersionOf ;
    tree:shape [
        a sh:NodeShape ;
        sh:targetClass ex:Thing ;
        sh:property [
            a sh:PropertyShape ;
            sh:path ex:modified ;
            sh:datatype xsd:dateTime
        ]
    ] ;
    tree:view <page.ttl> .
`;
        return new Response(turtle.trim(), {
            headers: { "Content-Type": "text/turtle" },
        });
    }

    private servePage(_request: Request): Response {
        // Always include phase-1 members
        let members = `<mem1> , <mem2> , <mem3>`;
        let memberData = `
<mem1> a ex:Thing ;
    ex:isVersionOf <entity/1> ;
    ex:modified "2025-01-01T00:00:00Z"^^xsd:dateTime ;
    ex:value "first" .

<mem2> a ex:Thing ;
    ex:isVersionOf <entity/2> ;
    ex:modified "2025-01-02T00:00:00Z"^^xsd:dateTime ;
    ex:value "second" .

<mem3> a ex:Thing ;
    ex:isVersionOf <entity/3> ;
    ex:modified "2025-01-03T00:00:00Z"^^xsd:dateTime ;
    ex:value "third" .
`;

        if (this.phase >= 2) {
            members += ` , <mem4> , <mem5> , <mem6>`;
            memberData += `
<mem4> a ex:Thing ;
    ex:isVersionOf <entity/4> ;
    ex:modified "2025-01-04T00:00:00Z"^^xsd:dateTime ;
    ex:value "fourth" .

<mem5> a ex:Thing ;
    ex:isVersionOf <entity/5> ;
    ex:modified "2025-01-05T00:00:00Z"^^xsd:dateTime ;
    ex:value "fifth" .

<mem6> a ex:Thing ;
    ex:isVersionOf <entity/6> ;
    ex:modified "2025-01-06T00:00:00Z"^^xsd:dateTime ;
    ex:value "sixth" .
`;
        }

        const turtle = `
@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://example.org/> .

<stream.ttl> a ldes:EventStream ;
    tree:member ${members} .

<page.ttl> a tree:Node .

${memberData}
`;
        return new Response(turtle.trim(), {
            headers: { "Content-Type": "text/turtle" },
        });
    }
}
