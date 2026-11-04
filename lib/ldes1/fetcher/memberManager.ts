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
        const promises: Promise<Member | undefined | void>[] = [];

        for (const member of members) {
            if (this.extracting.has(member.value)) continue;
            if (await state.modulator.wasEmitted(member.value)) continue;
            // Recheck after the asynchronous state lookup: another concurrently
            // processed page may have claimed this member while we were waiting.
            if (!this.extracting.has(member.value)) {
                this.extracting.add(member.value);
                const promise = this.extractMember(member, page.data, members)
                    .then(async (member) => {
                        if (member) {
                            if (!this.closed) {
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
                        }
                    })
                    .catch((ex) => {
                        this.logger.error(ex);
                        notifier.error(
                            { error: ex, type: "extract", memberId: member },
                            state,
                        );
                    })
                    .finally(() => this.extracting.delete(member.value));

                promises.push(promise);
            }
        }

        Promise.all(promises).then(async () => {
            if (!this.closed) {
                this.logger.verbose(`Extracted ${allowedMembers} out of ${members.length} members from fragment <${page.url}>`);
                page.created = pageCreated;
                page.updated = pageUpdated;
                page.memberCount = members.length;
                await notifier.done(page, state);
            }
        });
    }

    close() {
        this.closed = true;
    }

    private async extractMember(
        member: Term,
        data: RdfStore,
        otherMembers: Term[] = [],
    ): Promise<Member | undefined> {
        try {
            const quads: Quad[] = await this.extractor.extract(
                data,
                member,
                this.shapeId,
                [namedNode(LDES.custom("IngestionMetadata")), ...otherMembers],
            );
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
