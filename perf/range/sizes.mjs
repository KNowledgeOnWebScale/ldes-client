/**
 * The size of the same LDES (one page, the description and `--members` members) in the serializations that are compared,
 * uncompressed, as one gzip stream, and as gzip members (one member per `--append` members).
 * It also tells what the rule of perf/range/jelly11.mjs costs (no terms repeated across frames), compared with the
 * Jelly 1.1 writer of rdfjs-jelly, and how large the preamble is that a client keeps for each.
 *
 *   node perf/range/sizes.mjs --members 10000 --append 10
 */
import { gzipSync } from "zlib";
import { Parser } from "n3";
import { RdfStreamType, Writer } from "rdfjs-jelly";
import { member } from "../lib/fixtures.mjs";
import { ResumableJellyWriter } from "./jelly11.mjs";
import { JellyScanner } from "../../dist/lib/fetcher/resume.js";

const arg = (name, fallback) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1] || fallback);
const members = arg("members", 10_000);
const append = arg("append", 10);
const prefixes = `PREFIX ldes: <https://w3id.org/ldes#>\nPREFIX ex: <http://example.org/>\nPREFIX dcterms: <http://purl.org/dc/terms/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;
const description = "ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .";
const quads = (text, i) => new Parser({ blankNodePrefix: `b${i}_` }).parse(`${prefixes}\n${text}`);

// Every serialization as a list of chunks: chunk k holds what is published at once (the first also the description)
const groups = [];
for (let from = 0; from < members; from += append) groups.push(Array.from({ length: Math.min(append, members - from) }, (_, k) => from + k));

const trig = groups.map((group, g) =>
    Buffer.from((g === 0 ? `VERSION "1.2-messages"\n${prefixes}\n${description}\n` : "") + group.map((i) => `MESSAGE\n${member(i)}\n`).join("")),
);

const resumable = new ResumableJellyWriter();
const jelly11r = groups.map((group, g) =>
    Buffer.concat([...(g === 0 ? [resumable.frame(quads(description, -1))] : []), ...group.map((i) => resumable.frame(quads(member(i), i)))]),
);

async function whole(options) {
    const writer = new Writer({ packMessages: false, ...options });
    writer.addMessage(quads(description, -1));
    for (let i = 0; i < members; i++) writer.addMessage(quads(member(i), i));
    return new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes)))));
}
const jelly11 = await whole({});
const jelly12 = await whole({ version: 3, streamType: RdfStreamType.MESSAGES });

const preamble = (bytes) => {
    const scanner = new JellyScanner();
    scanner.push(bytes);
    return scanner.preamble()?.length;
};

const row = (name, chunks, { appendable }) => {
    const body = Buffer.concat(chunks);
    return {
        serialization: name,
        KB: +(body.length / 1024).toFixed(0),
        "gzip KB": +(gzipSync(body).length / 1024).toFixed(0),
        "gzip members KB": appendable ? +(Buffer.concat(chunks.map((c) => gzipSync(c))).length / 1024).toFixed(0) : "-",
        "bytes/member": +(body.length / members).toFixed(0),
    };
};
console.log(`${members} members, ${append} per publication`);
console.table([
    row("TriG", trig, { appendable: true }),
    row("Jelly 1.1, frames independent (resumable)", jelly11r, { appendable: true }),
    row("Jelly 1.1, rdfjs-jelly", [jelly11], { appendable: false }),
    row("Jelly 1.2, rdfjs-jelly", [jelly12], { appendable: false }),
]);
console.log(`Preamble of the resumable Jelly 1.1 stream: ${preamble(Buffer.concat(jelly11r))} bytes; of rdfjs-jelly 1.1: ${preamble(jelly11)} bytes`);
