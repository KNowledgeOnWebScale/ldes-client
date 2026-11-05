import { CBDShapeExtractor } from "extract-cbd-shape";
import { DC, LDES, TREE } from "@treecg/types";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import {
    getObjects,
    memberFromQuads,
    getLoggerFor,
    isNumericOrderValue,
} from "../../utils";
import { Condition } from "../../condition";

import type { Quad, Term } from "@rdfjs/types";
import type { Modulator } from "./modulator";
import type { Notifier } from "../../types";
import type { FetchedPage, LDESInfo, Member } from "../../types";

const { namedNode } = new DataFactory();

export type ExtractError = {
    type: "extract";
    memberId: Term;
    error: unknown;
};
export type MemberEvents = {
    extracted: Member;
    done: FetchedPage;
    error: ExtractError;
};

interface ExtractionState {
    modulator: Modulator<unknown, unknown>;
}

export class Manager {
    public queued: number = 0;

    private closed = false;
    private ldesUri: Term | null;

    private extractor: CBDShapeExtractor;
    private shapeId?: Term;

    private timestampPath?: Term;
    private sequencePath?: Term;
    private sequencePathTerms?: Term[];
    private transactionFinalizedPath?: Term;
    private transactionFinalizedPathTerms?: Term[];
    private transactionFinalizedObject?: Term;
    private isVersionOfPath?: Term;
    private pathStore: RdfStore;

    private logger = getLoggerFor(this);
    private loose: boolean;

    private condition: Condition;
    private extracting = new Set<string>();

    constructor(
        ldesUri: Term | null,
        info: LDESInfo,
        loose = false,
        condition: Condition,
    ) {
        this.ldesUri = ldesUri;
        this.extractor = info.extractor;
        this.timestampPath = info.timestampPath;
        this.sequencePath = info.sequencePath;
        this.sequencePathTerms = info.sequencePathTerms;
        this.transactionFinalizedPath = info.transactionFinalizedPath;
        this.transactionFinalizedPathTerms = info.transactionFinalizedPathTerms;
        this.transactionFinalizedObject = info.transactionFinalizedObject;
        this.isVersionOfPath = info.versionOfPath;
        this.pathStore = RdfStore.createDefault();
        info.contextQuads?.forEach((quad) => this.pathStore.addQuad(quad));
        this.shapeId = info.shape;
        this.loose = loose;
        this.condition = condition;

        if (!this.ldesUri) {
            this.logger.debug(
                "new local dump member extractor"
            );
        } else {
            this.logger.debug(
                `new member extractor for ${this.ldesUri.value}:`);
        }
        this.logger.debug(`${JSON.stringify({
            extractor: info.extractor.constructor.name,
            shape: info.shape,
            timestampPath: info.timestampPath,
            sequencePath: info.sequencePath,
            isVersionOfPath: info.versionOfPath,
        })}`);
    }

    // Extract members found in this page, this does not yet emit the members
    async extractMembers<S extends ExtractionState>(
        page: FetchedPage,
        state: S,
        notifier: Notifier<MemberEvents, S>,
    ) {
        const members = this.loose
            ? getObjects(page.data, null, TREE.terms.member, null)
            : getObjects(page.data, this.ldesUri, TREE.terms.member, null);

        const pageCreatedIso = getObjects(
            page.data,
            namedNode(page.url),
            DC.terms.custom("created"),
            null,
        )[0]?.value;
        const pageCreated = pageCreatedIso
            ? new Date(pageCreatedIso)
            : undefined;
        const pageUpdatedIso = getObjects(
            page.data,
            namedNode(page.url),
            DC.terms.modified,
            null,
        )[0];
        const pageUpdated = pageUpdatedIso
            ? new Date(pageUpdatedIso.value)
            : undefined;

        this.logger.debug(`Found ${members.length} members in ${page.url}, checking extra conditions...`);

        let allowedMembers = 0;

        // Claim the members that have to be extracted from this page
        const claimed: Term[] = [];
        for (const member of members) {
            if (this.extracting.has(member.value)) continue;
            if (await state.modulator.wasEmitted(member.value)) continue;
            // Recheck after the asynchronous state lookup: another concurrently
            // processed page may have claimed this member while we were waiting.
            if (!this.extracting.has(member.value)) {
                this.extracting.add(member.value);
                claimed.push(member);
            }
        }

        /** Turns the quads of an extracted member into an emitted member, if the conditions allow it */
        const handle = (id: Term, quads: Quad[] | undefined): Promise<void> =>
            Promise.resolve()
                .then(async () => {
                    const member = quads && this.toMember(id, quads, page.data);
                    if (member && !this.closed) {
                        // Check if member matches condition
                        if (!this.condition.matchMember(member)) {
                            this.logger.silly(`Member <${member.id.value}> does not match condition`);
                            return;
                        }
                        // Emit this member
                        this.condition.memberEmitted(member);
                        this.logger.silly(`Member <${member.id.value}> will be emitted`);
                        allowedMembers++;
                        await notifier.extracted(member, state);
                    }
                })
                .catch((ex) => {
                    this.logger.error(ex);
                    notifier.error(
                        { error: ex, type: "extract", memberId: id },
                        state,
                    );
                })
                .finally(() => this.extracting.delete(id.value));

        const promises: Promise<void>[] = [];
        if (claimed.length > 0) {
            promises.push(this.extractClaimed(page.data, claimed, members, handle));
        }

        Promise.all(promises).then(async () => {
            if (!this.closed) {
                this.logger.verbose(`Extracted ${allowedMembers} out of ${members.length} members from fragment <${page.url}>`);
                page.created = pageCreated;
                page.updated = pageUpdated;
                page.memberCount = members.length;
                await notifier.done(page, state);
            }
        }).catch((ex) => {
            this.logger.error(ex);
            // There is no member to name: the error is about the page
            notifier.error({ error: ex, type: "extract", memberId: namedNode(page.url) }, state);
        });
    }

