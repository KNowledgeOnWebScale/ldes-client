/**
 * Storage abstraction for the LDES client.
 *
 * These interfaces decouple the client from Level, allowing pluggable
 * backends (Level, in-memory, Durable Object SQLite, etc.).
 */

export interface KVStore<K extends string | number, V> {
    get(key: K): Promise<V | undefined>;
    put(key: K, value: V): Promise<void>;
    del(key: K): Promise<void>;
    has(key: K): Promise<boolean>;
    clear(): Promise<void>;
    values(): { all(): Promise<V[]> };
}

export interface Storage {
    store<K extends string | number, V>(name: string): KVStore<K, V>;
    close(): Promise<void>;
    init?(fresh?: boolean): void;
}
