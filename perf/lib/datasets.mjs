// Datasets for the layout benchmark. Each dataset describes its members in a format-independent way:
//   count, id(i), time(i) (ISO text, ascending), snippet(i) (the member as TriG), and expected(i) = [quadCount, digest].
// Members are ascending in time, as LDES 2.0 requires of every page.
import { readFileSync } from "node:fs";
import { Parser, Store, Writer, DataFactory } from "n3";
import { member as syntheticMember, turtlePrefixes } from "./fixtures.mjs";
import { digest } from "./canonical.mjs";

const time = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const PREFIX_LINES = turtlePrefixes.trim().split("\n");

/**
 * @typedef {object} Dataset
 * @property {string} name
 * @property {number} count
 * @property {"default" | "graph"} kind  `graph`: the member is a named graph (ldes:memberGraph)
 * @property {string} timestampPath IRI
 * @property {string} membership  LDES 2.0 description statements that tell how to find the member identifier (about ex:ES)
 * @property {(i: number) => string} id
 * @property {(i: number) => string} time
 * @property {(i: number) => string} snippet
 * @property {(i: number) => [number, string]} expected
 */

export function synthetic(count) {
    const parser = new Parser({ format: "text/turtle" });
    return {
        name: "synthetic (8 triples)",
        count,
        kind: "default",
        timestampPath: "http://purl.org/dc/terms/created",
        membership: "ldes:memberType ex:Record",
        id: (i) => `http://example.org/m${i}`,
        time,
        snippet: (i) => syntheticMember(i),
        expected: (i) => {
            const quads = parser.parse(turtlePrefixes + syntheticMember(i));
            return [quads.length, digest(quads)];
        },
    };
}

/** Real data, snapshotted by snapshot-datasets.mjs: every member is a block of N-Quads */
export function snapshot(file, count, { kind, membership, shapeFile }) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const members = data.members.slice(0, count);
    if (members.length < count) throw new Error(`${file} has only ${members.length} members`);
    const quadsOf = (i) => new Parser({ format: "N-Quads", blankNodePrefix: "" }).parse(members[i].nq);
    return {
        name: data.name,
        count,
        kind,
        timestampPath: data.timestampPath,
        membership,
        collectionExtra: shapeFile ? (collection) => publishedShape(shapeFile, collection) : undefined,
        id: (i) => members[i].id,
        time: (i) => members[i].time,
        snippet: (i) => {
            const writer = new Writer({ format: "application/trig" });
            writer.addQuads(quadsOf(i));
            let out;
            writer.end((error, text) => {
                if (error) throw error;
                out = text;
            });
            return out;
        },
        expected: (i) => {
            const quads = quadsOf(i);
            return [quads.length, digest(quads)];
        },
    };
}

/**
 * The tree:shape of the real feed (with everything below it), re-attached to our collection:
 * LDES 1.0 needs it to extract members that reach beyond the member IRI (geometries, blank nodes).
 */
function publishedShape(file, collection) {
    const { namedNode, quad } = DataFactory;
    const store = new Store(new Parser({ format: "text/turtle" }).parse(readFileSync(file, "utf8")));
    const shape = store.getQuads(null, namedNode("https://w3id.org/tree#shape"), null, null)[0];
    if (!shape) throw new Error(`No tree:shape in ${file}`);
    const out = [quad(namedNode(collection), shape.predicate, shape.object)];
    const todo = [shape.object];
    const seen = new Set();
    while (todo.length) {
        const node = todo.pop();
        if (node.termType !== "BlankNode" || seen.has(node.value)) continue;
        seen.add(node.value);
        for (const q of store.getQuads(node, null, null, null)) {
            out.push(q);
            todo.push(q.object);
        }
        // RDF lists and nested shapes are reachable through objects only
    }
    const writer = new Writer({ format: "text/turtle" });
    writer.addQuads(out);
    let text;
    writer.end((error, result) => {
        if (error) throw error;
        text = result;
    });
    return text + "\n";
}

export { PREFIX_LINES };
