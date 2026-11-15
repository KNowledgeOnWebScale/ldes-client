import { Fetcher, ModulatorFactory, Manager } from "../fetcher";
import { deserializeMember, errorMessage, getLoggerFor, serializeMember } from "../../utils";
import { Condition } from "../../condition";

import type { FetchEvent, Node, Modulator, MemberEvents, Ranker } from "../fetcher";
import type { FetchedPage, Notifier, Member, StrategyEvents, SerializedMember } from "../../types";

export class UnorderedStrategy {
    private manager: Manager;
    private fetcher: Fetcher;
    private notifier: Notifier<StrategyEvents, unknown>;

    private fetchNotifier: Notifier<FetchEvent, { index: number }>;
    private memberNotifier: Notifier<MemberEvents, { index: number; modulator: Modulator<Node, Member> }>;

    private modulator: Modulator<Node, Member>;
    private preloadedPages = new Map<string, FetchedPage>();
    /** The pages that are fetched in this pass: a poll cycle starts a new pass, a page that is mutable is fetched once in a pass */
    private fetchedInPass = new Set<string>();
    /** The pages of which the members are being extracted or have not been read by the consumer yet, by the index of the page in the modulator */
    private pages = new Map<number, { unread: number; finishing: boolean; fragment?: FetchedPage }>();

    private polling: boolean;
    private pollInterval?: number;

