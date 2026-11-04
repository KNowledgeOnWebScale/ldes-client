import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { createUriAndTermNamespace } from "@treecg/types";
import { RdfStore } from "rdf-stores";
import { replicateLDES } from "../../lib/client";
import type { LDESInfo, FetchedPage } from "../../lib/fetcher";


describe("Client tests (Browser)", () => {
    // Note: The globalSetup runs the server on port 3042
    const LDES = "http://localhost:3042/mock-ldes.ttl";
    const INBETWEEN_LDES = "http://localhost:3042/mock-ldes-inbetween.ttl";

    const EX = createUriAndTermNamespace(
        "http://example.org/",
        "Clazz1",
        "Clazz2",
        "modified",
        "isVersionOf",
        "prop1",
        "subprop",
    );

    const STATE_KEY = "client-state";

    async function databaseExists(name: string): Promise<boolean> {
        const databases = await indexedDB.databases();
        const prefixedName = "level-js-" + name;
        return databases.some(db => db.name === name || db.name === prefixedName);
    }


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
            expect(
                store.getQuads(null, EX.terms.subprop).length,
            ).toBeGreaterThan(0);
        }

        expect(client.memberCount).toBe(3);
        expect(client.fragmentCount).toBe(4);
        // Check that we received all memebers
        expect(memCount).toBe(client.memberCount);
        expect(gotFragmentEvent).toBe(true);
        expect(gotDescEvent).toBe(true);
        client.close();
    });

    test("Client runs successfully and all events are triggered", async () => {
        // Setup client
        // In browser, statePath acts as the localStorage key
        const client = replicateLDES({
            url: LDES,
            statePath: STATE_KEY + "-2",
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
            expect(
                store.getQuads(null, EX.terms.subprop).length,
            ).toBeGreaterThan(0);
        }

        expect(client.memberCount).toBe(12);
        expect(client.fragmentCount).toBe(4);
        // Check that we received all memebers
        expect(memCount).toBe(client.memberCount);
        expect(gotFragmentEvent).toBe(true);
        expect(gotDescEvent).toBe(true);

        // Check that state was saved to IndexedDB
        expect(await databaseExists(STATE_KEY + "-2")).toBeTruthy();
        client.close();
    });

    test("Client interruption and resuming in unoredered replication", async () => {
        // Setup client 1
        const client1 = replicateLDES({
            url: LDES,
            statePath: STATE_KEY + "-3",
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
        client1.on("fragment", async (fragment: FetchedPage) => {
            gotFragmentEvent1 = true;

            // Interrupt the stream after getting a specific fragment
            if (fragment.url === "http://localhost:3042/mock-ldes-1.ttl") {
                await members1.cancel();
            }
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
                expect(
                    store.getQuads(null, EX.terms.subprop).length,
                ).toBeGreaterThan(0);
            }

            if (memRes1.done) {
                break;
            }
            memRes1 = await members1.read();
        }

        // Check that we received all memebers
        expect(memCount).toBe(client1.memberCount);
        expect(gotFragmentEvent1).toBe(true);
        expect(gotDescEvent1).toBe(true);
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-3")).toBeTruthy();

        /**
         * End of client 1
         */

        // Setup client 2
        const client2 = replicateLDES({
            url: LDES,
            statePath: STATE_KEY + "-3",
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
                expect(
                    store.getQuads(null, EX.terms.subprop).length,
                ).toBeGreaterThan(0);
            }

            if (memRes2.done) {
                break;
            }
            memRes2 = await members2.read();
        }

        // Check the total count of members
        expect(client1.memberCount + client2.memberCount).toBe(12);
        // Check that we received all members
        expect(memCount).toBe(client1.memberCount + client2.memberCount);
        expect(gotFragmentEvent2).toBe(true);
        expect(gotDescEvent2).toBe(true);
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-3")).toBeTruthy();

        client1.close();
        client2.close();
    });

    test("Client interruption and resuming in ordered replication (ascending)", async () => {
        // Setup client 1
        const client1 = replicateLDES(
            {
                url: LDES,
                statePath: STATE_KEY + "-4",
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
        client1.on("fragment", async (fragment: FetchedPage) => {
            gotFragmentEvent1 = true;

            // Interrupt the stream after getting a specific fragment
            if (fragment.url === "http://localhost:3042/mock-ldes-1.ttl") {
                await members1.cancel();
            }
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
                expect(
                    store.getQuads(null, EX.terms.subprop).length,
                ).toBeGreaterThan(0);
            }

            if (memRes1.done) {
                break;
            }
            memRes1 = await members1.read();
        }

        // Check that we received all memebers
        expect(memCount).toBe(client1.memberCount);
        expect(gotFragmentEvent1).toBe(true);
        expect(gotDescEvent1).toBe(true);
        // Check that the timestamps are in ascending order
        expect(
            timestamps1.every((v, i) => i === 0 || v >= timestamps1[i - 1]),
        ).toBeTruthy();
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-4")).toBeTruthy();

        /**
         * End of client 1
         */

        // Setup client 2
        const client2 = replicateLDES(
            {
                url: LDES,
                statePath: STATE_KEY + "-4",
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
                expect(
                    store.getQuads(null, EX.terms.subprop).length,
                ).toBeGreaterThan(0);
            }

            if (memRes2.done) {
                break;
            }
            memRes2 = await members2.read();
        }

        // Check the total count of members
        expect(client1.memberCount + client2.memberCount).toBe(12);
        // Check that we received all members
        expect(memCount).toBe(client1.memberCount + client2.memberCount);
        expect(gotFragmentEvent2).toBe(true);
        expect(gotDescEvent2).toBe(true);
        // Check that the timestamps are in ascending order
        expect(
            timestamps2.every((v, i) => i === 0 || v >= timestamps2[i - 1]),
        ).toBeTruthy();
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-4")).toBeTruthy();

        client1.close();
        client2.close();
    });

    test("Client interruption and resuming in ordered replication (descending)", async () => {
        // Setup client 1
        const client1 = replicateLDES(
            {
                url: LDES,
                statePath: STATE_KEY + "-5",
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
        client1.on("fragment", async (fragment: FetchedPage) => {
            gotFragmentEvent1 = true;

            // Interrupt the stream after getting a specific fragment
            if (fragment.url === "http://localhost:3042/mock-ldes-1.ttl") {
                await members1.cancel();
            }
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

        // Check that no members were received
        expect(memCount).toBe(client1.memberCount);
        expect(gotFragmentEvent1).toBe(true);
        expect(gotDescEvent1).toBe(true);
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-5")).toBeTruthy();

        /**
         * End of client 1
         */

        // Setup client 2
        const client2 = replicateLDES(
            {
                url: LDES,
                statePath: STATE_KEY + "-5",
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
                expect(
                    store.getQuads(null, EX.terms.subprop).length,
                ).toBeGreaterThan(0);
            }

            if (memRes2.done) {
                break;
            }
            memRes2 = await members2.read();
        }

        // Check the total count of members
        expect(client1.memberCount + client2.memberCount).toBe(12);
        // Check that we received all members
        expect(memCount).toBe(client1.memberCount + client2.memberCount);
        expect(gotFragmentEvent2).toBe(true);
        expect(gotDescEvent2).toBe(true);
        // Check that the timestamps are in ascending order
        expect(
            timestamps2.every((v, i) => i === 0 || v <= timestamps2[i - 1]),
        ).toBeTruthy();
        // Check that state was saved
        expect(await databaseExists(STATE_KEY + "-5")).toBeTruthy();

        client1.close();
        client2.close();
    });
});