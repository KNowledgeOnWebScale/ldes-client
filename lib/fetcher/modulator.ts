import { getLoggerFor } from "../utils/";
import { Condition } from "../condition";
import { Level } from "level";

import type { ClientStateManager } from "../state";

export type Notifier<Events, S> = {
    [K in keyof Events]: (event: Events[K], state: S) => unknown;
};

type Indexed<T> = {
    item: T;
    index: number;
};

/**
 * Generic interface that represents a structure that ranks elements.
 * Most common is a Priority Queue (heap like) that pops elements in order.
 * An array is also a Ranker, without ordering.
 */
export interface Ranker<T> {
    push(item: T): void;
    pop(): T | undefined;
}

export type ModulatorEvents<T> = {
    ready: Indexed<T>;
};


export interface Modulator<F, M> {
    /**
     * Initializes the modulator and loads any previously existing state from the state manager.
     * @param {Condition} condition The condition under which the client runs.
     * @returns {Promise<boolean>} True if the modulator was initialized successfully.
    */
    init(condition: Condition): Promise<boolean>;
    /**
     * Starts the handling of a fragment by adding it to the todo list.
     * @param {ReadonlyArray<F>} fragments The fragments to be handled.
    */
    push(fragments: ReadonlyArray<F>): Promise<void>;

    /**
     * Checks if the modulator is ready to trigger the ready event.
    */
    checkReady(): Promise<void>;

    /**
     * Called when a fragment has been handled, which removes it from the inflight list.
     * @param index The index of the fragment that has been handled.
    */
    finished(index: number): Promise<void>;

    /**
     * Closes the modulator, which removes it from the factory.
    */
    close(): void;

    /**
     * Returns the number of fragments that are still pending.
    */
    pendingCount(): Promise<number>;

    /**
     * Returns whether a fragment has been encountered before and is in the immutable list.
     * @param {string} url The URL of the element to check.
     * @return {Promise<boolean>} True if the element is in the immutable list.
    */
    seen(url: string): Promise<boolean>;

    /**
     * Returns all fragments that are mutable.
     * @returns {Promise<ReadonlyArray<F>>} The mutable list.
    */
    getAllMutable(): Promise<ReadonlyArray<F>>

    /**
     * Returns one mutable fragment by URL if it is known.
    */
    getMutable(url: string): Promise<F | undefined>

    /**
     * Returns all data entities that have been extracted but not emitted yet.
     * @returns {Promise<ReadonlyArray<M>>} The unemitted list.
    */
    getAllUnemitted(): Promise<ReadonlyArray<M>>

    /**
     * Returns all fragments that are currently in flight.
     * @returns {Promise<ReadonlyArray<F>>} The inflight list.
    */
    getAllInFlight(): Promise<ReadonlyArray<F>>

    /**
     * Returns all fragments that are currently in todo.
     * @returns {Promise<ReadonlyArray<F>>} The todo list.
    */
    getAllTodo(): Promise<ReadonlyArray<F>>

    /**
     * Records the fact that an element is mutable
     * @param {string} url The URL of the element to record.
     * @param {F} fragment The element to record.
     * @returns {Promise<boolean>} True if all is good to proceed, false if must not emit new notifications.
    */
    addMutable(url: string, fragment: F): Promise<boolean>

    /**
     * Records the fact that an element is immutable.
     * @param {string} url The URL of the element to record.
     * @returns {Promise<boolean>} True if all is good to proceed, false if must not emit new notifications.
    */
    addImmutable(url: string): Promise<boolean>

    /**
     * Records the fact that a data entity has been emitted.
     * @param {string} url The URL of the emitted data entity.
     * @returns {Promise<boolean>} True if all is good to proceed, false if must not emit new notifications.
    */
    addEmitted(url: string): Promise<boolean>

    /**
     * Records the fact that a data entity has been extracted but not emitted yet.
     * @param {string} url The URL of the data entity.
     * @param {M} member The extracted data entity.
     * @returns {Promise<boolean>} True if all is good to proceed, false if must not emit new notifications.
    */
    addUnemitted(url: string, member: M): Promise<boolean>

    /**
     * Returns whether a data entity has been emitted.
     * @param {string} url The URL of the data entity.
     * @returns {Promise<boolean>} True if the data entity has been emitted.
    */
    wasEmitted(url: string): Promise<boolean>

    /**
     * Removes a data entity from the unemitted list.
     * @param {string} url The URL of the data entity.
     * @returns {Promise<boolean>} True if all is good to proceed, false if must not emit new notifications.
    */
    deleteUnemitted(url: string): Promise<boolean>

    /**
     * Returns whether the modulator is tracking latest versions
     * @returns {boolean} True if the modulator is tracking latest versions
    */
    hasLatestVersions(): boolean;

