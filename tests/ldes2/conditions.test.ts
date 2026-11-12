/**
 * The conditions of the client (a condition file, or a MaxCountCondition) also apply to an LDES 2.0:
 * they filter the members, and prune the relations and pages that cannot lead to wanted members.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { replicateLDES, intoConfig } from "../../lib/client";
import { MaxCountCondition, parse_condition } from "../../lib/condition";
import { MockServer } from "./server";

import type { Condition } from "../../lib/condition";
import type { Member } from "../../lib/types";

const server = new MockServer(3003);
const ROOT = `${server.base}/root`;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
    server.pages.clear();
    server.requests = [];
});

const record = (name: string, time: string, extra = "") => `ex:${name} a ex:Record ; dcterms:created "${time}"^^xsd:dateTime ${extra}.`;

const ids = (members: Member[]) => members.map((m) => m.id.value.replace("http://example.org/", ""));

async function collect(condition: Condition, config: Record<string, unknown> = {}) {
    const client = replicateLDES(intoConfig({ url: ROOT, condition, ...config }));
    const members: Member[] = [];
    const errors: unknown[] = [];
    client.on("error", (error) => errors.push(error));
    for await (const member of client.stream({ highWaterMark: 10 })) members.push(member);
    return { members, errors };
}

const description = "ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .";

/** A condition file, in which the members are restricted on a path */
const conditionOn = (path: string, relationType: string, value: string, compareType: string) =>
    parse_condition(
        `@prefix csp: <http://vocab.deri.ie/csp#>.
@prefix tree: <https://w3id.org/tree#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
@prefix dcterms: <http://purl.org/dc/terms/>.
@prefix ex: <http://example.org/>.
<> a csp:Condition; tree:relationType tree:${relationType}; tree:path ${path}; tree:value ${value}; tree:compareType "${compareType}".`,
        "http://example.org/condition",
    );

