import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Level } from "level";
import { getLoggerFor } from "./utils";

export class ClientStateManager {
    private logger = getLoggerFor(this);
    private location: string;
    private isTemporary: boolean;
    private db?: Level;

    constructor(location?: string, fresh?: boolean) {
        if (location) {
            this.location = location;
            this.isTemporary = false;
            if (fresh) {
                this.clear();
            }
        } else {
            this.location = this.getDefaultLocation();
            this.isTemporary = true;
        }
    }

    private getDefaultLocation(): string {
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
        if (typeof window !== "undefined") {
            // Browser: use a unique name for IndexedDB
            return `ldes-client-${id}`;
        } else {
            // Node.js: use a unique path in the OS temp directory
            return path.join(os.tmpdir(), `ldes-client-${id}`);
        }
    }

    init() {
        try {
            ensureStatePath(this.location);
            this.db = new Level(this.location);
        } catch (ex: unknown) {
            this.logger.error("Could not initialize the state manager LevelDB instance");
            throw ex;
        }
    }

    build<K, V>(prefix: string): Level<K, V> {
        if (!this.db) {
            throw new Error("State manager not initialized");
        }
        return this.db.sublevel<K, V>(prefix, { valueEncoding: "json" }) as unknown as Level<K, V>;
    }

    async close() {
        if (this.db) {
            await this.db.close();
        }
        if (this.isTemporary) {
            this.clear();
        }
    }

    private clear() {
        this.logger.debug("Clearing state manager");
        if (typeof window === "undefined") {
            if (fs.existsSync(this.location)) {
                fs.readdirSync(this.location).forEach((file) => {
                    fs.rmSync(path.join(this.location, file), { recursive: true, force: true });
                });
            }
        } else {
            // Browser: delete IndexedDB database
            const request = indexedDB.deleteDatabase(this.location);
            request.onsuccess = () => {
                this.logger.debug("State manager cleared on IndexedDB");
            };
            request.onerror = (event) => {
                this.logger.error("Could not clear state manager on IndexedDB", event);
            };
        }
    }
}

function ensureStatePath(path: string): void {
    if (typeof window === "undefined") {
        // Node.js environment
        if (!fs.existsSync(path)) {
            fs.mkdirSync(path, { recursive: true });
        }
    }
}
