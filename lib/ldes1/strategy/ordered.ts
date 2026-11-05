import { Heap } from "heap-js";
import { TREE } from "@treecg/types";
import { Fetcher, ModulatorFactory, RelationChain, Manager, memberIsOld } from "../fetcher";
import {
    parseInBetweenRelation,
    getLoggerFor,
    deserializeMember,
    serializeMember,
    termToOrderValue,
    isNumericOrderValue,
} from "../../utils";
import { GTRs, LTR } from "./types";
import { Condition } from "../../condition";

import type {
    FoundRelation,
    FetchEvent,
    SimpleRelation,
    MemberEvents,
    Modulator
} from "../fetcher";
import type {
    Member,
    LDESInfo,
    FetchedPage,
    Notifier,
    OrderValue,
    StrategyEvents,
    Ordered,
    SerializedMember,
} from "../../types";

type StoredRelation = {
    important: boolean;
    value: OrderValue;
    valueType?: "date" | "raw";
};

type NodeChain = {
    chain: RelationChain;
    expected: Set<string>;
}

export class OrderedStrategy {
    private members: Heap<Member>;

    private manager: Manager;
    private fetcher: Fetcher;

    // This can be T: controller or something
    private notifier: Notifier<StrategyEvents, unknown>;

    // Contains a heap with all relations that have been launched
    // The heap will first handle unimportant relations,
    //   so when an important relation is handled, we can try to emit members
    //
    // With ordering ascending GT relations are important
    // With ordering descending LT relations are important
    private readonly launchedRelations: Heap<RelationChain>;
    private readonly relationFinished = new WeakMap<RelationChain, boolean>();

    private modulator: Modulator<NodeChain, Member>;
    private preloadedPages = new Map<string, FetchedPage>();
    private fetchNotifier: Notifier<
        FetchEvent,
        { chain: RelationChain; index: number }
    >;
    private memberNotifier: Notifier<
        MemberEvents,
        {
            chain: RelationChain;
            index: number;
            modulator: Modulator<NodeChain, Member>;
        }
    >;

    private ordered: Ordered;

    private polling: boolean;
    private toPoll: Heap<NodeChain>;
    private pollInterval?: number;
    private readonly primaryPathKey?: string;
    private readonly timestampOrdering: boolean;
    private readonly hasSequencePath: boolean;

    private canceled = false;
    private isEmitChecking = false;
    private shouldCheckEmitAgain = false;
    public processingEmit = Promise.resolve();
    private isEndChecking = false;
    private shouldCheckEndAgain = false;
    public processingCheckEnd = Promise.resolve();

    private logger = getLoggerFor(this);

