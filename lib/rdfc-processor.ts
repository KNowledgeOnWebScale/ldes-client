import { extendLogger, Processor, Writer } from "@rdfc/js-runner";
import { DataFactory } from "rdf-data-factory";
import { SDS } from "@treecg/types";
import { Writer as NWriter } from "n3";
import { Client, replicateLDES, intoConfig, processConditionFile } from "./client";
import { enhanced_fetch } from "./fetcher"
import { Logger } from "winston";

import type { Quad_Object } from "@rdfjs/types";
import type { Ordered } from "./strategy";

const df = new DataFactory();

type LDESClientArgs = {
    url: string;
    output: Writer;
    before?: Date;
    after?: Date;
    ordered?: string;
    follow?: boolean;
    pollInterval?: number;
    shapeFile?: string;
    noShape?: boolean;
    savePath?: string;
    loose?: boolean;
    urlIsView?: boolean;
    fetchConfig?: {
        auth?: {
            type: "basic";
            auth: string;
            host: string;
        };
        concurrent?: number;
        retry?: {
            codes: number[];
            maxRetries: number;
        };
        safe?: boolean;
    };
    conditionFile?: string;
    materialize?: boolean;
    lastVersionOnly?: boolean;
    startFresh?: boolean;
    streamId?: string;
    sdsify?: boolean;
};

export class LDESClientProcessor extends Processor<LDESClientArgs> {
    protected ldesClientLogger!: Logger;
    public client!: Client;

    async init(this: LDESClientArgs & this): Promise<void> {
        this.ldesClientLogger = extendLogger(this.logger, "LDESClientProcessor");
        this.client = replicateLDES(
            intoConfig({
                url: this.url,
                after: this.after,
                before: this.before,
                polling: this.follow,
                pollInterval: this.pollInterval,
                shapeFile: this.shapeFile,
                noShape: this.noShape,
                statePath: this.savePath,
                loose: this.loose,
                urlIsView: this.urlIsView,
                fetch: this.fetchConfig ? enhanced_fetch(this.fetchConfig) : fetch,
                condition: await processConditionFile(this.conditionFile),
                materialize: this.materialize,
                lastVersionOnly: this.lastVersionOnly,
                startFresh: this.startFresh,
                concurrentFetches: this.fetchConfig?.concurrent,
            }),
            <Ordered>this.ordered || "none",
            undefined,
            this.streamId ? df.namedNode(this.streamId) : undefined,
        );
    }

    async transform(this: LDESClientArgs & this): Promise<void> {
        // Nothing to do here, everything is done in the member stream processing
    }

    async produce(this: LDESClientArgs & this): Promise<void> {
        const t0 = Date.now();

        if (this.fetchConfig?.auth) {
            this.logger.debug(`Using authentication for host ${this.fetchConfig.auth.host}`);
            this.fetchConfig.auth.host = new URL(this.url).host;
        }

        const reader = this.client.stream({ highWaterMark: 10 }).getReader();

        this.client.on("fragment", async (fragment) => {
            this.logger.verbose(`Got fragment: ${fragment.url}`);
        });

        this.output.on("cancel", async () => {
            await reader.cancel();
            this.logger.verbose("Stream cancelled, stopping LDES client");
        });

        let member = await reader.read();

        while (member) {
            if (member.value) {

                if (this.client.memberCount % 100 === 0) {
                    this.logger.verbose(
                        `Got member number ${this.client.memberCount} with ID ${member.value.id.value} and ${member.value.quads.length} quads`,
                    );
                }

                const quads = member.value.quads.slice();

                if (this.sdsify) {
                    const blank = df.blankNode();
                    quads.push(
                        df.quad(
                            blank,
                            SDS.terms.stream,
                            <Quad_Object>this.client.streamId!,
                            SDS.terms.custom("DataDescription"),
                        ),
                        df.quad(
                            blank,
                            SDS.terms.payload,
                            <Quad_Object>member.value.id!,
                            SDS.terms.custom("DataDescription"),
                        ),
                    );
                }

                await this.output.string(new NWriter().quadsToString(quads));
            }

            if (member.done) {
                break;
            }

            member = await reader.read();
        }

        this.logger.verbose(`Found ${this.client.memberCount} members in ${this.client.fragmentCount} fragments (took ${Date.now() - t0} ms)`);

        // We extracted all members, so we can close the writer
        await this.output.close();
    }
}
