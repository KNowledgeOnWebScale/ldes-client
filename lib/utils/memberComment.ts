import type { Term } from "@rdfjs/types";
import type { LDESInfo, Member, OrderValue } from "../fetcher";

const term = (t: Term) => (t.termType === "NamedNode" ? `<${t.value}>` : t.termType === "BlankNode" ? `_:${t.value}` : t.value);

/** The value as it was written in the member, if its path is a plain predicate: that keeps its precision and timezone. */
function lexical(member: Member, path: Term | undefined): string | undefined {
    if (!path) return undefined;
    return member.quads.find((q) => q.subject.equals(member.id) && q.predicate.equals(path))?.object.value;
}

function orderValue(value: OrderValue, written: string | undefined): string {
    if (written !== undefined) return written;
    if (value instanceof Date) return value.toISOString();
    return typeof value === "object" ? value.value : String(value);
}

/**
 * What the LDES says about a member, as the lines of a comment: its number in the output, its IRI,
 * the timestamp and sequence it is ordered by, the entity it is a version of, its type and whether its transaction is finalized.
 * Everything that is not known is left out. Each line starts with `# `, which is a comment in TriG, N-Quads and Turtle.
 * @param number the number of the member in the output, starting from 1
 */
export function memberComment(
    member: Member,
    number: number,
    info?: Pick<LDESInfo, "timestampPath" | "sequencePath">,
): string {
    const lines = [`member ${number}: ${term(member.id)}`];
    if (member.timestamp !== undefined) {
        lines.push(`timestamp: ${orderValue(member.timestamp, lexical(member, info?.timestampPath))}`);
    }
    if (member.sequence !== undefined) {
        lines.push(`sequence: ${orderValue(member.sequence, lexical(member, info?.sequencePath))}`);
    }
    if (member.isVersionOf !== undefined) lines.push(`version of: ${member.isVersionOf}`);
    if (member.type !== undefined) lines.push(`type: ${term(member.type)}`);
    if (member.transactionFinalized !== undefined) lines.push(`transaction finalized: ${member.transactionFinalized}`);
    // Values may not break out of the comment
    return lines.map((line) => `# ${line.replace(/[\r\n]+/g, " ")}\n`).join("");
}