    constructor(
        memberManager: Manager,
        fetcher: Fetcher,
        notifier: Notifier<StrategyEvents, unknown>,
        factory: ModulatorFactory,
        info: LDESInfo,
        ordered: Ordered,
        polling: boolean,
        pollInterval?: number,
    ) {
        this.ordered = ordered;
        this.manager = memberManager;
        this.fetcher = fetcher;
        this.notifier = notifier;
        this.polling = polling;
        this.pollInterval = pollInterval;
        this.timestampOrdering = info.timestampPath !== undefined;
        this.hasSequencePath = info.sequencePath !== undefined;
        this.primaryPathKey = this.timestampOrdering ? info.timestampPathKey : info.sequencePathKey;

        this.toPoll = new Heap((a, b) => a.chain.ordering(b.chain));
        this.launchedRelations = new Heap((a, b) => a.ordering(b));

        /**
         * Callbacks for the fetcher
         * - scheduleFetch: a mutable page was fetched, we keep track of it for future polling
         * - pageFetched: a complete page is fetched and the relations have been extracted
         *       start member extraction
         * - relationsFiltered: Indicates that a fragment had relations that were filtered out
         *       due to the process conditions. The fragment should be kept in state for future processes
         *       that may have different conditions. 
         * - relationFound: a relation has been found, put the extended chain in the queue
         */
        this.fetchNotifier = {
            error: (error: unknown) => {
                this.notifier.error(error, {});
            },
            scheduleFetch: async ({ target, expected }, { chain }) => {
                this.logger.debug(`[fetchNotifier - scheduleFetch] Scheduling fetch for mutable page: ${target}`);
                chain.target = target;
                this.toPoll.push({ chain, expected });
                // Register in the state that this page needs to be refetched in the future
                if (await this.modulator.addMutable(target, { chain, expected }) && !this.canceled) {
                    this.notifier.mutable({}, {});
                }
            },
            relationsFound: async (relations, { chain }) => {
                const toFetch = [];
                for (const { from, target } of relations) {
                    from.expected.add(target.node);
                    this.logger.debug(`[fetchNotifier - relationFound] Relation found ${target.node}`);
                    const newChain = chain.push(
                        target.node,
                        this.extractRelation(target),
                    );
                    if (newChain.ordering(chain) >= 0) {
                        // Only launch the fetching of this relation if it hasn't been launched already
                        if (!this.launchedRelations.contains(newChain, (e, o) => e.target === o.target)) {
                            this.launchRelation(newChain);
                            const newExpected = new Set([...from.expected, from.target]);
                            toFetch.push({ chain: newChain, expected: newExpected });
                        }
                    } else {
                        this.logger.error(
                            "Found relation backwards in time, this indicates wrong tree structure. Ignoring",
                        );
                    }
                }
                await this.modulator.push(toFetch);
            },
            pageFetched: async (page, state) => {
                this.logger.debug(`[fetchNotifier - pageFetched] Page fetched ${page.url}`);
                await this.handleFetched(page, state);
            },
        };

        /**
         * Callbacks for member manager
         * - done: extracting is done, indicate this
         * - extract: a member is extracted, add it to our heap
         */
        this.memberNotifier = {
            error: (error) => {
                this.notifier.error(error, {});
            },
            extracted: async (member) => {
                // Only proceed to emit if the member is not already in process of being emitted
                if (!this.members.contains(member, (e, o) => e.id.value === o.id.value)) {
                    this.members.push(member);
                    // Register extracted member in the unemitted list
                    if (await this.modulator.addUnemitted(member.id.value, member)) {
                        this.logger.silly(`[memberNotifier - extracted] Member <${member.id.value}> added to unemitted list`);
                    }

                }
            },
            done: async (fragment: FetchedPage, { chain, index }) => {
                this.logger.debug(`[memberNotifier - done] Member extraction done for ${chain.target}`);
                this.relationFinished.set(chain, true);
                await this.modulator.finished(index);
                this.notifier.fragment(fragment, {});

                // Mark fragment as immutable if cache headers indicate so
                if (fragment.immutable) {
                    if (await this.modulator.addImmutable(fragment.url)) {
                        this.logger.debug(`[memberNotifier - done] Remembering immutable page to avoid future refetching: ${fragment.url}`);
                    }
                }

                await this.checkEmit();
            },
        };

        /**
         * Create an Modulator instance
         */
        this.modulator = factory.create(
            "fetcher",
            new Heap((a, b) => a.item.chain.ordering(b.item.chain)),
            {
                ready: async ({ item: { chain, expected }, index }) => {
                    // Restored pending fragments are queued by the modulator.
                    if (!this.relationFinished.has(chain)) this.launchRelation(chain);
                    const preloadedPage = this.preloadedPages.get(chain.target);
                    if (preloadedPage) {
                        this.preloadedPages.delete(chain.target);
                        await this.fetcher.processFetchedPage(
                            { target: chain.target, expected },
                            preloadedPage,
                            { chain, index },
                            this.fetchNotifier,
                        );
                    } else if (!(await this.modulator.seen(chain.target))) {
                        this.logger.debug(`[modulator - ready] Ready to fetch page: ${chain.target}`);
                        await this.fetcher.fetch(
                            { target: chain.target, expected },
                            { chain, index },
                            this.fetchNotifier,
                        );
                    } else {
                        this.logger.debug(`[modulator - ready] Skipping fetch for previously fetched immutable page: ${chain.target}`);
                        this.relationFinished.set(chain, true);
                        await this.modulator.finished(index);
                        // See if we can emit some members or end the process
                        this.background(this.checkEmit());
                    }
                },
            },
            (inp: NodeChain) => {
                // Serialize: Convert Set to Array for JSON storage
                return {
                    chain: {
                        source: inp.chain.source,
                        target: inp.chain.target,
                        relations: inp.chain.relations.map(({ important, value }) => ({
                            important,
                            value: value instanceof Date ? value.toISOString() : value,
                            valueType: value instanceof Date ? "date" : "raw",
                        })),
                    },
                    expected: Array.from(inp.expected),
                };
            },
            (inp: unknown) => {
                const { chain, expected } = <{
                    chain: { source: string; target: string; relations: StoredRelation[] };
                    expected: string[];
                }>inp;
                const relations = chain.relations.map(({ important, value, valueType }) => {
                    // In legacy state the relation's path was not saved. Only
                    // restore a date automatically for timestamp-only streams.
                    const legacyDate = valueType === undefined && this.timestampOrdering &&
                        !this.hasSequencePath && typeof value === "string" &&
                        /^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
                    if ((valueType === "date" || legacyDate) && typeof value === "string") {
                        const date = new Date(value);
                        if (!Number.isNaN(date.getTime())) return { important, value: date };
                    }
                    return {
                        important: important && !(valueType === undefined && this.timestampOrdering && this.hasSequencePath),
                        value,
                    };
                });
                return {
                    chain: new RelationChain(
                        chain.source,
                        chain.target,
                        relations,
                        undefined,
                        this.compareRelations,
                    ),
                    expected: new Set(expected),
                };
            },
            serializeMember,
            (member) => deserializeMember(member as SerializedMember),
        );

        /**
         * Member heap that determines their emission order
         */
        this.members = new Heap((a, b) => compareMembers(a, b, ordered, this.timestampOrdering));
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

        // Check for any unemitted members from a previous run
        const unemitted = await this.modulator.getAllUnemitted();
        if (unemitted.length > 0) {
            this.logger.debug(`[start] Found ${unemitted.length} unemitted members in the saved state`);
            for (const member of unemitted) {
                this.members.push(member);
            }
        }

        // Schedule any mutable pages found in a previous run
        const mutableFragments = await this.modulator.getAllMutable();
        mutableFragments.forEach(fragment => {
            this.toPoll.push(fragment);
        });

        if (root && !traverseRoot) {
            this.background(this.manager.extractMembers(
                root,
                {
                    chain: new RelationChain("", ""),
                    index: 0,
                    modulator: this.modulator,
                },
                this.memberNotifier
            ));
            return;
        } else if (root) {
            this.preloadedPages.set(root.url, root);
        }

        if (await this.modulator.pendingCount() < 1) {
            this.logger.debug(`[start] Starting at ${url}`);

            // Pushing the root relation
            const relation = new RelationChain(
                "",
                url,
                [],
                undefined,
                this.compareRelations,
            ).push(url, {
                important: false,
                value: 0,
            });

            this.launchRelation(relation);
            this.background(this.modulator.push([{ chain: relation, expected: new Set() }]));
        } else {
            this.logger.debug(
                "[start] Things are already inflight, not adding start url",
            );
        }
    }