    private canceled = false;
    /** A poll is waiting for its time */
    private pollScheduled = false;
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
                // Work that was still running when the client was closed fails because its state is gone: nobody is interested
                if (this.canceled) return this.logger.debug(`[fetchNotifier] Error after the client was closed: ${errorMessage(error)}`);
                this.logger.error(`[fetchNotifier] Error: ${errorMessage(error)}`);
                this.notifier.error(error, {});
            },
            scheduleFetch: async (node: Node) => {
                this.logger.debug(`[fetchNotifier - pageFetched] Scheduling fetch for mutable page: ${node.target}`);
                // Register in the state that this page needs to be refetched in the future. It keeps the ETag that it had when
                // its members were last read by the consumer: the ETag of this response comes when they have been, see finishPage
                const saved = await this.modulator.getMutable(node.target);
                if ((await this.modulator.addMutable(node.target, { ...node, etag: saved?.etag })) && !this.canceled) {
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
                if (this.canceled) return;
                this.notifier.error(error, {});
            },
            extracted: async (mem, { index }) => {
                if (this.canceled) return;
                // Make sure we keep the original member iri for the state in case materialization is enabled
                const memberIri = mem.id.value;
                // Not a second time: it is being emitted, and the consumer has not read it yet
                if (!this.modulator.markEmitting(memberIri)) return;
                const page = this.pageProgress(index);
                page.unread++;
                // The member is emitted when the consumer has read it: that is when it is in the state, and when its page can be finished
                const streamed = this.notifier.member(mem, {
                    delivered: async () => {
                        await this.modulator.addEmitted(memberIri);
                        page.unread--;
                        await this.finishPage(index);
                    },
                });
                if (!streamed) {
                    this.modulator.unmarkEmitting(memberIri);
                    page.unread--;
                }
            },
            done: async (fragment: FetchedPage, { index }) => {
                this.logger.debug("[memberNotifier - done] Members on page done");
                this.notifier.fragment(fragment, {});
                const page = this.pageProgress(index);
                page.fragment = fragment;
                await this.finishPage(index);
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
                        await this.fetcher.processFetchedPage(item, preloadedPage, { index }, this.fetchNotifier);
                    } else if (this.fetchedInPass.has(item.target)) {
                        // The page of a relation, that is also a mutable page of an earlier run, which was pushed at the start
                        this.logger.debug(`[modulator - ready] Skipping the page that was fetched in this pass already: ${item.target}`);
                        await this.modulator.finished(index);
                        this.background(this.checkEnd());
                    } else if (!(await this.modulator.seen(item.target))) {
                        this.logger.debug(`[modulator - ready] Ready to fetch page: ${item.target}`);
                        this.fetchedInPass.add(item.target);
                        this.background(this.fetcher.fetch(item, { index }, this.fetchNotifier));
                    } else {
                        this.logger.debug(`[modulator - ready] Skipping fetch for previously fetched immutable page: ${item.target}`);
                        await this.modulator.finished(index);
                        this.background(this.checkEnd());
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

    async start(url: string, condition: Condition, root?: FetchedPage, traverseRoot = true) {
        if (this.canceled) return;
        // Try to initialize the modulator
        if (!(await this.modulator.init(condition))) return;

        if (root && !traverseRoot) {
            this.background(this.manager.extractMembers(root, { index: 0, modulator: this.modulator }, this.memberNotifier));
        } else if (root) {
            this.preloadedPages.set(root.url, root);
            await this.modulator.push([{ target: root.url, expected: new Set() }]);
            await this.pushMutable(root.url);
        } else if ((await this.modulator.pendingCount()) < 1) {
            this.logger.debug("[start] Nothing in pending, adding start url");
            this.background(this.modulator.push([{ target: url, expected: new Set() }]));
            this.background(this.pushMutable(url));
        } else {
            this.logger.debug("[start] Pending things are already being processed, not adding start url");
        }
    }

    /**
     * The pages that were mutable when the replication last ended, are where new members are. They are not found from the
     * root when everything on the way is immutable: a linked list of pages, as OpenLDES servers publish, has a root that
     * never changes, and only links to the first page, which is immutable. A new run starts at the pages that can have grown.
     */
    private async pushMutable(except: string) {
        const mutable = (await this.modulator.getAllMutable()).filter((page) => page.target !== except);
        if (mutable.length > 0) {
            this.logger.debug(`[start] Adding ${mutable.length} mutable pages of the previous replication`);
            await this.modulator.push(mutable);
        }
    }

    /** What has been read by the consumer of the members of a page that is being extracted */
    private pageProgress(index: number) {
        let page = this.pages.get(index);
        if (!page) {
            page = { unread: 0, finishing: false };
            this.pages.set(index, page);
        }
        return page;
    }

    /**
     * A page is finished when all its members are extracted, and the consumer has read them: a page that is finished is not
     * requested again by a next run. A consumer that stops leaves its unread members in the buffer of the stream, and
     * the page unfinished, so that the next run emits them.
     */
    private async finishPage(index: number) {
        const page = this.pages.get(index);
        if (!page?.fragment || page.unread > 0 || page.finishing) return;
        page.finishing = true;
        this.pages.delete(index);
        const fragment = page.fragment;
        await this.modulator.finished(index);

        // Mark fragment as immutable if cache headers indicate so
        if (fragment.immutable) {
            this.logger.debug(`[memberNotifier - done] Remembering immutable page to avoid future refetching: ${fragment.url}`);
            if (!(await this.modulator.addImmutable(fragment.url))) return;
        } else if (fragment.etag) {
            // The consumer has read the members of this version of the page: it is requested with this ETag from now on, and a 304 means that it is as it was
            const saved = await this.modulator.getMutable(fragment.url);
            if (saved) await this.modulator.addMutable(fragment.url, { ...saved, etag: fragment.etag });
        }
        this.background(this.checkEnd());
    }

    async cancel() {
        this.canceled = true;
        await this.processing;
    }

    /**
     * Runs work that nobody waits for. When it fails, that is reported as an error of the client, where it would
     * otherwise be an unhandled rejection that stops the process.
     */
    private background(work: Promise<unknown>) {
        work.catch((ex) => {
            if (this.canceled) return this.logger.debug(`Error after the client was closed: ${errorMessage(ex)}`);
            this.notifier.error(ex, {});
        });
    }

    private handleFetched(page: FetchedPage, index: number) {
        this.background(this.manager.extractMembers(page, { index, modulator: this.modulator }, this.memberNotifier));
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
                // One poll at a time: pages that finish together each find that nothing is pending, and each would start a poll
                if (this.pollScheduled) return;
                this.pollScheduled = true;
                this.logger.debug(`[_checkEnd] Polling is enabled, setting timeout of ${this.pollInterval || 1000} ms to poll`);
                setTimeout(() => {
                    this.pollScheduled = false;
                    this.background(
                        (async () => {
                            if (this.canceled) return;
                            this.notifier.pollCycle({}, {});
                            this.fetchedInPass.clear();
                            await this.modulator.push(await this.modulator.getAllMutable());
                        })(),
                    );
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
