import { CBDShapeExtractor } from "extract-cbd-shape";
import { DC, LDES, TREE } from "@treecg/types";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import {
    getObjects,
    memberFromQuads,
    getLoggerFor,
    memberIsOld
} from "../utils";
import { Condition } from "../condition";

import type { Quad, Term } from "@rdfjs/types";
import type { Modulator, Notifier } from "./modulator";
import type { FetchedPage } from "./pageFetcher";

const { namedNode } = new DataFactory();

export interface Member {
    id: Term;
    quads: Quad[];
    timestamp?: string | Date;
    isVersionOf?: string;
    type?: Term;
    created?: Date;
}

export type LDESInfo = {
    shape: Term;
    shapeQuads: Quad[];
    extractor: CBDShapeExtractor;
    timestampPath?: Term;
    versionOfPath?: Term;
};

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
    private isVersionOfPath?: Term;

    private logger = getLoggerFor(this);
    private loose: boolean;

    private condition: Condition;

    constructor(
        ldesUri: Term | null,
        info: LDESInfo,
        loose = false,
        condition: Condition,
    ) {
        this.ldesUri = ldesUri;
        this.extractor = info.extractor;
        this.timestampPath = info.timestampPath;
        this.isVersionOfPath = info.versionOfPath;
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
            if (!(await state.modulator.wasEmitted(member.value))) {
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
                    });

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

    private async extractMemberQuads(
        member: Term,
        data: RdfStore,
        otherMembers: Term[] = [],
    ): Promise<Quad[]> {
        return await this.extractor.extract(data, member, this.shapeId, [
            namedNode(LDES.custom("IngestionMetadata")),
            ...otherMembers,
        ]);
    }

    private async extractMember(
        member: Term,
        data: RdfStore,
        otherMembers: Term[] = [],
    ): Promise<Member | undefined> {
        try {
            const quads: Quad[] = await this.extractMemberQuads(member, data, otherMembers);
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
                    this.isVersionOfPath,
                    created ? new Date(created) : undefined,
                );
            }
        } catch (ex) {
            this.logger.error((<Error>ex).message);
            return;
        }
    }
}
