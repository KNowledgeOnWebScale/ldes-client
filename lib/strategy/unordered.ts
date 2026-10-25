import { Fetcher, ModulatorFactory, Manager } from "../fetcher";
import { deserializeMember, getLoggerFor, serializeMember } from "../utils";
import { Condition } from "../condition";

import type {
    FetchedPage,
    FetchEvent,
    Node,
    Modulator,
    Notifier,
    MemberEvents,
    Member,
    Ranker
} from "../fetcher";
import type { StrategyEvents, SerializedMember } from ".";

export class UnorderedStrategy {
    private manager: Manager;
    private fetcher: Fetcher;
    private notifier: Notifier<StrategyEvents, unknown>;

    private fetchNotifier: Notifier<FetchEvent, { index: number }>;
    private memberNotifier: Notifier<
        MemberEvents,
        { index: number, modulator: Modulator<Node, Member> }
    >;

    private modulator: Modulator<Node, Member>;
    private preloadedPages = new Map<string, FetchedPage>();

    private polling: boolean;
    private pollInterval?: number;

    private canceled = false;
    private isEnding = false;
    private shouldEndAgain = false;
    public processing = Promise.resolve();

    private logger = getLoggerFor(this);

    constructor(
        memberManager: Manager,
        fetcher: Fetcher,
        notifier: Notifier<StrategyEvents, unknown>,
        modulatorFactory: ModulatorFactory,
        polling: boolean,
        pollInterval?: number,
    ) {
        this.pollInterval = pollInterval;
        this.notifier = notifier;
        this.manager = memberManager;
        this.fetcher = fetcher;
        this.polling = polling;

        /**
         * Callbacks for the fetcher
         * - scheduleFetch: a mutable page was fetched, we keep track of it for future polling
         * - pageFetched: a complete page is fetched and the relations have been extracted
         *       start member extraction
         * - relationsFiltered: Indicates that a fragment had relations that were filtered out
         *       due to the process conditions. The fragment should be kept in state for future processes
         *       that may have different conditions.
         * - relationFound: a relation has been found, put it in the queue
         */
        this.fetchNotifier = {
            error: (error: unknown) => {
                this.logger.error(`[fetchNotifier] Error: ${JSON.stringify(error)}`);
                this.notifier.error(error, {});
            },
            scheduleFetch: async (node: Node) => {
                this.logger.debug(`[fetchNotifier - pageFetched] Scheduling fetch for mutable page: ${node.target}`);
                // Register in the state that this page needs to be refetched in the future
                if (await this.modulator.addMutable(node.target, node) && !this.canceled) {
                    this.notifier.mutable({}, {});
                }
            },
            relationsFound: async (relations) => {
                const toPush = [];
                for (const { from, target } of relations) {
                    this.logger.debug(`[fetchNotifier - relationFound] Found relation leading to ${target.node}`);
                    from.expected.add(target.node);
                    const saved = await this.modulator.getMutable(target.node);
                    toPush.push({
                        target: target.node,
                        etag: saved?.etag,
                        relations: saved?.relations,
                        expected: new Set([from.target]),
                    });
                }
                await this.modulator.push(toPush);
            },
            pageFetched: (page, { index }) => {
                this.logger.debug(`[fetchNotifier - pageFetched] Paged fetched ${page.url}`);
                this.handleFetched(page, index);
            },
        };

        /**
         * Callbacks for the member extractor
         * - done: all members have been extracted
         * - extracted: a member has been found, yeet it
         */
        this.memberNotifier = {
            error: (error) => {
                this.notifier.error(error, {});
            },
            extracted: async (mem) => {
                // Member is emitted immediately after extraction, so no need to record it in the unemitted state
                if (this.canceled) return;
                // Make sure we keep the original member iri for the state in case materialization is enabled
                const memberIri = mem.id.value;
                const streamed = this.notifier.member(mem, {});
                if (streamed) {
                    await this.modulator.addEmitted(memberIri)
                }
            },
            done: async (fragment: FetchedPage, { index }) => {
                this.logger.debug("[memberNotifier - done] Members on page done");
                this.notifier.fragment(fragment, {});
                await this.modulator.finished(index)

                // Mark fragment as immutable if cache headers indicate so 
                if (fragment.immutable) {
                    this.logger.debug(`[memberNotifier - done] Remembering immutable page to avoid future refetching: ${fragment.url}`);
                    if (!await this.modulator.addImmutable(fragment.url)) return;
                }
                this.checkEnd();
            },
        };

        /**
         * Create an Modulator instance
         */
        this.modulator = modulatorFactory.create<Node, Member>(
            "fetcher",
            new QueueRanker(),
            {
                ready: async ({ item, index }) => {
                        const preloadedPage = this.preloadedPages.get(item.target);
                        if (preloadedPage) {
                            this.preloadedPages.delete(item.target);
                            await this.fetcher.processFetchedPage(
                                item,
                                preloadedPage,
                                { index },
                                this.fetchNotifier,
                            );
                        } else if (!(await this.modulator.seen(item.target))) {
                            this.logger.debug(`[modulator - ready] Ready to fetch page: ${item.target}`);
                            this.fetcher.fetch(item, { index }, this.fetchNotifier);
                    } else {
                        this.logger.debug(`[modulator - ready] Skipping fetch for previously fetched immutable page: ${item.target}`);
                        await this.modulator.finished(index);
                        this.checkEnd();
                    }
                },
            },
            (inp: Node) => {
                return {
                    target: inp.target,
                    etag: inp.etag,
                    relations: inp.relations,
                    expected: Array.from(inp.expected),
                };
            },
            (inp: unknown) => {
                return {
                    target: (inp as Node).target,
                    etag: (inp as Node).etag,
                    relations: (inp as Node).relations,
                    expected: new Set((inp as Node).expected),
                };
            },
            serializeMember,
            (member) => deserializeMember(member as SerializedMember),
        );
    }

