import { getLoggerFor } from "./utils";
import type { KVStore, Storage } from "./storage";

export class ClientStateManager {
    private logger = getLoggerFor(this);
    private storage?: Storage;
    private fresh: boolean;
    private levelArgs?: { location?: string; fresh?: boolean };

    constructor(storage?: Storage, location?: string, fresh?: boolean) {
        this.fresh = fresh ?? false;
        if (storage) {
            this.storage = storage;
        } else {
            this.levelArgs = { location, fresh };
        }
    }

    async init() {
        if (!this.storage) {
            const { LevelStorage } = await import("./storage/level");
            this.storage = new LevelStorage(this.levelArgs?.location, this.levelArgs?.fresh);
        }
        try {
            if (this.storage.init) {
                this.storage.init(this.fresh);
            }
        } catch (ex: unknown) {
            this.logger.error("Could not initialize the state manager");
            throw ex;
        }
    }

    build<K extends string | number, V>(prefix: string): KVStore<K, V> {
        if (!this.storage) {
            throw new Error("Storage not initialized — call init() first");
        }
        return this.storage.store<K, V>(prefix);
    }

    async close() {
        if (this.storage) {
            await this.storage.close();
        }
    }
}
