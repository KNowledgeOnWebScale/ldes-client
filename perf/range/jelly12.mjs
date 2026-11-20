/**
 * Can Jelly 1.2 (rdfjs-jelly, protocol version 3, column batches) be published by appending, and continued with HTTP
 * Range requests? And what does appending cost in size?
 *
 * A publisher that appends writes the members of one publication and calls flush(): one column batch per publication.
 * Variants (all with one message per member, streaming writer, so every publication only appends bytes):
 * - Jelly 1.2, packed: batches of the default size, without flushing per publication (reference: how compact 1.2 can be)
 * - Jelly 1.2, appended: flush per publication, lookup tables shared across batches (the default)
 * - Jelly 1.2, appended, self-contained: flush per publication, `persistentLookups: false` (every batch on its own)
 * compared with TriG and the resumable Jelly 1.1 of perf/range/jelly11.mjs.
 *
 * Resuming: the stream is cut at the end of a publication, and `preamble + the rest` is parsed. The preamble is a stream
 * with the same options and no messages (only its options frame). It has to give exactly the messages of the rest.
 *
 *   node perf/range/jelly12.mjs [--members 10000]
 */
import { gzipSync } from "zlib";
import { Parser as N3Parser } from "n3";
import { Parser, RdfStreamType, Writer, toMessages } from "rdfjs-jelly";
import { member } from "../lib/fixtures.mjs";
import { ResumableJellyWriter } from "./jelly11.mjs";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) : fallback);
const members = arg("members", 10_000);
const prefixes = `PREFIX ldes: <https://w3id.org/ldes#>\nPREFIX ex: <http://example.org/>\nPREFIX dcterms: <http://purl.org/dc/terms/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;
const description = "ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .";
const quads = (text, i) => new N3Parser({ blankNodePrefix: `b${i}_` }).parse(`${prefixes}\n${text}`);
const messages = [quads(description, -1), ...Array.from({ length: members }, (_, i) => quads(member(i), i))];

/** The publications: the description and the first `k` members, then `k` members at a time */
const publications = (k) => {
    const out = [[0]];
    for (let from = 1; from <= members; from += k) out.push(Array.from({ length: Math.min(k, members + 1 - from) }, (_, j) => from + j));
    return out;
};

/** Writes the messages with a streaming writer: the bytes that every publication appends */
function jelly12(k, options, flushPerPublication = true) {
    const chunks = [];
    let current = [];
    const writer = new Writer(
        {
            write(bytes, done) {
                current.push(Buffer.from(bytes));
                done?.();
            },
            end(done) {
                done?.();
            },
        },
        { version: 3, streamType: RdfStreamType.MESSAGES, ...options },
    );
    for (const publication of publications(k)) {
        for (const index of publication) writer.addMessage(messages[index]);
        if (flushPerPublication) writer.flush();
        chunks.push(Buffer.concat(current));
        current = [];
    }
    writer.end();
    if (current.length) chunks.push(Buffer.concat(current));
    return chunks;
}

/** The options frame of a stream with these options, without messages */
function preamble(options) {
    const out = [];
    const writer = new Writer(
        {
            write: (bytes, done) => (out.push(Buffer.from(bytes)), done?.()),
            end: (done) => done?.(),
        },
        { version: 3, streamType: RdfStreamType.MESSAGES, ...options },
    );
    writer.end();
    return Buffer.concat(out);
}

const canonical = (message) =>
    message
        .map((q) =>
            [q.subject, q.predicate, q.object, q.graph]
                .map((t) => (t.termType === "BlankNode" ? "_:b" : `${t.termType}|${t.value}|${t.language ?? ""}|${t.datatype?.value ?? ""}`))
                .join(" "),
        )
        .sort()
        .join("\n");

function parseMessages(bytes) {
    const output = new Parser({ messages: true }).parse(bytes);
    return toMessages(output).filter((message) => message.length > 0);
}

// A minimal protobuf reader/writer, to rewrite frames without decoding their statements
function varint(buffer, pos) {
    let value = 0;
    let multiplier = 1;
    for (let i = pos; i < buffer.length; i++) {
        value += (buffer[i] & 0x7f) * multiplier;
        multiplier *= 128;
        if ((buffer[i] & 0x80) === 0) return { value, next: i + 1 };
    }
    throw new Error("Truncated varint");
}
function encodeVarint(n) {
    const bytes = [];
    while (n >= 0x80) {
        bytes.push((n % 128) | 0x80);
        n = Math.floor(n / 128);
    }
    bytes.push(n);
    return Buffer.from(bytes);
}
function* fields(buffer) {
    let pos = 0;
    while (pos < buffer.length) {
        const tag = varint(buffer, pos);
        const start = pos;
        const number = Math.floor(tag.value / 8);
        const wire = tag.value & 7;
        pos = tag.next;
        if (wire === 0) pos = varint(buffer, pos).next;
        else if (wire === 2) {
            const length = varint(buffer, pos);
            pos = length.next + length.value;
        } else if (wire === 1) pos += 8;
        else if (wire === 5) pos += 4;
        else throw new Error(`wire type ${wire}`);
        yield {
            number,
            wire,
            raw: buffer.subarray(start, pos),
            payload: wire === 2 ? buffer.subarray(varint(buffer, tag.next).next, pos) : undefined,
        };
    }
}
function* frames(stream) {
    let pos = 0;
    while (pos < stream.length) {
        const length = varint(stream, pos);
        yield stream.subarray(length.next, length.next + length.value);
        pos = length.next + length.value;
    }
}
const delimit = (frame) => Buffer.concat([encodeVarint(frame.length), frame]);
const lengthField = (number, payload) => Buffer.concat([encodeVarint(number * 8 + 2), encodeVarint(payload.length), payload]);

/**
 * A preamble that replays the lookup entries of every batch that was read, without its statements: each batch becomes
 * a batch with only its name, prefix and datatype entries (fields 2, 3, 4 of RdfColumnBatch), and the options rows are kept.
 */
function replayPreamble(stream) {
    const out = [];
    for (const frame of frames(stream)) {
        const kept = [];
        for (const field of fields(frame)) {
            if (field.number === 1) kept.push(field.raw); // rows: the stream options
            if (field.number === 2) {
                const entries = [...fields(field.payload)].filter((f) => f.number >= 2 && f.number <= 4).map((f) => f.raw);
                if (entries.length) kept.push(lengthField(2, Buffer.concat(entries)));
            }
        }
        if (kept.length) out.push(delimit(Buffer.concat(kept)));
    }
    return Buffer.concat(out);
}

/**
 * The same state in one frame: the options rows, and one batch with the current contents of the name, prefix and datatype
 * tables (fields 2, 3, 4), as runs of consecutive identifiers. The entry that was assigned last comes last in its table,
 * so that an entry with identifier 0 (the one after the last) means the same afterwards. Its size is bounded by the tables.
 */
function compactPreamble(stream) {
    let options;
    const tables = new Map([2, 3, 4].map((n) => [n, { values: new Map(), last: 0 }]));
    for (const frame of frames(stream)) {
        for (const field of fields(frame)) {
            if (field.number === 1) options ??= field.raw;
            if (field.number !== 2) continue;
            for (const entry of fields(field.payload)) {
                const table = tables.get(entry.number);
                if (!table) continue;
                let id = 0;
                const values = [];
                for (const part of fields(entry.payload)) {
                    if (part.number === 1) id = varint(part.raw, 1).value;
                    if (part.number === 2) values.push(part.payload.toString("utf8"));
                }
                values.forEach((value, j) => {
                    const index = j === 0 && id !== 0 ? id : table.last + 1;
                    table.values.set(index, value);
                    table.last = index;
                });
            }
        }
    }
    const entry = (id, values) =>
        Buffer.concat([Buffer.concat([encodeVarint(8), encodeVarint(id)]), ...values.map((v) => lengthField(2, Buffer.from(v, "utf8")))]);
    const batch = [];
    for (const [number, table] of tables) {
        const ids = [...table.values.keys()].filter((id) => id !== table.last).sort((a, b) => a - b);
        // runs of consecutive identifiers
        for (let i = 0; i < ids.length;) {
            let j = i;
            while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
            batch.push(
                lengthField(
                    number,
                    entry(
                        ids[i],
                        ids.slice(i, j + 1).map((id) => table.values.get(id)),
                    ),
                ),
            );
            i = j + 1;
        }
        if (table.values.has(table.last)) batch.push(lengthField(number, entry(table.last, [table.values.get(table.last)])));
    }
    return delimit(Buffer.concat([options, lengthField(2, Buffer.concat(batch))]));
}

/**
 * Cuts the stream after publication `p` and parses `preamble + rest`. Returns whether that gives exactly the messages of
 * the later publications, or the error.
 */
function resume(chunks, pre, k, p) {
    const rest = Buffer.concat(chunks.slice(p + 1));
    const expected = publications(k)
        .slice(p + 1)
        .flat()
        .map((i) => canonical(messages[i]));
    try {
        const got = parseMessages(Buffer.concat([pre, rest])).map(canonical);
        if (got.length !== expected.length) return `${got.length} messages instead of ${expected.length}`;
        const wrong = got.findIndex((message, i) => message !== expected[i]);
        return wrong === -1 ? "ok" : `message ${wrong} differs`;
    } catch (error) {
        return `error: ${String(error.message ?? error).slice(0, 80)}`;
    }
}

const kb = (bytes) => +(bytes / 1024).toFixed(0);
const sizes = (chunks) => {
    const body = Buffer.concat(chunks);
    // what a client downloads per publication with Range, after the initial one (and the overlap of 32 bytes)
    const later = chunks.slice(2);
    return {
        KB: kb(body.length),
        "gzip KB": kb(gzipSync(body).length),
        "gzip members KB": kb(Buffer.concat(chunks.map((c) => gzipSync(c))).length),
        "bytes/publication": +(later.reduce((sum, c) => sum + c.length, 0) / Math.max(1, later.length)).toFixed(0),
    };
};

console.log(`${members} members, one message per member\n`);
for (const k of [1, 10, 100, 1000]) {
    const trig = publications(k).map((publication) =>
        Buffer.from(
            publication.map((i) => (i === 0 ? `VERSION "1.2-messages"\n${prefixes}\n${description}\n` : `MESSAGE\n${member(i - 1)}\n`)).join(""),
        ),
    );
    const resumable = new ResumableJellyWriter();
    const jelly11 = publications(k).map((publication) => Buffer.concat(publication.map((i) => resumable.frame(messages[i]))));
    const packed = jelly12(k, {}, false);
    const appended = jelly12(k, {});
    const selfContained = jelly12(k, { persistentLookups: false });

    // Every variant must read back as the same messages
    for (const [name, chunks] of [
        ["appended", appended],
        ["self-contained", selfContained],
        ["packed", packed],
    ]) {
        const got = parseMessages(Buffer.concat(chunks));
        if (got.length !== messages.length) console.log(`  ${name}: ${got.length} messages read back, expected ${messages.length}`);
    }

    console.log(`--- ${k} member(s) per publication`);
    console.table({
        TriG: sizes(trig),
        "Jelly 1.1, frames independent": sizes(jelly11),
        "Jelly 1.2, packed (not per publication)": { ...sizes([Buffer.concat(packed)]), "bytes/publication": "-" },
        "Jelly 1.2, appended (shared lookups)": sizes(appended),
        "Jelly 1.2, appended, self-contained": sizes(selfContained),
    });
    const cut = Math.floor(publications(k).length / 2);
    console.log(
        `  resume after publication ${cut} with an options-only preamble:` +
            ` shared lookups → ${resume(appended, preamble({}), k, cut)};` +
            ` self-contained → ${resume(selfContained, preamble({ persistentLookups: false }), k, cut)}`,
    );
    // Shared lookups, with a preamble that replays the lookup entries of the batches before the cut
    const replay = replayPreamble(Buffer.concat(appended.slice(0, cut + 1)));
    const results = [1, Math.floor(cut / 2), cut, publications(k).length - 2].map((p) => {
        const pre = replayPreamble(Buffer.concat(appended.slice(0, p + 1)));
        return `after ${p}: ${resume(appended, pre, k, p)} (preamble ${kb(pre.length)} KB)`;
    });
    console.log(`  shared lookups, replaying the lookup entries (${kb(replay.length)} KB at the middle): ${results.join("; ")}`);
    const compact = [1, Math.floor(cut / 2), cut, publications(k).length - 2].map((p) => {
        const pre = compactPreamble(Buffer.concat(appended.slice(0, p + 1)));
        return `after ${p}: ${resume(appended, pre, k, p)} (preamble ${kb(pre.length)} KB)`;
    });
    console.log(`  shared lookups, compacted lookup tables: ${compact.join("; ")}\n`);
}