    /**
     * Filter out older versions of a member.
     * @param {string} memberId The ID of the member (isVersionOf).
     * @param {number} version The version of the member.
     * @returns {Promise<boolean>} True if the member is old and should be filtered out.
     * @throws {Error} If processing was cancelled and must not continue.
    */
    filterLatest(memberId: string, version: number): Promise<boolean>

}

type ModulatorState<F, M> = {
    condition: Level<number, string>;
    todo: Level<number, F>;
    inflight: Level<number, F>;
    mutable: Level<string, F>;
    emitted: Level<string, boolean>;
    immutable?: Level<string, boolean>;
    unemitted?: Level<string, M>;
    latestVersions?: Level<string, number>;
    fragmentEncoder?: (item: F) => unknown;
    fragmentParser?: (item: unknown) => F;
    memberEncoder?: (item: M) => unknown;
    memberParser?: (item: unknown) => M;
};

/**
 * Factory that creates Modulators
 * This is a factory to keep track whether the Modulator should be paused or not.
 */
export class ModulatorFactory {
    concurrent: number;
    paused: boolean = false;
    saveState: boolean = false;
    lastVersionOnly: boolean = false;

    clientStateManager: ClientStateManager;
    children: { [key: string]: Modulator<unknown, unknown> } = {};

    constructor(
        clientStateManager: ClientStateManager,
        saveState?: boolean,
        concurrent?: number,
        lastVersionOnly?: boolean,
    ) {
        this.clientStateManager = clientStateManager;
        this.saveState = saveState!!;
        this.concurrent = concurrent || 10;
        this.lastVersionOnly = lastVersionOnly!!;
    }

    create<F, M>(
        name: string,
        ranker: Ranker<Indexed<F>>,
        notifier: Notifier<ModulatorEvents<F>, unknown>,
        fragmentEncoder?: (item: F) => unknown,
        fragmentParser?: (item: unknown) => F,
        memberEncoder?: (item: M) => unknown,
        memberParser?: (item: unknown) => M,
    ): Modulator<F, M> {
        const modulatorState: ModulatorState<F, M> = {
            condition: this.clientStateManager.build<number, string>("condition"),
            todo: this.clientStateManager.build<number, F>("todo"),
            inflight: this.clientStateManager.build<number, F>("inflight"),
            mutable: this.clientStateManager.build<string, F>("mutable"),
            emitted: this.clientStateManager.build<string, boolean>("emitted"),
            fragmentEncoder,
            fragmentParser,
            memberEncoder,
            memberParser,
        };

        // Build all state tracking objects (if needed)
        if (this.saveState) {
            modulatorState.immutable = this.clientStateManager.build<string, boolean>("immutable");
            modulatorState.unemitted = this.clientStateManager.build<string, M>("unemitted");
        }

        // Build a state object to record the latest version of every member (if required)
        if (this.lastVersionOnly) {
            modulatorState.latestVersions = this.clientStateManager.build<string, number>("latestVersions");
        }

        const modulator = new ModulatorInstance(
            modulatorState,
            ranker,
            notifier,
            this
        );
        this.children[name] = modulator;
        return modulator;
    }

    pause() {
        this.paused = true;
    }

    unpause() {
        this.paused = false;
        Object.values(this.children).forEach(async (modulator) => await modulator.checkReady());
    }

    close() {
        Object.values(this.children).forEach((modulator) => modulator.close());
    }
}

export class ModulatorInstance<F, M> implements Modulator<F, M> {
    at: number = 0;
    index: number = 0;

    private modulatorState: ModulatorState<F, M>;
    private ranker: Ranker<Indexed<F>>;
    private notifier: Notifier<ModulatorEvents<F>, unknown>;
    private factory: ModulatorFactory;

    private logger = getLoggerFor(this);
    private closed = false;
    private versionStateSync = Promise.resolve();

    constructor(
        state: ModulatorState<F, M>,
        ranker: Ranker<Indexed<F>>,
        notifier: Notifier<ModulatorEvents<F>, unknown>,
        factory: ModulatorFactory,
    ) {
        this.modulatorState = state;
        this.ranker = ranker;
        this.notifier = notifier;
        this.factory = factory;
    }