    private launchRelation(chain: RelationChain) {
        this.relationFinished.set(chain, false);
        this.launchedRelations.push(chain);
    }

    async cancel() {
        this.canceled = true;
        await Promise.all([
            this.processingEmit,
            this.processingCheckEnd,
        ]);
    }

    /**
     * This function implements the logic of a synchronized end checking loop that uses
     * the @isEndChecking and @shouldCheckEndAgain flags to prevent multiple end checking loops from running at the same time. 
     * When a process is already running, subsequent calls simply set the shouldCheckEndAgain flag and return. 
     * The original process then picks up these pending requests in its loop, 
     * ensuring sequential execution without overlapping asynchronous operations
     */
    private async checkEnd() {
        if (this.isEndChecking) {
            this.shouldCheckEndAgain = true;
            return;
        }

        this.isEndChecking = true;
        this.processingCheckEnd = (async () => {
            try {
                while (true) {
                    this.shouldCheckEndAgain = false;
                    await this._checkEnd();
                    if (this.shouldCheckEndAgain && !this.canceled) {
                        continue;
                    }
                    break;
                }
            } finally {
                this.isEndChecking = false;
            }
        })();
        await this.processingCheckEnd;
    }

    async _checkEnd() {
        if (this.canceled) return;

        // Check if there are any pending fragments
        if (await this.modulator.pendingCount() < 1 && this.launchedRelations.isEmpty()) {
            this.logger.debug("[_checkEnd] No more pending relations");
            let member = this.members.pop();
            while (member) {
                await this.emitIfNotOld(member);
                member = this.members.pop();
            }

            // Make sure polling task is only scheduled once
            if (this.polling) {
                this.logger.debug(`[_checkEnd] Polling is enabled, setting timeout of ${this.pollInterval || 1000} ms to poll`);
                setTimeout(() => {
                    if (this.canceled) return;

                    this.notifier.pollCycle({}, {});
                    const toPollArray = this.toPoll.toArray();
                    this.logger.debug(
                        `[_checkEnd] Let's repoll (${JSON.stringify(
                            toPollArray.map((x) => x.chain.target),
                        )})`,
                    );
                    this.toPoll.clear();

                    for (const rel of toPollArray) {
                        this.launchRelation(rel.chain);
                    }
                    this.background(this.modulator.push(toPollArray));
                }, this.pollInterval || 1000);
            } else {
                this.logger.debug("[_checkEnd] Closing the notifier, polling is not set");
                this.canceled = true;
                this.notifier.close({}, {});
            }
        }
    }

