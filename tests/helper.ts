import { Writer } from "n3";
import { TREE } from "@treecg/types";
import { parseQuads } from "../lib/utils";

import type { Quad } from "@rdfjs/types";
import type { Member } from "../lib/fetcher";

export type FragmentId = number;

const BASE = "http://myTree.com/";

type Relation = {
    node: string;
    type: string;
    path?: string;
    value?: string;
};

function relationToQuads(rel: Relation): Quad[] {
    const path = rel.path ? ` tree:path <${rel.path}>;` : "";
    const value = rel.value ? ` tree:value "${rel.value}";` : "";
    const string = `
@prefix tree: <https://w3id.org/tree#>.

<> tree:relation [
  a <${rel.type}>;
  tree:node <${rel.node}>;
  ${path}
  ${value}
].
`;
    return parseQuads(string);
}

export async function read(stream: ReadableStream<Member>): Promise<Member[]> {
    try {
        const out: Member[] = [];
        const reader = stream.getReader();

        let el = await reader.read();
        while (el) {
            if (el.done || !el.value) break;
            out.push(el.value);
            el = await reader.read();
        }

        return out;
    } catch (ex) {
        console.log("expect", ex);
        throw ex;
    }
}

export class Fragment<T> {
    private members: { member: T; id: string }[] = [];
    private relations: Relation[] = [];

    private failCount = 0;
    delay?: number;

    constructor(delay?: number) {
        this.delay = delay;
    }

    toQuads(
        ldesId: string,
        memberToQuads: (id: string, member: T) => Quad[],
    ): Quad[] {
        if (this.failCount > 0) {
            this.failCount -= 1;
            throw "I'm failing, oh no";
        }

        const out: Quad[] = [];
        for (const rel of this.relations) {
            out.push(...relationToQuads(rel));
        }

        for (const { id, member } of this.members) {
            out.push(
                ...parseQuads(`<${ldesId}> <${TREE.member}> <${id}>.`),
            );
            out.push(...memberToQuads(id, member));
        }

        return out;
    }

    setFailcount(count: number): typeof this {
        this.failCount = count;
        return this;
    }

    addMember(id: string, member: T): typeof this {
        this.members.push({ member, id });
        return this;
    }

    relation(target: FragmentId, type: string, path?: string, value?: string) {
        this.relations.push({
            type,
            value,
            path,
            node: BASE + target,
        });
    }
}

export class Tree<T> {
    private fragments: Fragment<T>[] = [];
    private memberToQuads: (id: string, member: T) => Quad[];
    private timestampPath?: string;

    fetched: Set<string> = new Set();

    constructor(
        memberToQuads: (id: string, member: T) => Quad[],
        timestampPath?: string,
    ) {
        this.timestampPath = timestampPath;
        this.memberToQuads = memberToQuads;
        this.fragments.push(new Fragment());
    }

    base(): string {
        return BASE;
    }

    root(): FragmentId {
        return 0;
    }

    newFragment(delay?: number): FragmentId {
        this.fragments.push(new Fragment(delay));
        return this.fragments.length - 1;
    }

    fragment(id: number): Fragment<T> {
        return this.fragments[id];
    }

    mock(): typeof fetch {
        const fetch_f: typeof fetch = async (
            req: Parameters<typeof fetch>[0],
            _opts: Parameters<typeof fetch>[1],
        ) => {
            if (!req.toString().startsWith(BASE)) {
                return new Response("", { status: 404 });
            }

            this.fetched.add(req.toString().slice(BASE.length));

            const quads: Quad[] = [];

            if (req.toString() === BASE + this.root()) {
                const path = this.timestampPath
                    ? ` <https://w3id.org/ldes#timestampPath> <${this.timestampPath}>;`
                    : "";

                quads.push(
                    ...parseQuads(`
<> ${path}
  <https://w3id.org/tree#view> <>.
`),
                );
            }

            const index = parseInt(req.toString().substring(BASE.length));
            const fragment = this.fragments[index];
            if (fragment.delay) {
                await new Promise((res) => setTimeout(res, fragment.delay));
            }
            try {
                quads.push(
                    ...fragment.toQuads(BASE + this.root(), this.memberToQuads),
                );

                const respText = new Writer().quadsToString(quads);

                const resp = new Response(respText, {
                    headers: { "content-type": "text/turtle" },
                });

                return resp;
            } catch (ex) {
                console.error(ex);
                const resp = new Response("I'm too loaded yo", { status: 429 });
                return resp;
            }
        };
        return fetch_f;
    }
}