    async init(condition: Condition): Promise<boolean> {
        if (this.closed) return false;
        try {
            this.logger.debug("Initializing modulator");

            // Check we are running under the same conditions as before (if any)
            const oldCondition = await this.modulatorState.condition.get(0);
            if (oldCondition && oldCondition !== condition.toString()) {
                this.logger.error("The running conditions have changed from "
                    + oldCondition + " to " + condition.toString() + ", shutting down!");
                throw new Error("Different conditions");
            } else {
                await this.modulatorState.condition.put(0, condition.toString());
            }

            // Load any pending fragments from a previous run
            const pending = (await Promise.all([
                this.getAllTodo(),
                this.getAllInFlight(),
            ])).flat();

            // Clean up previous record lists
            await Promise.all([
                this.clearAllTodo(),
                this.clearAllInFlight(),
            ]);

            this.logger.verbose(`Initializing and loading ${pending.length} pending fragments from a previous run`);
            this.logger.debug(`Pending fragments: ${JSON.stringify(pending)}`);
            await this.push(pending);
            return true;
        } catch (e) {
            if ((e as Error).message === "Different conditions") {
                throw e;
            }
            this.logger.error("Failed to initialize modulator, shutting down: ", e);
            return false;
        }
    }

    async push(fragments: ReadonlyArray<F>) {
        for (const fragment of fragments) {
            const indexed = { item: fragment, index: this.index };
            await this.addTodo(this.index, fragment);
            this.index += 1;
            this.ranker.push(indexed);
        }
        await this.checkReady();
    }

    async checkReady() {
        if (this.factory.paused || this.closed) {
            return;
        }

        while (this.at < this.factory.concurrent) {
            const indexedItem = this.ranker.pop();
            if (indexedItem) {
                const { todo } = this.modulatorState;

                // This item is no longer todo and is now inflight
                await Promise.all([
                    todo.del(indexedItem.index),
                    this.addInFlight(indexedItem.index, indexedItem.item),
                ]);

                this.at += 1;
                this.notifier.ready(indexedItem, {});
            } else {
                break;
            }
        }
    }

    async finished(index: number) {
        return this.withState<void>(undefined, async (st) => {
            const { inflight } = st;

            await inflight.del(index);
            this.at -= 1;
            await this.checkReady();
        });
    }

    close() {
        this.closed = true;
    }

    async pendingCount(): Promise<number> {
        if (this.closed) return 0;
        const { todo, inflight } = this.modulatorState;
        if (!todo || !inflight) {
            return 0;
        }
        const [a, b] = await Promise.all([
            todo.values().all(),
            inflight.values().all(),
        ]);
        return a.length + b.length;
    }

    async seen(url: string): Promise<boolean> {
        if (this.closed) return false;
        return this.withState<boolean>(false, async (st) => {
            const { immutable } = st;
            if (!immutable) {
                return false;
            }

            return await immutable.has(url);
        });
    }

    async getAllMutable(): Promise<Array<F>> {
        if (this.closed) return [];
        return this.withState<Array<F>>([], async (st) => {
            const { mutable, fragmentParser } = st;

            const values = await mutable.values().all();
            return fragmentParser ? values.map(fragmentParser) : values;
        });
    }

    async getMutable(url: string): Promise<F | undefined> {
        if (this.closed) return;
        return this.withState<F | undefined>(undefined, async (st) => {
            const { mutable, fragmentParser } = st;
            const value = await mutable.get(url).catch(() => undefined);
            if (!value) {
                return;
            }
            return fragmentParser ? fragmentParser(value) : value;
        });
    }

    async getAllUnemitted(): Promise<ReadonlyArray<M>> {
        if (this.closed) return [];
        return this.withState<ReadonlyArray<M>>([], async (st) => {
            const { unemitted, memberParser } = st;
            if (!unemitted) {
                return [];
            }

            const values = await unemitted.values().all();
            return memberParser ? values.map(memberParser) : values;
        });
    }

    async getAllInFlight(): Promise<ReadonlyArray<F>> {
        if (this.closed) return [];
        return this.withState<ReadonlyArray<F>>([], async (st) => {
            const { inflight, fragmentParser } = st;
            if (!inflight) {
                return [];
            }

            const values = await inflight.values().all();
            return fragmentParser ? values.map(fragmentParser) : values;
        });
    }

    async getAllTodo(): Promise<ReadonlyArray<F>> {
        if (this.closed) return [];
        return this.withState<ReadonlyArray<F>>([], async (st) => {
            const { todo, fragmentParser } = st;
            if (!todo) {
                return [];
            }
            const values = await todo.values().all();
            return fragmentParser ? values.map(fragmentParser) : values;
        });
    }