    /**
     * Extracting basic information from the relation, according to the current configuration
     * Sorting in ascending order: if a relation comes in with a LT relation, then that relation is not important, because it can be handled later
     * Sorting in descending order: if a relation comes in with a GT relation, then that relation is not important, because it can be handled later
     */
    private compareRelations = (a: OrderValue, b: OrderValue): number =>
        (this.ordered === "ascending" ? 1 : -1) * compareOrderValues(a, b);

    private extractRelation(rel: FoundRelation): SimpleRelation {
        let bound: OrderValue | undefined;
        const relationTypes = this.ordered === "ascending" ? GTRs : LTR;
        for (const relation of rel.relations) {
            if (this.primaryPathKey === undefined || relation.pathKey !== this.primaryPathKey) continue;
            const term = relation.value?.[0];
            if (!term) continue;

            let value: OrderValue | undefined;
            if (this.timestampOrdering && relation.type.value === TREE.custom("InBetweenRelation")) {
                const datatype = term.termType === "Literal" ? term.datatype.value : undefined;
                const interval = parseInBetweenRelation(term.value, datatype, "Z");
                value = this.ordered === "ascending" ? interval?.min : interval?.max;
            } else if (relationTypes.some((type) => type.equals(relation.type))) {
                const date = this.timestampOrdering ? new Date(term.value) : undefined;
                value = date && !Number.isNaN(date.getTime()) ? date : termToOrderValue(term);
            }
            if (value !== undefined && (bound === undefined || this.compareRelations(value, bound) < 0)) {
                bound = value;
            }
        }
        return { important: bound !== undefined, value: bound ?? 0 };
    }

    private async handleFetched(page: FetchedPage, state: { chain: RelationChain, index: number }) {
        // Page was fetched and will now be extracted
        await this.manager.extractMembers(
            page,
            {
                modulator: this.modulator,
                ...state
            },
            this.memberNotifier
        );
    }

