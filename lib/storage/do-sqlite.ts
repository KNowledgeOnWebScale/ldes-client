/**
 * Durable Object SQLite storage adapter for Cloudflare Workers.
 *
 * Uses a single table (default `ldes_client_storage`) with a `store` column
 * to partition keys. Values are JSON-serialized.
 *
 * Import from "ldes-client/storage/do-sqlite" to avoid pulling
 * @cloudflare/workers-types into non-CF builds.
 */

import type { KVStore, Storage } from "./index";

/**
 * Minimal typing for the Durable Object storage SQL interface.
 * Avoids a hard dependency on @cloudflare/workers-types at runtime.
 */
type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

interface SqlCursor<T> {
    toArray(): T[];
    one(): T;
}

interface DOStorage {
    sql: SqlStorage;
}

class DOSqliteKVStore<K extends string | number, V> implements KVStore<K, V> {
    private sql: SqlStorage;
    private table: string;
    private name: string;

    constructor(sql: SqlStorage, table: string, name: string) {
        this.sql = sql;
        this.table = table;
        this.name = name;
    }

    async get(key: K): Promise<V | undefined> {
        const rows = this.sql.exec<{ value: string }>(
            `SELECT value FROM "${this.table}" WHERE store = ? AND key = ?`,
            this.name,
            String(key),
        ).toArray();
        if (rows.length === 0) return undefined;
        return JSON.parse(rows[0].value) as V;
    }

    async put(key: K, value: V): Promise<void> {
        this.sql.exec(
            `INSERT OR REPLACE INTO "${this.table}" (store, key, value) VALUES (?, ?, ?)`,
            this.name,
            String(key),
            JSON.stringify(value),
        );
    }

    async del(key: K): Promise<void> {
        this.sql.exec(
            `DELETE FROM "${this.table}" WHERE store = ? AND key = ?`,
            this.name,
            String(key),
        );
    }

    async has(key: K): Promise<boolean> {
        const rows = this.sql.exec<{ c: number }>(
            `SELECT COUNT(*) as c FROM "${this.table}" WHERE store = ? AND key = ?`,
            this.name,
            String(key),
        ).toArray();
        return rows[0].c > 0;
    }

    async clear(): Promise<void> {
        this.sql.exec(`DELETE FROM "${this.table}" WHERE store = ?`, this.name);
    }

    values(): { all(): Promise<V[]> } {
        return {
            all: async (): Promise<V[]> => {
                const rows = this.sql.exec<{ value: string }>(
                    `SELECT value FROM "${this.table}" WHERE store = ? ORDER BY key`,
                    this.name,
                ).toArray();
                return rows.map((row) => JSON.parse(row.value) as V);
            },
        };
    }
}

export class DOSqliteStorage implements Storage {
    private sql: SqlStorage;
    private table: string;

    constructor(storage: DOStorage, table = "ldes_client_storage") {
        this.sql = storage.sql;
        this.table = table.replace(/"/g, "\"\"");
        this.sql.exec(
            `CREATE TABLE IF NOT EXISTS "${this.table}" (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key))`
        );
    }

    store<K extends string | number, V>(name: string): KVStore<K, V> {
        return new DOSqliteKVStore<K, V>(this.sql, this.table, name);
    }

    init(fresh?: boolean): void {
        if (fresh) {
            this.sql.exec(`DELETE FROM "${this.table}"`);
        }
    }

    async close(): Promise<void> {
        // Durable Object storage is managed by the runtime; nothing to close
    }
}
