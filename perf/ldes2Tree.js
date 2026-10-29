// A mock LDES 2.0 with the same pagination as the Tree of tests/helper.ts in perftest.js:
// every page has `memberCount` members, and `width` child pages, down to `depth` levels.
// The pages are RDF Message logs in TriG. The member number is the sequence: a page links to its children with
// the sequence interval of all the members below it, so that the order of the members is the same as in the tree.
const BASE = "http://myLdes2.com/";
const LDES = "https://w3id.org/ldes#";
const VALUE = "http://example.com/value";
const LABEL = "http://example.com/label";
const XSD_INT = "http://www.w3.org/2001/XMLSchema#integer";

export class Ldes2Tree {
    constructor() {
        // A page: { delay, members: [number], children: [{ page, from, until }] }
        this.pages = [{ members: [], children: [] }];
        this.memberCount = 0;
    }

    base() {
        return BASE;
    }

    root() {
        return 0;
    }

    /** Adds a page below a parent. The interval of the relation is set once the members below it are known. */
    build(depth, width, delay = 0, memberCount = 5) {
        this.pages[0].delay = delay;
        this.#subtree(depth, width, this.pages[0], delay, memberCount);
    }

    #subtree(depth, width, parent, delay, memberCount) {
        if (depth === 0) return;
        const page = { delay, members: [], children: [] };
        const id = this.pages.push(page) - 1;
        const from = this.memberCount;
        for (let i = 0; i < memberCount; i++) page.members.push(this.memberCount++);
        for (let i = 0; i < width; i++) this.#subtree(depth - 1, width, page, delay, memberCount);
        parent.children.push({ id, from, until: this.memberCount });
    }

    #page(index) {
        const page = this.pages[index];
        const url = BASE + index;
        let text = `VERSION "1.2-messages"\n`;
        // The description message: the LDES (in the root) and the relations
        const relations = page.children.map((c) =>
            `[ <${LDES}page> <${BASE + c.id}> ; <${LDES}sequenceFrom> ${c.from} ; <${LDES}sequenceUntil> ${c.until} ]`);
        const description = [];
        if (index === 0) description.push(`<${url}#ES> a <${LDES}EventStream> ; <${LDES}memberGraph> true ; <${LDES}sequencePath> <${VALUE}> .`);
        if (relations.length) description.push(`<${url}> <${LDES}relation> ${relations.join(" , ")} .`);
        const messages = [];
        if (description.length) messages.push(description.join("\n"));
        for (const n of page.members) {
            const id = `http://example.com/member-${n}`;
            messages.push(`<${id}> <${VALUE}> "${n}"^^<${XSD_INT}> .\n<${id}> { <${id}> <${LABEL}> "member ${n}" . }`);
        }
        return text + messages.join("\nMESSAGE\n");
    }

    mock() {
        return async (req) => {
            const url = req.toString();
            if (!url.startsWith(BASE)) return new Response("", { status: 404 });
            const index = parseInt(url.substring(BASE.length));
            const page = this.pages[index];
            if (!page) return new Response("", { status: 404 });
            if (page.delay) await new Promise((res) => setTimeout(res, page.delay));
            return new Response(this.#page(index), { headers: { "content-type": "application/trig" } });
        };
    }
}
