import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableObjectState } from "@inferal-oss/cf-dosql";
import { ClientStateManager } from "../lib/state";
import type { Storage } from "../lib/storage";
import { LevelStorage } from "../lib/storage/level";
import { MemoryStorage } from "../lib/storage/memory";
import { DOSqliteStorage } from "../lib/storage/do-sqlite";

describe.each(["Level", "Memory", "SQLite"])("%s storage contract", (backend) => {
    let storage: Storage;
    let directory: string | undefined;
    let sqlite: ReturnType<typeof createDurableObjectState> | undefined;

    beforeEach(async () => {
        if (backend === "Level") {
            directory = await mkdtemp(join(tmpdir(), "ldes-storage-contract-"));
            storage = new LevelStorage(directory);
        } else if (backend === "Memory") {
            storage = new MemoryStorage();
        } else {
            sqlite = createDurableObjectState();
            storage = new DOSqliteStorage(sqlite.ctx.storage);
        }
        await storage.init?.();
    });

    afterEach(async () => {
        await storage.close();
        sqlite?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    test("reads do not mutate persisted JSON values", async () => {
        const store = storage.store<string, { nested: { value: number } }>("members");
        await store.put("key", { nested: { value: 1 } });
        const value = await store.get("key");
        value!.nested.value = 2;
        expect(await store.get("key")).toEqual({ nested: { value: 1 } });
        const values = await store.values().all();
        values[0].nested.value = 3;
        expect(await store.get("key")).toEqual({ nested: { value: 1 } });
    });

    test("numeric keys have the same identity as their string form", async () => {
        const store = storage.store<string | number, string>("keys");
        await store.put(1, "first");
        expect(await store.get("1")).toBe("first");
        expect(await store.has("1")).toBe(true);
        await store.put("1", "updated");
        expect(await store.values().all()).toEqual(["updated"]);
        await store.del(1);
        expect(await store.has("1")).toBe(false);
    });

    test("fresh initialization clears every namespace and existing handle", async () => {
        const members = storage.store<string, string>("members");
        const pages = storage.store<string, string>("pages");
        await members.put("member", "old member");
        await pages.put("page", "old page");
        await storage.init?.(true);
        expect(await members.values().all()).toEqual([]);
        expect(await pages.values().all()).toEqual([]);
        await members.put("new", "new member");
        expect(await storage.store<string, string>("members").get("new")).toBe("new member");
    });

    test("the state manager propagates fresh initialization to an injected adapter", async () => {
        await storage.store<string, string>("members").put("old", "saved");
        const manager = new ClientStateManager(storage, undefined, true);
        await manager.init();
        expect(await manager.build<string, string>("members").get("old")).toBeUndefined();
    });
});

test("SQLite fresh start clears shared state and preserves other tables", async () => {
    const sqlite = createDurableObjectState();
    try {
        const storage = new DOSqliteStorage(sqlite.ctx.storage, "orders_state");
        const shared = new DOSqliteStorage(sqlite.ctx.storage, "orders_state");
        const other = new DOSqliteStorage(sqlite.ctx.storage, "products_state");
        const sharedMembers = shared.store<string, string>("members");
        const otherMembers = other.store<string, string>("members");
        await sharedMembers.put("key", "saved order");
        await otherMembers.put("key", "saved product");

        await new ClientStateManager(storage, undefined, true).init();

        expect(await sharedMembers.get("key")).toBeUndefined();
        expect(await otherMembers.get("key")).toBe("saved product");
    } finally {
        sqlite.close();
    }
});

test("the state manager waits for asynchronous storage initialization", async () => {
    const memory = new MemoryStorage();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    const storage: Storage = {
        store: memory.store.bind(memory),
        close: memory.close.bind(memory),
        init: () => ready,
    };
    const manager = new ClientStateManager(storage);
    let initialized = false;
    const initializing = manager.init().then(() => {
        initialized = true;
    });
    try {
        await Promise.resolve();
        expect(initialized).toBe(false);
    } finally {
        release();
        await initializing;
    }
});

test("the state manager reports asynchronous initialization failures", async () => {
    const storage = new MemoryStorage();
    storage.init = async () => {
        throw new Error("initialization failed");
    };
    await expect(new ClientStateManager(storage).init()).rejects.toThrow("initialization failed");
});

test("the Level constructor's fresh flag survives injection and is consumed once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ldes-storage-fresh-"));
    const first = new LevelStorage(directory);
    const second = new LevelStorage(directory, true);
    try {
        await first.init();
        await first.store<string, string>("members").put("old", "saved");
        await first.close();
        const manager = new ClientStateManager(second);
        await manager.init();
        expect(await manager.build<string, string>("members").get("old")).toBeUndefined();
        await manager.build<string, string>("members").put("new", "saved");
        await second.init();
        expect(await second.store<string, string>("members").get("new")).toBe("saved");
    } finally {
        await first.close();
        await second.close();
        await rm(directory, { recursive: true, force: true });
    }
});