    close() {
        this.closed = true;
    }

    /**
     * Extracts the claimed members of a page with one bulk extraction. Extracting them one by one is quadratic in the
     * number of members of the page: every extraction has to be told to ignore the graphs of all other members.
     * If the bulk extraction fails, the members that it did not reach are extracted one by one, so that a member that
     * cannot be extracted only costs that member, as it did before.
     */
    private async extractClaimed(
        data: RdfStore,
        claimed: Term[],
        pageMembers: Term[],
        handle: (id: Term, quads: Quad[] | undefined) => Promise<void>,
    ): Promise<void> {
        const handled = new Set<string>();
        const handlers: Promise<void>[] = [];
        const claimedIds = new Set(claimed.map((member) => member.value));
        // The members of the page that are not extracted here (emitted already, or claimed by another page)
        // are not part of the description of the members that are
        const ignored = [
            namedNode(LDES.custom("IngestionMetadata")),
            ...pageMembers.filter((member) => !claimedIds.has(member.value)),
        ];
        try {
            await this.extractor.bulkExtract(
                data,
                claimed,
                this.shapeId,
                ignored,
                ({ subject, quads }) => {
                    handled.add(subject.value);
                    handlers.push(handle(subject, quads));
                },
            );
        } catch (ex) {
            this.logger.error(
                `Bulk extraction failed, extracting the remaining members one by one: ${(<Error>ex).message}`,
            );
            for (const member of claimed) {
                if (handled.has(member.value)) continue;
                handled.add(member.value);
                handlers.push(handle(member, await this.extractOne(member, data, pageMembers)));
            }
        }
        await Promise.all(handlers);
    }

    private async extractOne(
        member: Term,
        data: RdfStore,
        otherMembers: Term[] = [],
    ): Promise<Quad[] | undefined> {
        try {
            return await this.extractor.extract(
                data,
                member,
                this.shapeId,
                [namedNode(LDES.custom("IngestionMetadata")), ...otherMembers],
            );
        } catch (ex) {
            this.logger.error((<Error>ex).message);
            return;
        }
    }

    private toMember(member: Term, quads: Quad[], data: RdfStore): Member | undefined {
        try {
            const created = getObjects(
                data,
                member,
                DC.terms.custom("created"),
                namedNode(LDES.custom("IngestionMetadata")),
            )[0]?.value;

            if (quads.length > 0) {
                return memberFromQuads(
                    member,
                    quads,
                    this.timestampPath,
                    this.sequencePath,
                    this.sequencePathTerms,
                    this.transactionFinalizedPath,
                    this.transactionFinalizedPathTerms,
                    this.transactionFinalizedObject,
                    this.isVersionOfPath,
                    created ? new Date(created) : undefined,
                    this.pathStore,
                    data,
                );
            }
        } catch (ex) {
            this.logger.error((<Error>ex).message);
            return;
        }
    }
}

const memberIsOldLogger = getLoggerFor("memberIsOld");

export async function memberIsOld(member: Member, modulator: Modulator<unknown, unknown>) {
    if (!modulator.hasLatestVersions() || !member.isVersionOf || !member.timestamp) {
        return false;
    }
    memberIsOldLogger.silly(`[memberIsOld] Checking if member <${member.id.value}> (version of: ${member.isVersionOf}) is old`);
    // We are emitting latest versions only
    const version = member.timestamp instanceof Date
        ? member.timestamp.getTime()
        : isNumericOrderValue(member.timestamp)
            ? Number.NaN
            : new Date(member.timestamp).getTime();
    if (Number.isNaN(version)) {
        return false;
    }
    return await modulator.filterLatest(member.isVersionOf, version);
}