describe("Conditions in an LDES 2.0", () => {
    const setup = () => {
        server.trig(
            "/root",
            `${description}
<> ldes:relation
   [ ldes:page <${server.base}/jan> ; ldes:timeFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ; ldes:timeUntil "2026-02-01T00:00:00Z"^^xsd:dateTime ] ,
   [ ldes:page <${server.base}/mar> ; ldes:timeFrom "2026-03-01T00:00:00Z"^^xsd:dateTime ] .`,
        );
        server.trig("/jan", record("j1", "2026-01-01T00:00:00Z"), record("j2", "2026-01-10T00:00:00Z"), record("j3", "2026-01-20T00:00:00Z"));
        server.trig("/mar", record("m1", "2026-03-05T00:00:00Z"));
    };

    test("a condition on the timestamp filters the members, and the relations that cannot match are not followed", async () => {
        setup();
        const condition = conditionOn("dcterms:created", "LessThanRelation", '"2026-01-15T00:00:00Z"^^xsd:dateTime', "date");
        const { members, errors } = await collect(condition);
        expect(errors).toEqual([]);
        expect(ids(members)).toEqual(["j1", "j2"]);
        expect(server.requests).toContain("/jan");
        expect(server.requests).not.toContain("/mar");
    });

    test("a condition on the timestamp prunes the rest of a page, once its members are past the range", async () => {
        setup();
        const condition = conditionOn("dcterms:created", "GreaterThanOrEqualToRelation", '"2026-01-05T00:00:00Z"^^xsd:dateTime', "date");
        const { members } = await collect(condition);
        expect(ids(members)).toEqual(["j2", "j3", "m1"]);
    });

    test("a condition on another property filters the members, and does not prune relations", async () => {
        server.trig(
            "/root",
            `${description}
<> ldes:relation [ ldes:page <${server.base}/a> ] .`,
        );
        server.trig(
            "/a",
            record("a1", "2026-01-01T00:00:00Z", "; ex:size 5 "),
            record("a2", "2026-01-02T00:00:00Z", "; ex:size 50 "),
            record("a3", "2026-01-03T00:00:00Z", "; ex:size 500 "),
        );
        const condition = conditionOn("ex:size", "GreaterThanOrEqualToRelation", "10", "integer");
        const { members } = await collect(condition);
        expect(ids(members)).toEqual(["a2", "a3"]);
    });

    test("a condition on another property does not prune relations of the timestamp, whatever its values are", async () => {
        setup();
        // Compared as numbers, "size < 5" would not overlap with the timestamps, which are much larger
        server.trig("/jan", record("j1", "2026-01-01T00:00:00Z", "; ex:size 1 "), record("j2", "2026-01-10T00:00:00Z", "; ex:size 9 "));
        server.trig("/mar", record("m1", "2026-03-05T00:00:00Z", "; ex:size 2 "));
        const { members } = await collect(conditionOn("ex:size", "LessThanRelation", "5", "integer"));
        expect(ids(members)).toEqual(["j1", "m1"]);
        expect(server.requests).toContain("/mar");
    });

    test("a MaxCountCondition stops the client after that many members, in the pages that are open and the relations", async () => {
        setup();
        const { members } = await collect(new MaxCountCondition({ count: 2 }));
        expect(ids(members)).toEqual(["j1", "j2"]);
    });

    test("a MaxCountCondition that resets on every poll continues after the last emitted member", async () => {
        server.trig(
            "/root",
            `${description}
<> ldes:relation [ ldes:page <${server.base}/a> ] .`,
        );
        server.trig(
            "/a",
            record("a1", "2026-01-01T00:00:00Z"),
            record("a2", "2026-01-02T00:00:00Z"),
            record("a3", "2026-01-03T00:00:00Z"),
            record("a4", "2026-01-04T00:00:00Z"),
            record("a5", "2026-01-05T00:00:00Z"),
        );
        const client = replicateLDES(
            intoConfig({
                url: ROOT,
                polling: true,
                pollInterval: 20,
                condition: new MaxCountCondition({ count: 2, reset_on_poll: true }),
            }),
        );
        const members: Member[] = [];
        for await (const member of client.stream()) {
            members.push(member);
            if (members.length === 5) {
                await client.close();
                break;
            }
        }
        // Two members per poll cycle, none of them lost
        expect(ids(members)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    });

    test("a member on which the condition cannot be evaluated is reported as an extraction error, as in an LDES 1.0", async () => {
        server.trig(
            "/root",
            `${description}
<> ldes:relation [ ldes:page <${server.base}/a> ] .`,
        );
        server.trig(
            "/a",
            record("a1", "2026-01-01T00:00:00Z", "; ex:size 50 "),
            record("a2", "2026-01-02T00:00:00Z"),
            record("a3", "2026-01-03T00:00:00Z", "; ex:size 60 "),
        );
        const condition = conditionOn("ex:size", "GreaterThanOrEqualToRelation", "10", "integer");
        const client = replicateLDES(intoConfig({ url: ROOT, condition }));
        const errors: unknown[] = [];
        client.on("error", (error) => errors.push(error));
        const members: Member[] = [];
        await expect(async () => {
            for await (const member of client.stream()) members.push(member);
        }).rejects.toMatchObject({ type: "extract", memberId: { value: "http://example.org/a2" } });
        // The members before it have been emitted, the error ends the stream
        expect(ids(members)).toEqual(["a1"]);
        expect(errors).toHaveLength(1);
    });
});

describe("The after and before options in an LDES 2.0", () => {
    async function window(after?: string, before?: string) {
        const client = replicateLDES(
            intoConfig({ url: ROOT, after: after ? new Date(after) : undefined, before: before ? new Date(before) : undefined }),
        );
        const members: Member[] = [];
        for await (const member of client.stream({ highWaterMark: 10 })) members.push(member);
        return ids(members);
    }

    test("both bounds are exclusive, as in an LDES 1.0", async () => {
        server.trig(
            "/root",
            description,
            record("r1", "2026-01-01T00:00:00Z"),
            record("r2", "2026-01-02T00:00:00Z"),
            record("r3", "2026-01-03T00:00:00Z"),
        );
        expect(await window("2026-01-01T00:00:00Z")).toEqual(["r2", "r3"]);
        expect(await window(undefined, "2026-01-03T00:00:00Z")).toEqual(["r1", "r2"]);
        expect(await window("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z")).toEqual(["r2"]);
    });
});
