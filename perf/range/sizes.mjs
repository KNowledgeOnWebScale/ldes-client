/**
 * The size of the same LDES (one page, the description and `--members` members) in the serializations that are compared,
 * uncompressed, as one gzip stream, and as gzip members (one member per `--append` members).
 * Jelly is written by rdfjs-jelly in two ways: as a whole (the most compact), and appended, with a flush per publication
 * (what a page with range requests needs). It also tells how large the decoder state is that a client keeps (as JSON).
 *
 *   node perf/range/sizes.mjs --members 10000 --append 10
 */
import { gzipSync } from "zlib";
import { Parser } from "n3";
import { Parser as JellyParser, RdfStreamType, Writer } from "rdfjs-jelly";
import { member } from "../lib/fixtures.mjs";

const arg = (name, fallback) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1] || fallback);
const members = arg("members", 10_000);
const append = arg("append", 10);
const prefixes = `PREFIX ldes: <https://w3id.org/ldes#>\nPREFIX ex: <http://example.org/>\nPREFIX dcterms: <http://purl.org/dc/terms/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;
const description = "ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .";
const quads = (text, i) => new Parser({ blankNodePrefix: `b${i}_` }).parse(`${prefixes}\n${text}`);
const messages = [quads(description, -1), ...Array.from({ length: members }, (_, i) => quads(member(i), i))];

// Every serialization as a list of chunks: chunk k holds what is published at once (the first also the description)
const groups = [];
for (let from = 0; from < members; from += append) groups.push(Array.from({ length: Math.min(append, members - from) }, (_, k) => from + k));

const trig = groups.map((group, g) =>
    Buffer.from((g === 0 ? `VERSION "1.2-messages"\n${prefixes}\n${description}\n` : "") + group.map((i) => `MESSAGE\n${member(i)}\n`).join("")),
);

/** Jelly as one stream, with the default frames or batches */
async function whole(version) {
    const writer = new Writer({ version, streamType: RdfStreamType.MESSAGES });
    for (const message of messages) writer.addMessage(message);
    return new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes)))));
}

/** Jelly appended by a streaming writer, flushed after every publication: the bytes that each publication appends */
function appended(version) {
    const chunks = [];
    let current = [];
    const writer = new Writer(
        { write: (bytes, done) => (current.push(Buffer.from(bytes)), done?.()), end: (done) => done?.() },
        { version, streamType: RdfStreamType.MESSAGES },
    );
    groups.forEach((group, g) => {
        if (g === 0) writer.addMessage(messages[0]);
        for (const i of group) writer.addMessage(messages[i + 1]);
        writer.flush();
        chunks.push(Buffer.concat(current));
        current = [];
    });
    return chunks;
}

/** The size of the decoder state after the whole stream, as the client stores it (JSON) */
const stateSize = (bytes) => {
    const parser = new JellyParser({ messages: true });
    parser.parse(bytes);
    return JSON.stringify(parser.getState()).length;
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
const jelly11 = appended(2);
const jelly12 = appended(3);
console.log(`${members} members, ${append} per publication`);
console.table([
    row("TriG", trig, { appendable: true }),
    row("Jelly 1.1, appended", jelly11, { appendable: true }),
    row("Jelly 1.1, whole", [await whole(2)], { appendable: false }),
    row("Jelly 1.2, appended", jelly12, { appendable: true }),
    row("Jelly 1.2, whole", [await whole(3)], { appendable: false }),
]);
console.log(
    `Decoder state (JSON) after the appended stream: Jelly 1.1 ${stateSize(Buffer.concat(jelly11))} bytes; Jelly 1.2 ${stateSize(Buffer.concat(jelly12))} bytes`,
);
