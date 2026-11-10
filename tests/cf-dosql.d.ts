import type * as Workers from "@cloudflare/workers-types";

// cf-dosql ships its source and expects these Cloudflare types to be global.
// Expose only the SQLite types so the rest of the tests keep Node and DOM types.
declare global {
    type SqlStorage = Workers.SqlStorage;
    type SqlStorageValue = Workers.SqlStorageValue;
    type SqlStorageCursor<T extends Record<string, SqlStorageValue>> = Workers.SqlStorageCursor<T>;
    const SqlStorageCursor: typeof Workers.SqlStorageCursor;
    const SqlStorageStatement: typeof Workers.SqlStorageStatement;
}
