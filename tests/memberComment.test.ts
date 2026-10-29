import { describe, expect, test } from "vitest";
import { DataFactory } from "n3";
import { MessageWriter, parseMessages } from "n3.js-messages";
import { memberComment } from "../lib/utils";

import type { Member } from "../lib/fetcher";

const { namedNode, literal, quad } = DataFactory;
const ex = (name: string) => namedNode(`http://example.org/${name}`);
const created = ex("created");
const xsdDateTime = namedNode("http://www.w3.org/2001/XMLSchema#dateTime");

function member(extra: Partial<Member> = {}): Member {
    return {
        id: ex("m1"),
        quads: [quad(ex("m1"), created, literal("2026-01-01T10:00:00.123456", xsdDateTime))],
        ...extra,
    };
}

describe("memberComment", () => {
    test("a member without information on LDES level only has its number and IRI", () => {
        expect(memberComment(member(), 1)).toBe("# member 1: <http://example.org/m1>\n");
    });

    test("it adds the timestamp as written in the member, the sequence, the version, the type and the transaction", () => {
        const comment = memberComment(
            member({
                timestamp: new Date("2026-01-01T10:00:00.123Z"),
                sequence: { type: "numeric", value: "42" },
                isVersionOf: "http://example.org/entity",
                type: ex("Record"),
                transactionFinalized: false,
            }),
            7,
            { timestampPath: created },
        );
        expect(comment).toBe(
            [
                "# member 7: <http://example.org/m1>",
                "# timestamp: 2026-01-01T10:00:00.123456",
                "# sequence: 42",
                "# version of: http://example.org/entity",
                "# type: <http://example.org/Record>",
                "# transaction finalized: false",
                "",
            ].join("\n"),
        );
    });

    test("without a plain timestamp path, the timestamp is the instant of the member", () => {
        expect(memberComment(member({ timestamp: new Date("2026-01-01T10:00:00Z") }), 2)).toContain(
            "# timestamp: 2026-01-01T10:00:00.000Z\n",
        );
    });

    test("a value cannot break out of the comment", () => {
        expect(memberComment(member({ isVersionOf: "a\nb" }), 1)).toContain("# version of: a b\n");
    });

    test("comments between the messages of a log do not change the messages", async () => {
        const members = [member(), member({ id: ex("m2"), quads: [quad(ex("m2"), created, literal("x"))] })];
        const writer = new MessageWriter({ format: "TriG" });
        let log = "";
        for (const [i, m] of members.entries()) {
            await writer.addMessage(m.quads);
            log += memberComment(m, i + 1);
        }
        // Comments, placed after the delimiters, are ignored by the parser
        const text = ((await writer.end()) as string).replaceAll("@message .\n", (d) => d + "# a comment\n");
        expect(parseMessages(text).map((m) => m.length)).toEqual([1, 1]);
        expect(log.split("\n").filter((l) => l.startsWith("# member"))).toHaveLength(2);
    });
});
