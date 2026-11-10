const time = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
export const member = (i) =>
    `ex:m${i} a ex:Record ; dcterms:created "${time(i)}"^^xsd:dateTime ; ex:a "v${i}" ; ex:b ${i} ; ` +
    `ex:c [ ex:d "x${i}" ; ex:e ex:o${i % 50} ] ; ex:f "text text text ${i}" .`;
const PREFIXES = {
    ldes: "https://w3id.org/ldes#",
    tree: "https://w3id.org/tree#",
    ex: "http://example.org/",
    dcterms: "http://purl.org/dc/terms/",
    xsd: "http://www.w3.org/2001/XMLSchema#",
};
export const turtlePrefixes =
    Object.entries(PREFIXES)
        .map(([k, v]) => `@prefix ${k}: <${v}> .`)
        .join("\n") + "\n";
const trigPrefixes =
    Object.entries(PREFIXES)
        .map(([k, v]) => `PREFIX ${k}: <${v}>`)
        .join("\n") + "\n";
const ranges = (members, size) => Array.from({ length: Math.ceil(members / size) }, (_, p) => [p * size, Math.min(members, (p + 1) * size)]);

export async function createFixtures(BASE) {
    const pages = new Map();
    /** LDES 1.0: a collection with a view; the members are in the pages the view relates to, or in the view itself */
    function ldes1(name, members, size) {
        const root = `${BASE}/${name}/root`;
        const collection = `${BASE}/${name}/collection`;
        const list = (from, to) =>
            `<${collection}> tree:member ${Array.from({ length: to - from }, (_, k) => `ex:m${from + k}`).join(", ")} .\n` +
            Array.from({ length: to - from }, (_, k) => member(from + k)).join("\n") +
            "\n";
        const head = `<${collection}> a ldes:EventStream ; ldes:timestampPath dcterms:created ; tree:view <${root}> .\n<${root}> a tree:Node .\n`;
        if (size >= members) {
            pages.set(`/${name}/root`, turtlePrefixes + head + list(0, members));
        } else {
            const parts = ranges(members, size);
            pages.set(
                `/${name}/root`,
                turtlePrefixes +
                    head +
                    parts
                        .map(
                            ([from], p) =>
                                `<${root}> tree:relation [ a tree:GreaterThanOrEqualToRelation ; tree:node <${BASE}/${name}/page${p}> ; tree:path dcterms:created ; tree:value "${time(from)}"^^xsd:dateTime ] .`,
                        )
                        .join("\n") +
                    "\n",
            );
            parts.forEach(([from, to], p) =>
                pages.set(`/${name}/page${p}`, turtlePrefixes + `<${BASE}/${name}/page${p}> a tree:Node .\n` + list(from, to)),
            );
        }
        return root;
    }

    /** LDES 2.0: the same members, one message per member */
    function ldes2(name, members, size) {
        const root = `${BASE}/${name}/root`;
        const messages = (from, to) => Array.from({ length: to - from }, (_, k) => "MESSAGE\n" + member(from + k)).join("\n") + "\n";
        const description = `ex:ES a ldes:EventStream ; ldes:timestampPath dcterms:created ; ldes:memberType ex:Record .\n`;
        const body = (text) => `VERSION "1.2-messages"\n${trigPrefixes}${text}`;
        if (size >= members) {
            pages.set(`/${name}/root`, {
                type: "application/trig",
                body: body(description + messages(0, members)),
            });
        } else {
            const parts = ranges(members, size);
            pages.set(`/${name}/root`, {
                type: "application/trig",
                body: body(
                    description +
                        `<> ldes:relation ${parts
                            .map(
                                ([from, to], p) =>
                                    `[ ldes:page <${BASE}/${name}/page${p}> ; ldes:timeFrom "${time(from)}"^^xsd:dateTime ; ldes:timeUntil "${time(to)}"^^xsd:dateTime ]`,
                            )
                            .join(" , ")} .\n`.replaceAll("<>", `<${root}>`),
                ),
            });
            parts.forEach(([from, to], p) =>
                pages.set(`/${name}/page${p}`, {
                    type: "application/trig",
                    body: body(messages(from, to).replace(/^MESSAGE\n/, "")),
                }),
            );
        }
        return root;
    }

    // Encode the exact TriG message quads as Jelly frames, one frame per message.
    async function jelly(name, members, size) {
        const { parseMessages } = await import("n3.js-messages");
        const { Writer } = await import("rdfjs-jelly");
        const url = ldes2(name, members, size);
        for (const [key, page] of pages) {
            if (!key.startsWith(`/${name}/`)) continue;
            const writer = new Writer({ packMessages: false });
            for (const message of parseMessages(page.body)) writer.addMessage(message);
            const body = await new Promise((resolve, reject) => writer.end((error, bytes) => (error ? reject(error) : resolve(Buffer.from(bytes)))));
            pages.set(key, { type: "application/x-jelly-rdf", body });
        }
        return url;
    }

    return { pages, ldes1, trig: ldes2, jelly };
}
