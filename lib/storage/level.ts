/**
 * Level-backed storage adapter.
 *
 * Wraps Level sublevels into the KVStore interface. Level v10 returns
 * undefined for missing keys (no LEVEL_NOT_FOUND throw), matching KVStore
 * semantics directly.
 */

import { Level } from "level";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { KVStore, Storage } from "./index";

/**
 * Structural interface for the Level sublevel methods we actually use.
 * Level sublevels always use string keys, so this reflects that reality.
 */
interface LevelLike<V> {
    get(key: string): Promise<V | undefined>;
    put(key: string, value: V): Promise<void>;
    del(key: string): Promise<void>;
    clear(): Promise<void>;
    values(): { all(): Promise<V[]> };
}

/**
 * Level sublevels only accept string keys, but KVStore allows string | number.
 * This adapter stringifies number keys so the types stay honest.
 */
class LevelKVStore<K extends string | number, V> implements KVStore<K, V> {
    private sublevel: LevelLike<V>;

    constructor(sublevel: LevelLike<V>) {
        this.sublevel = sublevel;
    }

    private key(k: K): string {
        return String(k);
    }

    async get(key: K): Promise<V | undefined> {
        // Level v10 returns undefined for missing keys (no throw)
        return await this.sublevel.get(this.key(key));
    }

    async put(key: K, value: V): Promise<void> {
        await this.sublevel.put(this.key(key), value);
    }

    async del(key: K): Promise<void> {
        // Level v10 del() is a no-op for missing keys
        await this.sublevel.del(this.key(key));
    }

    async has(key: K): Promise<boolean> {
        // Level v10 returns undefined for missing keys (no throw)
        const val = await this.sublevel.get(this.key(key));
        return val !== undefined;
    }

    async clear(): Promise<void> {
        await this.sublevel.clear();
    }

    values(): { all(): Promise<V[]> } {
        return {
            all: async (): Promise<V[]> => {
                return await this.sublevel.values().all();
            },
        };
    }
}

export class LevelStorage implements Storage {
    private location: string;
    private isTemporary: boolean;
    private db?: Level;
    private fresh: boolean;

    constructor(location?: string, fresh?: boolean) {
        this.fresh = fresh ?? false;
        if (location) {
            this.location = location;
            this.isTemporary = false;
        } else {
            this.location = this.getDefaultLocation();
            this.isTemporary = true;
        }
    }

    private getDefaultLocation(): string {
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
        if (typeof window !== "undefined") {
            return `ldes-client-${id}`;
        } else {
            return path.join(os.tmpdir(), `ldes-client-${id}`);
        }
    }

    async init(fresh = false): Promise<void> {
        if (!this.db) {
            this.ensureStatePath(this.location);
            this.db = new Level(this.location);
        }
        await this.db.open();
        if (fresh || this.fresh) {
            // Clear through Level so this also works with IndexedDB and keeps
            // existing sublevel handles attached to the same database.
            await this.db.clear();
            this.fresh = false;
        }
    }

    store<K extends string | number, V>(name: string): KVStore<K, V> {
        if (!this.db) {
            throw new Error("Storage not initialized");
        }
        const sub = this.db.sublevel<string, V>(name, { valueEncoding: "json" });
        return new LevelKVStore<K, V>(sub);
    }

    async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
        }
        if (this.isTemporary) {
            this.clearFiles();
        }
    }

    private clearFiles(): void {
        if (typeof window === "undefined") {
            if (fs.existsSync(this.location)) {
                fs.readdirSync(this.location).forEach((file) => {
                    fs.rmSync(path.join(this.location, file), {
                        recursive: true,
                        force: true,
                    });
                });
            }
        } else {
            const request = indexedDB.deleteDatabase(this.location);
            request.onerror = () => {};
        }
    }

    private ensureStatePath(p: string): void {
        if (typeof window === "undefined") {
            if (!fs.existsSync(p)) {
                fs.mkdirSync(p, { recursive: true });
            }
        }
    }
}
