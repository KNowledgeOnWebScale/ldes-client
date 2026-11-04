import { describe, afterAll, expect, test } from "vitest";
import { ProcHelper } from "@rdfc/js-runner/lib/testUtils/index.js";
import { LDESClientProcessor } from "../../lib/rdfc-processor";
import { rmSync } from "fs";
import { resolve } from "path";
import { toPath } from "@rdfc/utils-js";

import type { FullProc } from "@rdfc/js-runner";

describe("Tests for rdfcp:LdesClient processor", () => {
    afterAll(() => {
        rmSync("state-path", { recursive: true, force: true });
    });

    test("rdfcp:LdesClient is properly defined", async () => {
        const processor = `
        @prefix rdfc: <https://w3id.org/rdf-connect#>.
        @prefix rdfcp: <https://w3id.org/rdf-connect/processors#>.
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

        <http://example.com/ns#processor> a rdfcp:LdesClient;
            rdfcp:url <https://era.ilabt.imec.be/rinf/ldes>;
            rdfcp:output <jw>;
            rdfcp:before "2025-01-01T00:00:00.000Z"^^xsd:dateTime;
            rdfcp:after "2023-12-31T23:59:59.000Z"^^xsd:dateTime;
            rdfcp:ordered "ascending";
            rdfcp:follow true;
            rdfcp:interval 5;
            rdfcp:shapeFile "/path/to/shape.ttl";
            rdfcp:noShape false;
            rdfcp:savePath "state-path";
            rdfcp:loose false;
            rdfcp:urlIsView false;
            rdfcp:fetch [
                rdfcp:concurrent 5;
                rdfcp:retry [
                    rdfcp:code 404, 403;
                    rdfcp:maxRetry 5;
                ];
                rdfcp:safe true;
                rdfcp:auth [
                    rdfcp:auth "test";
                    rdfcp:type "basic"
                ]
            ];
            rdfcp:materialize true;
            rdfcp:lastVersionOnly true;
            rdfcp:startFresh true;
            rdfcp:streamId "MyStream";
            rdfcp:sdsify true.
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

    test("rdfcp:LdesClient falls back to its default values", async () => {
        const processor = `
        @prefix rdfc: <https://w3id.org/rdf-connect#>.
        @prefix rdfcp: <https://w3id.org/rdf-connect/processors#>.

        <http://example.com/ns#processor> a rdfcp:LdesClient;
            rdfcp:url <https://era.ilabt.imec.be/rinf/ldes>;
            rdfcp:output <jw>.
        `;

        const configLocation = process.cwd() + "/processor.ttl";

        const procHelper = new ProcHelper<FullProc<LDESClientProcessor>>();
        await procHelper.importFile(configLocation);
        await procHelper.importInline("pipeline.ttl", processor);
        procHelper.getConfig("LdesClient");

        const proc: FullProc<LDESClientProcessor> = await procHelper.getProcessor("http://example.com/ns#processor");

        expect(proc.url).toBe("https://era.ilabt.imec.be/rinf/ldes");
        expect(proc.ordered).toBe("none");
        expect(proc.pollInterval).toBe(1000);
    });
    test("rdfcp:LdesClient accepts locations and the URL written as IRIs", async () => {
        const processor = `
        @prefix rdfc: <https://w3id.org/rdf-connect#>.
        @prefix rdfcp: <https://w3id.org/rdf-connect/processors#>.

        <http://example.com/ns#processor> a rdfcp:LdesClient;
            rdfcp:url <https://era.ilabt.imec.be/rinf/ldes>;
            rdfcp:output <jw>;
            rdfcp:shapeFile <./tests/data/mock-ldes/full-shape.ttl>;
            rdfcp:savePath <./state-path>;
            rdfcp:conditionFile <./test-condition.ttl>.
        `;

        const procHelper = new ProcHelper<FullProc<LDESClientProcessor>>();
        await procHelper.importFile(process.cwd() + "/processor.ttl");
        await procHelper.importInline(resolve("pipeline.ttl"), processor);
        procHelper.getConfig("LdesClient");

        const proc: FullProc<LDESClientProcessor> = await procHelper.getProcessor("http://example.com/ns#processor");

        expect(proc.url).toBe("https://era.ilabt.imec.be/rinf/ldes");
        expect(toPath(proc.shapeFile!)).toBe(resolve("./tests/data/mock-ldes/full-shape.ttl"));
        expect(toPath(proc.savePath!)).toBe(resolve("./state-path"));
        expect(toPath(proc.conditionFile!)).toBe(resolve("./test-condition.ttl"));

        // The client gets paths, and the condition file can be read
        await proc.init();
        const config = proc.client["config"];
        expect(config.shapeFile).toBe(resolve("./tests/data/mock-ldes/full-shape.ttl"));
        expect(config.statePath).toBe(resolve("./state-path"));
        expect(config.condition.constructor.name).toBe("AndCondition");
    });
});
