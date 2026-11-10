import type { AddressInfo } from "node:net";
import { describe, beforeAll, afterAll, afterEach, expect, test } from "vitest";
import fs from "fs";
import path from "path";
import { fastify, RequestPayload } from "fastify";
import { fastifyStatic } from "@fastify/static";
import { createUriAndTermNamespace } from "@treecg/types";
import { RdfStore } from "rdf-stores";
import { streamToString } from "../lib/utils";
import { replicateLDES } from "../lib/client";
import { MemoryStorage } from "../lib/storage/memory";
import { DOSqliteStorage } from "../lib/storage/do-sqlite";
import { createDurableObjectState } from "@inferal-oss/cf-dosql";

import type { FastifyInstance } from "fastify";
import type { FetchedPage, LDESInfo } from "../lib/types";

describe("Client tests", () => {
    const LDES = "http://localhost:3001/mock-ldes.ttl";
    const LINKED_LIST_LDES = "http://localhost:3001/mock-ldes-linked-list.ttl";
    const INBETWEEN_LDES = "http://localhost:3001/mock-ldes-inbetween.ttl";
    const CALENDAR_LDES = "http://localhost:3001/mock-calendar-ldes.ttl";
    const REVERSE_LDES = "http://localhost:3001/mock-ldes-reverse.ttl";
    const EX = createUriAndTermNamespace("http://example.org/", "Clazz1", "Clazz2", "modified", "isVersionOf", "prop1", "subprop");

    let server: FastifyInstance;

    beforeAll(async () => {
        // Setup mock http server
        try {
            server = fastify();
            server.register(fastifyStatic, {
                root: path.join(__dirname, "./data/mock-ldes"),
            });
            server.addHook("onSend", async (request, reply, payload: RequestPayload) => {
                const st = await streamToString(payload);

                if (st.startsWith("# delay ")) {
                    const reg = /# delay (?<delay>[0-9]+)/;
                    const found = st.match(reg);
                    const delay = found?.groups && found?.groups["delay"];
                    console.log("found delay", delay);
                    if (delay) {
                        try {
                            const delayInt = parseInt(delay);
                            await new Promise((res) => setTimeout(res, delayInt));
                            /* eslint no-empty: ["error", { "allowEmptyCatch": true }] */
                        } catch (ex: unknown) {
                            /* empty */
                        }
                    }
                }
                if (st.startsWith("# immutable")) {
                    reply.header("Cache-Control", "immutable");
                }
                return st;
            });

            await server.listen({ port: 3001 });
            console.log(`Mock server listening on ${(server.addresses()[0] as AddressInfo).port}`);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    });

    interface StorageBackend {
        name: string;
        configOverrides(): Record<string, unknown>;
        reset(): void;
        persistsToFs: boolean;
    }

    const backends: StorageBackend[] = [
        {
            name: "LevelStorage",
            configOverrides() {
                return { statePath: "client-state-main" };
            },
            reset() {
                fs.rmSync("client-state-main", { recursive: true, force: true });
            },
            persistsToFs: true,
        },
        (() => {
            let storage: MemoryStorage | null = null;
            return {
                name: "MemoryStorage",
                configOverrides() {
                    if (!storage) storage = new MemoryStorage();
                    return { storage };
                },
                reset() {
                    storage = null;
                },
                persistsToFs: false,
            };
        })(),
        (() => {
            let state: ReturnType<typeof createDurableObjectState> | null = null;
            let storage: DOSqliteStorage | null = null;
            return {
                name: "DOSqliteStorage",
                configOverrides() {
                    if (!state) {
                        state = createDurableObjectState();
                        storage = new DOSqliteStorage(state.ctx.storage);
                    }
                    return { storage };
                },
                reset() {
                    if (state) state.close();
                    state = null;
                    storage = null;
                },
                persistsToFs: false,
            };
        })(),
    ];

    afterAll(async () => {
        await server.close();
    });

    // TODO: Migrate client tests from RDFC to this file

    test("Fetching a tree:InBetweenRelation LDES subset", async () => {
        // Setup client
        const client = replicateLDES({
            url: INBETWEEN_LDES,
            after: new Date("2024-10-01T00:00:00Z"),
        });

        // Check that fragment event is triggered
        let gotFragmentEvent = false;
        client.on("fragment", async () => {
            gotFragmentEvent = true;
        });

        // Check that description event is triggered
        let gotDescEvent = false;
        client.on("description", async (info: LDESInfo) => {
            expect(info).toBeDefined();
            expect(info.shape).toBeDefined();
            expect(info.timestampPath?.value).toBe(EX.modified);
            expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
            gotDescEvent = true;
        });

        // Start stream of members
        let memCount = 0;
        const members = client.stream({ highWaterMark: 10 });

        for await (const mem of members) {
            memCount += 1;
            expect(mem.id.value).toBeDefined();
            expect(mem.quads.length).toBeGreaterThan(0);
            expect(mem.timestamp).toBeDefined();
            expect(mem.isVersionOf).toBeDefined();

            // Check quad content
            const store = RdfStore.createDefault();
            mem.quads.forEach((q) => store.addQuad(q));

            // Check that all member data is present
            expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
        }

        expect(client.memberCount).toBe(3);
        expect(client.fragmentCount).toBe(4);
        // Check that we received all members
        expect(memCount).toBe(client.memberCount);
        expect(gotFragmentEvent).toBe(true);
        expect(gotDescEvent).toBe(true);
    });

    test("Client runs successfuly and all events are triggered", async () => {
        // Setup client
        const client = replicateLDES({
            url: LDES,
        });

        // Check that fragment event is triggered
        let gotFragmentEvent = false;
        client.on("fragment", async () => {
            gotFragmentEvent = true;
        });

        // Check that description event is triggered
        let gotDescEvent = false;
        client.on("description", async (info: LDESInfo) => {
            expect(info).toBeDefined();
            expect(info.shape).toBeDefined();
            expect(info.timestampPath?.value).toBe(EX.modified);
            expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
            gotDescEvent = true;
        });

        // Start stream of members
        let memCount = 0;
        const members = client.stream({ highWaterMark: 10 });

        for await (const mem of members) {
            memCount += 1;
            expect(mem.id.value).toBeDefined();
            expect(mem.quads.length).toBeGreaterThan(0);
            expect(mem.timestamp).toBeDefined();
            expect(mem.isVersionOf).toBeDefined();

            // Check quad content
            const store = RdfStore.createDefault();
            mem.quads.forEach((q) => store.addQuad(q));

            // Check that all member data is present
            expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
        }

        expect(client.memberCount).toBe(12);
        expect(client.fragmentCount).toBe(4);
        // Check that we received all members
        expect(memCount).toBe(client.memberCount);
        expect(gotFragmentEvent).toBe(true);
        expect(gotDescEvent).toBe(true);
    });

    for (const backend of backends) {
        describe(`Storage: ${backend.name}`, () => {
            afterEach(() => backend.reset());

            test("Client interruption and resuming in unoredered replication", async () => {
                // Setup client 1
                const client1 = replicateLDES({
                    url: LDES,
                    ...backend.configOverrides(),
                });

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent1 = false;
                client1.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent1 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent1 = false;
                const closedPromise = new Promise<void>((resolve) => {
                    client1.on("fragment", async (fragment: FetchedPage) => {
                        gotFragmentEvent1 = true;

                        // Interrupt the stream after getting a specific fragment
                        if (fragment.url === "http://localhost:3001/mock-ldes-1.ttl") {
                            await members1.cancel();
                            resolve();
                        }
                    });
                });

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                await closedPromise;

                // Depending on when the interruption happens, sometimes the client manages to fetch more or less fragments
                expect(client1.memberCount).toBeGreaterThanOrEqual(3);
                expect(client1.fragmentCount).toBeGreaterThanOrEqual(3);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount);
                expect(gotFragmentEvent1).toBe(true);
                expect(gotDescEvent1).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES({
                    url: LDES,
                    ...backend.configOverrides(),
                });

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBeGreaterThanOrEqual(1);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(12);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client interruption and resuming in ordered replication (ascending)", async () => {
                // Setup client 1
                const client1 = replicateLDES(
                    {
                        url: LDES,
                        ...backend.configOverrides(),
                    },
                    "ascending",
                );

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent1 = false;
                client1.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent1 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent1 = false;
                const closedPromise = new Promise<void>((resolve) => {
                    client1.on("fragment", async (fragment: FetchedPage) => {
                        gotFragmentEvent1 = true;

                        // Interrupt the stream after getting a specific fragment
                        if (fragment.url === "http://localhost:3001/mock-ldes-1.ttl") {
                            await members1.cancel();
                            resolve();
                        }
                    });
                });

                const timestamps1: number[] = [];
                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Keep track o the timestamps
                        timestamps1.push((<Date>mem.timestamp).getTime());
                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                await closedPromise;

                // Depending on when the interruption happens, sometimes the client manages to fetch more or less fragments
                expect(client1.fragmentCount).toBeGreaterThanOrEqual(3);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount);
                expect(gotFragmentEvent1).toBe(true);
                expect(gotDescEvent1).toBe(true);
                // Check that the timestamps are in ascending order
                expect(timestamps1.every((v, i) => i === 0 || v >= timestamps1[i - 1])).toBeTruthy();
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES(
                    {
                        url: LDES,
                        ...backend.configOverrides(),
                    },
                    "ascending",
                );

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                const timestamps2: number[] = [];
                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Keep track o the timestamps
                        timestamps2.push((<Date>mem.timestamp).getTime());
                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBeGreaterThanOrEqual(2);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(12);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that the timestamps are in ascending order
                expect(timestamps2.every((v, i) => i === 0 || v >= timestamps2[i - 1])).toBeTruthy();
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client interruption and resuming in ordered replication (descending)", async () => {
                // Setup client 1
                const client1 = replicateLDES(
                    {
                        url: LDES,
                        ...backend.configOverrides(),
                    },
                    "descending",
                );

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent1 = false;
                client1.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent1 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent1 = false;
                const closedPromise = new Promise<void>((resolve) => {
                    client1.on("fragment", async (fragment: FetchedPage) => {
                        gotFragmentEvent1 = true;

                        // Interrupt the stream after getting a specific fragment
                        if (fragment.url === "http://localhost:3001/mock-ldes-1.ttl") {
                            await members1.cancel();
                            resolve();
                        }
                    });
                });

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                await closedPromise;

                // Depending on when the interruption happens, sometimes the client manages to fetch more or less fragments
                expect(client1.memberCount).toBe(0);
                expect(client1.fragmentCount).toBeGreaterThanOrEqual(3);
                // Check that no members were received
                expect(memCount).toBe(client1.memberCount);
                expect(gotFragmentEvent1).toBe(true);
                expect(gotDescEvent1).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES(
                    {
                        url: LDES,
                        ...backend.configOverrides(),
                    },
                    "descending",
                );

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                const timestamps2: number[] = [];
                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Keep track o the timestamps
                        timestamps2.push((<Date>mem.timestamp).getTime());
                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBeGreaterThanOrEqual(2);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(12);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that the timestamps are in ascending order
                expect(timestamps2.every((v, i) => i === 0 || v <= timestamps2[i - 1])).toBeTruthy();
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client interruption and resuming in ordered replication (ascending) of Linked List LDES", async () => {
                // Setup client 1
                const client1 = replicateLDES(
                    {
                        url: LINKED_LIST_LDES,
                        ...backend.configOverrides(),
                    },
                    "ascending",
                );

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent1 = false;
                client1.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent1 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent1 = false;
                const closedPromise = new Promise<void>((resolve) => {
                    client1.on("fragment", async (fragment: FetchedPage) => {
                        gotFragmentEvent1 = true;

                        // Interrupt the stream after getting a specific fragment
                        if (fragment.url === "http://localhost:3001/mock-ldes-linked-list-1.ttl") {
                            await members1.cancel();
                            resolve();
                        }
                    });
                });

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                await closedPromise;
                // Depending on when the interruption happens, sometimes the client manages to fetch more or less fragments
                expect(client1.memberCount).toBe(0);
                expect(client1.fragmentCount).toBeGreaterThanOrEqual(2);
                // Check that no members were received
                expect(memCount).toBe(client1.memberCount);
                expect(gotFragmentEvent1).toBe(true);
                expect(gotDescEvent1).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES(
                    {
                        url: LINKED_LIST_LDES,
                        ...backend.configOverrides(),
                    },
                    "ascending",
                );

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                const timestamps2: number[] = [];
                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Keep track o the timestamps
                        timestamps2.push((<Date>mem.timestamp).getTime());
                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBeGreaterThanOrEqual(2);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(9);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that the timestamps are in ascending order
                expect(timestamps2.every((v, i) => i === 0 || v >= timestamps2[i - 1])).toBeTruthy();
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client interruption and resuming in ordered replication (descending) of Linked List LDES", async () => {
                // Setup client 1
                const client1 = replicateLDES(
                    {
                        url: LINKED_LIST_LDES,
                        ...backend.configOverrides(),
                    },
                    "descending",
                );

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                // Check that fragment event is triggered
                let gotFragmentEvent1 = false;
                const closedPromise = new Promise<void>((resolve) => {
                    client1.on("fragment", async (fragment: FetchedPage) => {
                        gotFragmentEvent1 = true;

                        // Interrupt the stream after getting a specific fragment
                        if (fragment.url === "http://localhost:3001/mock-ldes-linked-list.ttl") {
                            await members1.cancel();
                            resolve();
                        }
                    });
                });

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                await closedPromise;
                // Depending on when the interruption happens, sometimes the client manages to fetch more or less fragments
                expect(client1.memberCount).toBe(0);
                expect(client1.fragmentCount).toBeGreaterThanOrEqual(1);
                // Check that no members were received
                expect(memCount).toBe(client1.memberCount);
                expect(gotFragmentEvent1).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES(
                    {
                        url: LINKED_LIST_LDES,
                        ...backend.configOverrides(),
                    },
                    "descending",
                );

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                const timestamps2: number[] = [];
                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();

                        // Keep track o the timestamps
                        timestamps2.push((<Date>mem.timestamp).getTime());
                        // Check quad content
                        const store = RdfStore.createDefault();
                        mem.quads.forEach((q) => store.addQuad(q));

                        // Check that all member data is present
                        expect(store.getQuads(null, EX.terms.subprop).length).toBeGreaterThan(0);
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBe(4);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(9);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that the timestamps are in ascending order
                expect(timestamps2.every((v, i) => i === 0 || v <= timestamps2[i - 1])).toBeTruthy();
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client runs twice and only receives filtered members from a calendar-fragmented LDES", async () => {
                // Setup client 1
                const client1 = replicateLDES({
                    ...backend.configOverrides(),
                    url: CALENDAR_LDES,
                    urlIsView: true,
                    after: new Date("2025-01-02T00:00:00.000Z"),
                });

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();
                        expect((mem.timestamp as Date).getTime()).toBeGreaterThanOrEqual(new Date("2025-01-02T00:00:00.000Z").getTime());
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                expect(client1.memberCount).toBe(3);
                expect(client1.fragmentCount).toBe(5);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES({
                    ...backend.configOverrides(),
                    url: CALENDAR_LDES,
                    urlIsView: true,
                    after: new Date("2025-01-02T00:00:00.000Z"),
                });

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();
                        expect((mem.timestamp as Date).getTime()).toBeLessThan(new Date("2025-01-02T00:00:00.000Z").getTime());
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                expect(client2.fragmentCount).toBe(3);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(3);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client runs twice and only receives the latest version of every member in a reversed LDES", async () => {
                // Setup client 1
                const client1 = replicateLDES({
                    ...backend.configOverrides(),
                    url: REVERSE_LDES,
                    lastVersionOnly: true,
                });

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        // Check that we only receive the latest version of every member
                        expect(mem.id.value).toContain("#1");
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                expect(client1.memberCount).toBe(6);
                expect(client1.fragmentCount).toBe(4);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES({
                    ...backend.configOverrides(),
                    url: REVERSE_LDES,
                    lastVersionOnly: true,
                });

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                // Only 2 fragments are expected due to immutable fragments
                expect(client2.fragmentCount).toBe(2);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(6);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client runs twice with temporal filters and only receives the latest version of every member in a reversed LDES", async () => {
                // Setup client 1
                const client1 = replicateLDES({
                    ...backend.configOverrides(),
                    url: REVERSE_LDES,
                    after: new Date("2024-07-12T00:00:00.000Z"),
                    lastVersionOnly: true,
                });

                let memCount = 0;

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                let memRes1 = await members1.read();
                while (memRes1) {
                    const mem = memRes1.value;

                    if (mem) {
                        // Check that we only receive the latest version of every member
                        expect(mem.id.value).toContain("#1");
                        expect(mem.id.value).toBeDefined();
                        expect(mem.quads.length).toBeGreaterThan(0);
                        expect(mem.timestamp).toBeDefined();
                        expect(mem.isVersionOf).toBeDefined();
                        memCount += 1;
                    }

                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                expect(client1.memberCount).toBe(6);
                expect(client1.fragmentCount).toBe(4);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                // Setup client 2
                const client2 = replicateLDES({
                    ...backend.configOverrides(),
                    url: REVERSE_LDES,
                    after: new Date("2024-07-12T00:00:00.000Z"),
                    lastVersionOnly: true,
                });

                // Member stream object
                const members2 = client2.stream({ highWaterMark: 10 }).getReader();

                // Check that description event is triggered
                let gotDescEvent2 = false;
                client2.on("description", async (info: LDESInfo) => {
                    expect(info).toBeDefined();
                    expect(info.shape).toBeDefined();
                    expect(info.timestampPath?.value).toBe(EX.modified);
                    expect(info.versionOfPath?.value).toBe(EX.isVersionOf);
                    gotDescEvent2 = true;
                });

                // Check that fragment event is triggered
                let gotFragmentEvent2 = false;
                client2.on("fragment", () => {
                    gotFragmentEvent2 = true;
                });

                let memRes2 = await members2.read();
                while (memRes2) {
                    const mem = memRes2.value;

                    if (mem) {
                        memCount += 1;
                        // Check that we only receive the latest version of every member
                        expect(mem.id.value).toContain("#1");
                    }

                    if (memRes2.done) {
                        break;
                    }
                    memRes2 = await members2.read();
                }

                // Only 2 fragments are expected due to immutable fragments
                expect(client2.fragmentCount).toBe(2);
                // Check the total count of members
                expect(client1.memberCount + client2.memberCount).toBe(6);
                // Check that we received all members
                expect(memCount).toBe(client1.memberCount + client2.memberCount);
                expect(gotFragmentEvent2).toBe(true);
                expect(gotDescEvent2).toBe(true);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }
            });

            test("Client runs twice with different conditions and throws error", async () => {
                // Setup client 1
                const client1 = replicateLDES({
                    ...backend.configOverrides(),
                    url: REVERSE_LDES,
                    after: new Date("2024-07-12T00:00:00.000Z"),
                });

                // Member stream object
                const members1 = client1.stream({ highWaterMark: 10 }).getReader();

                let memRes1 = await members1.read();
                while (memRes1) {
                    if (memRes1.done) {
                        break;
                    }
                    memRes1 = await members1.read();
                }

                expect(client1.memberCount).toBe(12);
                expect(client1.fragmentCount).toBe(4);
                // Check that state was saved
                if (backend.persistsToFs) {
                    expect(fs.existsSync("client-state-main")).toBeTruthy();
                }

                /**
                 * End of client 1
                 */

                let threwError = false;
                let client2;

                try {
                    // Setup client 2
                    client2 = replicateLDES({
                        ...backend.configOverrides(),
                        url: REVERSE_LDES,
                        before: new Date("2024-07-12T00:00:00.000Z"),
                    });

                    const members = client2.stream({ highWaterMark: 10 }).getReader();
                    await members.read();
                } catch (e) {
                    threwError = true;
                    await client2?.close();
                }

                expect(threwError).toBeTruthy();
            });
        }); // describe Storage
    } // for backends

    test("Client throws error when configured SHACL shape cannot be dereferenced", async () => {
        let threwError = false;
        let client;
        try {
            // Setup client
            client = replicateLDES({
                url: LDES,
                shapeFile: "http://localhost:3001/invalid-shape.ttl",
            });

            const members = client.stream({ highWaterMark: 10 }).getReader();
            await members.read();
        } catch (e) {
            threwError = true;
            await client?.close();
        }

        expect(threwError).toBeTruthy();
    });
});
