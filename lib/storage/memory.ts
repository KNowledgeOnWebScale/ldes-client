/**
 * In-memory storage adapter.
 *
 * Zero-dependency Map-backed implementation for testing and stateless use.
 * No persistence across restarts.
 */

import type { KVStore, Storage } from "./index";

class MemoryKVStore<K extends string | number, V> implements KVStore<K, V> {
    private store = new Map<string, V>();

    async get(key: K): Promise<V | undefined> {
        const value = this.store.get(String(key));
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    async put(key: K, value: V): Promise<void> {
        // Deep-clone via JSON round-trip to match Level's valueEncoding: "json" behavior
        this.store.set(String(key), JSON.parse(JSON.stringify(value)));
    }

    async del(key: K): Promise<void> {
        this.store.delete(String(key));
    }

    async has(key: K): Promise<boolean> {
        return this.store.has(String(key));
    }

    async clear(): Promise<void> {
        this.store.clear();
    }

    values(): { all(): Promise<V[]> } {
        return {
            all: async (): Promise<V[]> => {
                const entries = Array.from(this.store.entries());
                entries.sort((a, b) => {
                    const ka = String(a[0]), kb = String(b[0]);
                    return ka < kb ? -1 : ka > kb ? 1 : 0;
                });
                return entries.map(([, v]) => JSON.parse(JSON.stringify(v)) as V);
            },
        };
    }
}

export class MemoryStorage implements Storage {
    private stores = new Map<string, MemoryKVStore<string | number, unknown>>();

    store<K extends string | number, V>(name: string): KVStore<K, V> {
        if (!this.stores.has(name)) {
            this.stores.set(name, new MemoryKVStore<K, V>());
        }
        return this.stores.get(name)! as MemoryKVStore<K, V>;
    }

    async close(): Promise<void> {
        // No-op: callers own the MemoryStorage lifecycle.
        // Use init(fresh=true) to clear data explicitly.
    }

    async init(fresh?: boolean): Promise<void> {
        if (fresh) {
            await Promise.all(Array.from(this.stores.values(), (store) => store.clear()));
        }
    }
}
