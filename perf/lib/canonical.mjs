// Canonical form of the quads of a member, to verify that every format delivers exactly the same data.
// Blank nodes are collapsed to one label: this checks the content, not the labels.
import { createHash } from "node:crypto";

const termKey = (t) => {
    switch (t.termType) {
        case "NamedNode":
            return `<${t.value}>`;
        case "BlankNode":
            return "_:b";
        case "DefaultGraph":
            return "";
        default:
            return JSON.stringify(["L", t.value, t.language || "", t.datatype?.value || ""]);
    }
};

export const canonical = (quads) =>
    quads
        .map((q) => [q.subject, q.predicate, q.object, q.graph].map(termKey).join(" "))
        .sort()
        .join("\n");

export const digest = (quads) => createHash("sha1").update(canonical(quads)).digest("hex");
