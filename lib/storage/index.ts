/**
 * Storage abstraction for the LDES client.
 *
 * These interfaces decouple the client from Level, allowing pluggable
 * backends (Level, in-memory, Durable Object SQLite, etc.).
 */

export interface KVStore<K extends string | number, V> {
    /** Keys use their string form; JSON values returned by reads are independent copies. */
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
    /** Resolve after opening/resetting storage, before the client builds stores. */
    init?(fresh?: boolean): void | Promise<void>;
}
