import { describe, afterAll, expect, test } from "vitest";
import { ProcHelper } from "@rdfc/js-runner/lib/testUtils/index.js";
import { LDESClientProcessor } from "../../lib/rdfc-processor";
import { rmSync } from "fs";

import type { FullProc } from "@rdfc/js-runner";


describe("Tests for rdfc:LdesClient processor", () => {
    afterAll(() => {
        rmSync("state-path", { recursive: true, force: true });
    });

    test("rdfc:LdesClient is properly defined", async () => {
        const processor = `
        @prefix rdfc: <https://w3id.org/rdf-connect#>.
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

        <http://example.com/ns#processor> a rdfc:LdesClient;
            rdfc:url <https://era.ilabt.imec.be/rinf/ldes>;
            rdfc:output <jw>;
            rdfc:before "2025-01-01T00:00:00.000Z"^^xsd:dateTime;
            rdfc:after "2023-12-31T23:59:59.000Z"^^xsd:dateTime;
            rdfc:ordered "ascending";
            rdfc:follow true;
            rdfc:interval 5;
            rdfc:shapeFile "/path/to/shape.ttl";
            rdfc:noShape false;
            rdfc:savePath "state-path";
            rdfc:loose false;
            rdfc:urlIsView false;
            rdfc:fetch [
                rdfc:concurrent 5;
                rdfc:retry [
                    rdfc:code 404, 403;
                    rdfc:maxRetry 5;
                ];
                rdfc:safe true;
                rdfc:auth [
                    rdfc:auth "test";
                    rdfc:type "basic"
                ]
            ];
            rdfc:materialize true;
            rdfc:lastVersionOnly true;
            rdfc:startFresh true;
            rdfc:streamId "MyStream";
            rdfc:sdsify true.
        `;

        const configLocation = process.cwd() + "/processor.ttl";

        const procHelper = new ProcHelper<FullProc<LDESClientProcessor>>();
        // Load processor semantic definition
        await procHelper.importFile(configLocation);
        // Load processor instance declaration
        await procHelper.importInline("pipeline.ttl", processor);

        // Get processor configuration
        procHelper.getConfig("LdesClient");

        // Instantiate processor from declared instance
        const proc: FullProc<LDESClientProcessor> = await procHelper.getProcessor("http://example.com/ns#processor");


        expect(proc).toBeDefined();
        expect(proc.url).toBe("https://era.ilabt.imec.be/rinf/ldes");
        expect(proc.output.uri).toContain("jw");
        expect(proc.after!.toISOString()).toBe("2023-12-31T23:59:59.000Z");
        expect(proc.ordered).toBe("ascending");
        expect(proc.follow).toBeTruthy();
        expect(proc.pollInterval).toBe(5);
        expect(proc.shapeFile).toBe("/path/to/shape.ttl");
        expect(proc.noShape).toBeFalsy();
        expect(proc.savePath).toBe("state-path");
        expect(proc.loose).toBeFalsy();
        expect(proc.urlIsView).toBeFalsy();
        expect(proc.fetchConfig).toEqual({
            concurrent: 5,
            retry: {
                codes: [404, 403],
                maxRetries: 5,
            },
            auth: {
                type: "basic",
                auth: "test",
            },
            safe: true,
        });
        expect(proc.materialize).toBeTruthy();
        expect(proc.lastVersionOnly).toBeTruthy();
        expect(proc.startFresh).toBeTruthy();
        expect(proc.streamId).toBe("MyStream");
        expect(proc.sdsify).toBeTruthy();
    });
});