    async addMutable(url: string, fragment: F): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) return false;
        return this.withState<boolean>(true, async (st) => {
            const { mutable, fragmentEncoder } = st;
            await mutable.put(
                url,
                fragmentEncoder ? <F>fragmentEncoder(fragment) : fragment
            );
            // State was updated successfully, so notifications may proceed
            return true;
        });
    }

    async addImmutable(url: string): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) return false;
        return this.withState<boolean>(true, async (st) => {
            const { immutable, mutable } = st;
            // Remove from mutable list
            await mutable.del(url);
            if (!immutable) {
                // State is not being tracked, so notifications may proceed
                return true;
            }
            // Add to immutable list
            await immutable.put(url, true);
            // State was updated successfully, so notifications may proceed
            return true;
        });
    }

    async addEmitted(url: string): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) return false;
        return this.withState<boolean>(true, async (st) => {
            const { emitted, unemitted } = st;
            // Add to emitted list
            await emitted.put(url, true);
            if (!unemitted) {
                // State is not being tracked, so notifications may proceed
                return true;
            }
            // Remove from unemitted list too
            await unemitted.del(url);
            // State was updated successfully, so notifications may proceed
            return true;
        });
    }

    async addUnemitted(url: string, member: M): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) return false;
        return this.withState<boolean>(true, async (st) => {
            const { unemitted, memberEncoder } = st;
            if (!unemitted) {
                // State is not being tracked, so notifications may proceed
                return true;
            }
            await unemitted.put(
                url,
                memberEncoder ? <M>memberEncoder(member) : member
            );
            // State was updated successfully, so notifications may proceed
            return true;
        });
    }

    async wasEmitted(url: string): Promise<boolean> {
        if (this.closed) return false;
        return this.withState<boolean>(false, async (st) => {
            const { emitted } = st;
            return await emitted.has(url);
        });
    }

    async deleteUnemitted(url: string): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) return false;
        return this.withState<boolean>(true, async (st) => {
            const { unemitted } = st;
            if (!unemitted) {
                // State is not being tracked, so notifications may proceed
                return true;
            }
            await unemitted.del(url);
            // State was updated successfully, so notifications may proceed
            return true;
        });
    }

    hasLatestVersions(): boolean {
        if (this.closed) return false;
        return !!this.modulatorState.latestVersions;
    }

    /**
     * This method uses a promise-chain (versionStateSync) to serialize all version checks and updates, 
     * preventing race conditions when multiple fragment extractions occur in parallel.
    */
    async filterLatest(memberId: string, version: number): Promise<boolean> {
        // If things are shutting down, relay back that we must not emit new notifications
        if (this.closed) throw new Error('Modulator is closed');
        return this.withState<boolean>(false, async (st) => {
            const { latestVersions } = st;
            // If version state is not being tracked, then this member can't be filtered as an old one
            if (!latestVersions) return false;
            const p = this.versionStateSync.then(async () => {
                // Again, if things are shutting down, relay back that we must not emit new notifications
                if (this.closed) throw new Error('Modulator is closed');
                const latestVersion = await latestVersions.get(memberId).catch(() => undefined);
                if (latestVersion === undefined || version > latestVersion) {
                    // This member is a newer version
                    await latestVersions.put(memberId, version);
                    return false;
                }
                return version < latestVersion;
            });
            this.versionStateSync = p.then(() => { })
                .catch((err) => {
                    // Things are shutting down or something went wrong, relay back that we must not emit new notifications
                    throw err;
                });
            return await p;
        });
    }

    /**
     * Clears the todo list.
    */
    private async clearAllTodo(): Promise<void> {
        if (this.closed) return;
        return this.withState<void>(undefined, async (st) => {
            const { todo } = st;
            await todo.clear();
        });
    }

    /**
     * Adds a fragment to the todo list.
    */
    private async addTodo(index: number, fragment: F): Promise<void> {
        if (this.closed) return;
        return this.withState<void>(undefined, async (st) => {
            const { todo, fragmentEncoder } = st;
            await todo.put(
                index,
                fragmentEncoder ? <F>fragmentEncoder(fragment) : fragment
            );
        });
    }

    /**
     * Clears the in-flight list.
    */
    private async clearAllInFlight(): Promise<void> {
        if (this.closed) return;
        return this.withState<void>(undefined, async (st) => {
            const { inflight } = st;
            await inflight.clear();
        });
    }

    /**
     * Adds a fragment to the in-flight list.
    */
    private async addInFlight(index: number, fragment: F): Promise<void> {
        if (this.closed) return;
        return this.withState<void>(undefined, async (st) => {
            const { inflight, fragmentEncoder } = st;
            await inflight.put(
                index,
                fragmentEncoder ? <F>fragmentEncoder(fragment) : fragment
            );
        });
    }

    /**
     * Utility function to execute an operation on the modulator state.
    */
    private async withState<T>(
        def: T,
        fn: (st: typeof this.modulatorState) => Promise<T>
    ): Promise<T> {
        if (this.closed) return def;
        try {
            return await fn(this.modulatorState);
        } catch (err) {
            if ((err as Error & { code: string }).code === 'LEVEL_DATABASE_NOT_OPEN') {
                return def;
            }
            throw err;
        }
    }
}