    /**
     * This function implements the logic of a synchronized emit loop that uses
     * the @isChecking and @shouldCheckAgain flags to prevent multiple emit loops from running at the same time. 
     * When a process is already running, subsequent calls simply set the shouldCheckAgain flag and return. 
     * The original process then picks up these pending requests in its loop, 
     * ensuring sequential execution without overlapping asynchronous operations
     */
    /**
     * Runs work that nobody waits for. When it fails, that is reported as an error of the client, where it would
     * otherwise be an unhandled rejection that stops the process.
     */
    private background(work: Promise<unknown>) {
        work.catch((ex) => this.notifier.error(ex, {}));
    }

    private async checkEmit() {
        if (this.isEmitChecking) {
            this.shouldCheckEmitAgain = true;
            return;
        }

        this.isEmitChecking = true;
        this.processingEmit = (async () => {
            try {
                while (true) {
                    this.shouldCheckEmitAgain = false;
                    await this._checkEmit();
                    if (this.shouldCheckEmitAgain && !this.canceled) {
                        continue;
                    }
                    break;
                }
            } finally {
                this.isEmitChecking = false;
            }
        })();
        await this.processingEmit;
    }

    /**
     * The actual emit loop. Maybe we can emit a member
     * only in the case when our current relation is important
     */
    private async _checkEmit() {
        if (this.canceled) return;
        this.logger.debug("[_checkEmit] Checking possible member emission");
        let head = this.launchedRelations.pop();
        while (head) {
            // Find the most conservative important marker 
            // (i.e., the relation leading to a fragment containing members 
            // with the lowest or highest timestamp value, depending of the chosen order) 
            // across all active branches. This includes the current head and everything still in the queue.
            const allActive = [head, ...this.launchedRelations.toArray()];
            const importantChains = allActive.filter(rel => rel?.important());

            let marker: SimpleRelation = { value: 0, important: false };
            if (importantChains.length > 0) {
                // In Ascending LDES: This finds the relation with the lowest timestamp value.
                // In Descending LDES: This finds the relation with the highest timestamp value.
                const mostConservative = importantChains.reduce((a, b) => a!.ordering(b!) < 0 ? a : b);
                marker = mostConservative!.relations[0];
            }

            this.logger.debug("[_checkEmit] Marker found: {important: " + marker.important
                + ", value: " + String(marker.value) + "}");

            // A relation should only be blocked by PEER branches that are in transit.
            // It should NOT be blocked by its own descendants or by itself.
            // However, if we don't have an important marker, we must be strict and block on children too
            // to ensure we don't interleave members from the same time slice out of order.
            const inTransit = (await Promise.all([
                this.modulator.getAllInFlight(),
                this.modulator.getAllTodo()
            ])).flat().find((x) =>
                x.chain.ordering(head!) == 0 &&
                (marker.important ?
                    (!x.expected.has(head!.target) && x.chain.target !== head!.target) :
                    true
                )
            );

            const completed = this.relationFinished.get(head);
            if (inTransit || (!head.important() && !completed)) {
                this.logger.debug("[_checkEmit] In transit (blocking): " + (inTransit?.chain.target ?? head.target));
                break;
            }

            // Proceed to emit some members in order
            let member = this.members.pop();
            while (member) {
                const order = this.timestampOrdering ? member.timestamp : member.sequence;
                if (order === undefined || !marker.important ||
                    !comparableOrderValues(order, marker.value) ||
                    this.compareRelations(order, marker.value) < 0) {
                    await this.emitIfNotOld(member);
                } else {
                    this.logger.debug("[_checkEmit] Member <" + member.id.value + "> with ordering value "
                        + String(order) + " didn't fit in the marker range");
                    break;
                }
                member = this.members.pop();
            }

            // This member failed the boundary check, let's put him back
            if (member) {
                this.members.push(member);
            }

            // A bound can let us emit members while its page is still pending.
            // Keep it in the heap until that page has finished extraction.
            if (!completed) break;
            head = this.launchedRelations.pop();
        }

        if (head) {
            this.launchedRelations.push(head);
        }

        await this.checkEnd();
    }