    async start(
        url: string,
        condition: Condition,
        root?: FetchedPage,
        traverseRoot = true,
    ) {
        if (this.canceled) return;
        // Try to initialize the modulator
        if (!(await this.modulator.init(condition))) return;

        if (root && !traverseRoot) {
            this.manager.extractMembers(
                root,
                { index: 0, modulator: this.modulator },
                this.memberNotifier
            );
        } else if (root) {
            this.preloadedPages.set(root.url, root);
            await this.modulator.push([{ target: root.url, expected: new Set() }]);
        } else if ((await this.modulator.pendingCount()) < 1) {
            this.logger.debug("[start] Nothing in pending, adding start url");
            this.modulator.push([{ target: url, expected: new Set() }]);
        } else {
            this.logger.debug(
                "[start] Pending things are already being processed, not adding start url",
            );
        }
    }

    async cancel() {
        this.canceled = true;
        await this.processing;
    }

    private handleFetched(page: FetchedPage, index: number) {
        this.manager.extractMembers(
            page,
            { index, modulator: this.modulator },
            this.memberNotifier
        );
    }

    /**
     * This function implements the logic of a synchronized ending loop that uses
     * the @isEnding and @shouldEndAgain flags to prevent multiple ending loops from running at the same time. 
     * When a process is already running, subsequent calls simply set the shouldEndAgain flag and return. 
     * The original process then picks up these pending requests in its loop, 
     * ensuring sequential execution without overlapping asynchronous operations
     */
    private async checkEnd() {
        if (this.isEnding) {
            this.shouldEndAgain = true;
            return;
        }

        this.isEnding = true;
        this.processing = (async () => {
            try {
                while (true) {
                    this.shouldEndAgain = false;
                    await this._checkEnd();
                    if (this.shouldEndAgain && !this.canceled) {
                        continue;
                    }
                    break;
                }
            } finally {
                this.isEnding = false;
            }
        })();
        await this.processing;
    }

    private async _checkEnd() {
        if (this.canceled) return;
        if ((await this.modulator.pendingCount()) < 1) {
            // Make sure we don't schedule multiple polling cycles
            if (this.polling) {
                this.logger.debug(`[_checkEnd] Polling is enabled, setting timeout of ${this.pollInterval || 1000} ms to poll`);
                setTimeout(async () => {
                    if (this.canceled) return;
                    this.notifier.pollCycle({}, {});
                    this.modulator.push(await this.modulator.getAllMutable());
                }, this.pollInterval || 1000);
            } else {
                this.logger.debug("[_checkEnd] Closing the notifier, polling is not set");
                this.canceled = true;
                this.notifier.close({}, {});
            }
        }
    }
}

class QueueRanker<T> implements Ranker<T> {
    private items: T[] = [];

    push(item: T): void {
        this.items.push(item);
    }

    pop(): T | undefined {
        return this.items.shift();
    }
}