    private async emitIfNotOld(member: Member) {
        let isOld: boolean;
        try {
            // In the ordered strategy, we need to check again if this is an older version of the member
            // when emitting latest versions only, because older versions might have been fetched and queued
            // at a previous point in time.
            isOld = await memberIsOld(member, this.modulator);
        } catch (ex) {
            // Things are shutting down, stop processing
            return;
        }
        if (!isOld) {
            // Emit member and record it as emitted
            // Make sure we keep the original member Id. It might change if materialization is enabled
            const memberIri = member.id.value;
            const streamed = this.notifier.member(member, {}) as boolean;
            if (streamed) {
                // We need this check in case the client is shut down while emitting
                await this.modulator.addEmitted(memberIri);
            }
        } else {
            // Remove member from unemitted list as a newer version was already available/emitted
            await this.modulator.deleteUnemitted(member.id.value);
        }
    }
}

function comparableOrderValues(a: OrderValue, b: OrderValue): boolean {
    if (isNumericOrderValue(a) || isNumericOrderValue(b)) {
        return (isNumericOrderValue(a) || typeof a === "number") &&
            (isNumericOrderValue(b) || typeof b === "number");
    }
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date;
    return typeof a === typeof b;
}

function compareMembers(a: Member, b: Member, ordered: Ordered, timestampOrdering: boolean): number {
    if (a.id.equals(b.id)) return 0;
    let order = timestampOrdering
        ? compareOrderValues(a.timestamp, b.timestamp)
        : compareOrderValues(a.sequence, b.sequence);
    if (order === 0 && timestampOrdering) {
        order = compareOrderValues(a.sequence, b.sequence);
    }
    if (order !== 0) {
        return ordered === "ascending" ? order : -order;
    }
    if (a.transactionFinalized !== b.transactionFinalized) {
        return a.transactionFinalized ? 1 : -1;
    }
    return a.id.value < b.id.value ? -1 : 1;
}

function compareOrderValues(
    a: OrderValue | undefined,
    b: OrderValue | undefined,
): number {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if ((isNumericOrderValue(a) || typeof a === "number") &&
        (isNumericOrderValue(b) || typeof b === "number")) {
        return compareNumericStrings(isNumericOrderValue(a) ? a.value : String(a),
            isNumericOrderValue(b) ? b.value : String(b));
    }
    const left = a instanceof Date ? a.getTime() : a;
    const right = b instanceof Date ? b.getTime() : b;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function compareNumericStrings(a: string, b: string): number {
    const left = parseDecimal(a);
    const right = parseDecimal(b);
    if (!left || !right) {
        const leftNumber = Number(a);
        const rightNumber = Number(b);
        if (leftNumber < rightNumber) return -1;
        if (leftNumber > rightNumber) return 1;
        return 0;
    }
    if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
    const scale = Math.max(left.scale, right.scale);
    const leftInt = left.integer * 10n ** BigInt(scale - left.scale);
    const rightInt = right.integer * 10n ** BigInt(scale - right.scale);
    if (leftInt === rightInt) return 0;
    return (leftInt < rightInt ? -1 : 1) * left.sign;
}

function parseDecimal(value: string): { sign: 1 | -1; integer: bigint; scale: number } | undefined {
    const match = value.trim().match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
    if (!match) return;
    const sign = match[1] === "-" ? -1 : 1;
    const before = match[2] ?? "";
    const after = match[3] ?? match[4] ?? "";
    const exponent = Number(match[5] ?? 0);
    const digits = `${before}${after}`.replace(/^0+/, "") || "0";
    return {
        sign,
        integer: BigInt(digits),
        scale: Math.max(0, after.length - exponent),
    };
}
