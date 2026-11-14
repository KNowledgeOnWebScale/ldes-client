import { createHash } from "node:crypto";
import type { Ordered } from "../../lib/client";
import type { FeedServer, Route } from "./feedServer";

/**
 * Mock feeds that have the shape of LDESs that are published today. Every feed is a model of what a real server
 * sends, as it was observed on 14 November 2026, not of what the specification allows:
 *
 *  - marine:   Marine Regions (https://www.marineregions.org/feed): Turtle, hourly pages that are linked backwards in time
 *              from a head page, and an entry point that is a chain of redirects to the page of the current hour.
 *  - rijks:    the Rijksmuseum (https://data.rijksmuseum.nl/ldes/collection.json): JSON-LD, year > month > day, long days
 *              are paged with a pageToken. A member is an Activity Streams activity that points to the data.
 *  - mint:     MINT (https://mint-ldes.ails.ece.ntua.gr/euscreenxl/1008/ldes): TriG, year > month > day > ?page=N, only
 *              for the periods that have members. A member is a named graph. Immutability is only in Cache-Control.
 *  - openldes: an OpenLDES server such as Telraam's (https://ldes.telraam-api.net/measurements/by-page): Turtle, a linked
 *              list of pages of a fixed size. Pages have an ETag. A closed page is immutable. The view does not have a
 *              tree:view, it is dct:isPartOf the LDES. The LDES has two views, and is described on its own IRI.
 *
 * The replication state of a client is therefore tested against requests that really happen, and statuses that really
 * happen: 302, 304, immutable pages, and 404 for what is not there (any more).
 */

export type Item = { n: number; t: Date };

export type Feed = {
    name: string;
    /** What a user gives to the client */
    entry(server: FeedServer): string;
    /** Extra configuration of the client that this feed needs */
    options: Record<string, unknown>;
    /** The orders that make sense for this feed */
    orders: Ordered[];
    /** (Re)publishes the pages of a feed that has these items, the oldest first */
    publish(server: FeedServer, items: Item[]): void;
    memberId(server: FeedServer, item: Item): string;
    /** Whether the page at this URL has members, in contrast with a page that only links to other pages */
    isLeaf(url: string): boolean;
};

const PREFIXES = `@prefix ldes: <https://w3id.org/ldes#> .
@prefix tree: <https://w3id.org/tree#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix dc: <http://purl.org/dc/terms/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix mr: <http://marineregions.org/ns/ontology#> .
@prefix verkeer: <https://data.vlaanderen.be/ns/verkeersmetingen#> .
`;

const IMMUTABLE = { "cache-control": "public, max-age=31536000, immutable" };
const iso = (date: Date) => date.toISOString().replace(".000Z", "Z");
const hour = (date: Date) => iso(new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000));
const hash = (n: number) => createHash("sha1").update(String(n)).digest("hex");
const chunk = <T>(list: T[], size: number): T[][] =>
    Array.from({ length: Math.max(1, Math.ceil(list.length / size)) }, (_, i) => list.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------------------------------------------------
// Marine Regions

const marine: Feed = {
    name: "marine",
    options: {},
    orders: ["none", "ascending"],
    entry: (server) => `${server.base}/feed`,
    memberId: (_, { n, t }) => `http://marineregions.org/mrgid/${n}?t=${Math.floor(t.getTime() / 1000)}`,
    isLeaf: (url) => url.startsWith("/feed.ttl?page="),
    publish(server, items) {
        server.routes.clear();
        const feed = `${server.base}/feed`;
        const byHour = new Map<string, Item[]>();
        for (const item of items) byHour.set(hour(item.t), [...(byHour.get(hour(item.t)) ?? []), item]);
        const hours = [...byHour.keys()].sort();
        const pageUrl = (start: string) =>
            `/feed.ttl?page=${encodeURIComponent(start)}%2F${encodeURIComponent(iso(new Date(Date.parse(start) + 3_600_000)))}`;

        hours.forEach((start, i) => {
            const isHead = i === hours.length - 1;
            const relations = [
                i < hours.length - 1 &&
                    `[ a tree:GreaterThanOrEqualToRelation ; tree:node <${server.base}${pageUrl(hours[i + 1])}> ; tree:path dc:modified ; tree:value "${hours[i + 1]}"^^xsd:dateTime ]`,
                i > 0 &&
                    `[ a tree:LessThanRelation ; tree:node <${server.base}${pageUrl(hours[i - 1])}> ; tree:path dc:modified ; tree:value "${start}"^^xsd:dateTime ]`,
            ].filter(Boolean);
            const members = byHour.get(start)!;
            const body = `${PREFIXES}
<${server.base}${pageUrl(start)}> a tree:Node ${relations.length ? `; tree:relation ${relations.join(" , ")}` : ""} ; ldes:retentionPolicy [ a ldes:RetentionPolicy ; ldes:versionAmount 1 ] .
<${feed}> a ldes:EventStream ; ldes:pollingInterval 86400 ; ldes:timestampPath dc:modified ; ldes:versionOfPath dc:isVersionOf ;
  ${isHead ? `tree:view <${server.base}${pageUrl(start)}> ;` : ""}
  tree:shape [ a sh:NodeShape ; sh:nodeKind sh:IRI ; sh:targetClass mr:MRGeoObject ;
    sh:property [ sh:path dc:modified ; sh:datatype xsd:dateTime ; sh:minCount 1 ] , [ sh:path dc:isVersionOf ; sh:nodeKind sh:IRI ; sh:minCount 1 ] , [ sh:path skos:prefLabel ] ] ;
  tree:member ${members.map((m) => `<${marine.memberId(server, m)}>`).join(" , ")} .
${members
    .map(
        (m) =>
            `<${marine.memberId(server, m)}> a mr:MRGeoObject ; dc:modified "${iso(m.t)}"^^xsd:dateTime ; dc:isVersionOf <http://marineregions.org/mrgid/${m.n}> ; skos:prefLabel "place ${m.n}"@en .`,
    )
    .join("\n")}
`;
            server.route(pageUrl(start), {
                body,
                type: "text/turtle; charset=UTF-8;",
                headers: isHead ? { "cache-control": "public, max-age=3600" } : { "cache-control": "public, max-age=604800, immutable" },
            });
        });
        // The entry point is not a page: it is a chain of redirects to the page of the current hour
        server.redirect("/feed", "/feed.ttl");
        if (hours.length) server.redirect("/feed.ttl", pageUrl(hours[hours.length - 1]));
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// A hierarchy of years, months, and days, which are paged. The Rijksmuseum, and MINT.

type Day = { year: number; month: number; day: number; items: Item[] };
const days = (items: Item[]): Day[] => {
    const byDay = new Map<string, Day>();
    for (const item of items) {
        const [year, month, day] = [item.t.getUTCFullYear(), item.t.getUTCMonth() + 1, item.t.getUTCDate()];
        const key = `${year}-${month}-${day}`;
        byDay.set(key, byDay.get(key) ?? { year, month, day, items: [] });
        byDay.get(key)!.items.push(item);
    }
    return [...byDay.values()];
};
const startOf = (year: number, month = 1, day = 1) => new Date(Date.UTC(year, month - 1, day));

type Node = { url: string; relations: { gte: string; lt?: string; to: string }[]; members: Item[]; closed: boolean };

type Urls = { root: string; year(y: number): string; month(y: number, m: number): string; page(d: Day, k: number): string };

/** The nodes of a hierarchy: the root, then every year that has items, every month, every day, and its pages */
function hierarchy(items: Item[], urls: Urls, pageSize: number): Node[] {
    const nodes: Node[] = [];
    const all = days(items);
    const latest = all[all.length - 1];
    const years = [...new Set(all.map((d) => d.year))];

    nodes.push({
        url: urls.root,
        members: [],
        closed: false,
        relations: years.map((y) => ({ gte: iso(startOf(y)), lt: iso(startOf(y + 1)), to: urls.year(y) })),
    });
    for (const y of years) {
        const months = [...new Set(all.filter((d) => d.year === y).map((d) => d.month))];
        nodes.push({
            url: urls.year(y),
            members: [],
            closed: !!latest && y < latest.year,
            relations: months.map((m) => ({ gte: iso(startOf(y, m)), lt: iso(startOf(y, m + 1)), to: urls.month(y, m) })),
        });
        for (const m of months) {
            const monthDays = all.filter((d) => d.year === y && d.month === m);
            nodes.push({
                url: urls.month(y, m),
                members: [],
                closed: !!latest && (y < latest.year || m < latest.month),
                relations: monthDays.map((d) => ({ gte: iso(startOf(y, m, d.day)), lt: iso(startOf(y, m, d.day + 1)), to: urls.page(d, 0) })),
            });
            for (const d of monthDays) {
                const pages = chunk(d.items, pageSize);
                const closed = !!latest && (y < latest.year || m < latest.month || d.day < latest.day);
                pages.forEach((members, k) =>
                    nodes.push({
                        url: urls.page(d, k),
                        members,
                        closed,
                        relations: k < pages.length - 1 ? [{ gte: iso(pages[k + 1][0].t), to: urls.page(d, k + 1) }] : [],
                    }),
                );
            }
        }
    }
    return nodes;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Rijksmuseum

const rijksContext = {
    as: "https://www.w3.org/ns/activitystreams#",
    ldes: "https://w3id.org/ldes#",
    tree: "https://w3id.org/tree#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    Update: "as:Update",
    object: "as:object",
    published: "as:published",
    EventStream: "ldes:EventStream",
    LatestVersionSubset: "ldes:LatestVersionSubset",
    retentionPolicy: "ldes:retentionPolicy",
    timestampPath: "ldes:timestampPath",
    versionOfPath: "ldes:versionOfPath",
    amount: "ldes:amount",
    member: "tree:member",
    relation: "tree:relation",
    path: "tree:path",
    node: "tree:node",
    value: "tree:value",
    view: "tree:view",
};

const rijks: Feed = {
    name: "rijks",
    options: {},
    orders: ["none", "ascending"],
    entry: (server) => `${server.base}/ldes/collection.json`,
    memberId: (_, { n, t }) => `https://data.rijksmuseum.nl/${n}#${t.toISOString().replace("Z", "000Z")}`,
    isLeaf: (url) => /^\/ldes\/\d+\/\d+\/\d+\.json/.test(url),
    publish(server, items) {
        server.routes.clear();
        const url = (path: string) => `${server.base}${path}`;
        const urls: Urls = {
            root: "/ldes/collection.json",
            year: (y) => `/ldes/${y}.json`,
            month: (y, m) => `/ldes/${y}/${m}.json`,
            page: (d, k) => `/ldes/${d.year}/${d.month}/${d.day}.json${k ? `?pageToken=${k}` : ""}`,
        };
        // An external context, as the members of the Rijksmuseum have, which a client must not request again and again
        server.route("/ns/context.jsonld", { body: JSON.stringify({ "@context": { ex: "http://example.org/" } }), type: "application/ld+json" });

        for (const node of hierarchy(items, urls, 4)) {
            const body = {
                "@context": [rijksContext, url("/ns/context.jsonld")],
                "@id": url("/ldes/collection.json#eventstream"),
                "@type": "EventStream",
                timestampPath: { "@id": "as:published" },
                versionOfPath: { "@id": "as:object" },
                ...(node.members.length
                    ? {
                          member: node.members.map((m) => ({
                              "@id": rijks.memberId(server, m),
                              "@type": "Update",
                              object: { "@id": `https://data.rijksmuseum.nl/${m.n}?_profile=bf` },
                              published: { "@value": m.t.toISOString().replace("Z", "000Z"), "@type": "xsd:dateTime" },
                          })),
                      }
                    : {}),
                view: {
                    "@id": url(node.url),
                    retentionPolicy: { "@type": "LatestVersionSubset", amount: 1 },
                    relation: node.relations.flatMap((r) => [
                        {
                            "@type": "tree:GreaterThanOrEqualToRelation",
                            path: { "@id": "as:published" },
                            value: { "@value": r.gte, "@type": "xsd:dateTime" },
                            node: { "@id": url(r.to) },
                        },
                        ...(r.lt
                            ? [
                                  {
                                      "@type": "tree:LessThanRelation",
                                      path: { "@id": "as:published" },
                                      value: { "@value": r.lt, "@type": "xsd:dateTime" },
                                      node: { "@id": url(r.to) },
                                  },
                              ]
                            : []),
                    ]),
                },
            };
            server.route(node.url, { body: JSON.stringify(body), type: "application/ld+json", headers: node.closed ? IMMUTABLE : undefined });
        }
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// MINT

const mint: Feed = {
    name: "mint",
    options: {},
    orders: ["none", "ascending"],
    entry: (server) => `${server.base}/euscreenxl/1008/ldes`,
    memberId: (server, { n, t }) => `${server.base}/euscreenxl/1008/ldes#${t.getTime()}_${hash(n)}`,
    isLeaf: (url) => /^\/euscreenxl\/1008\/ldes\/\d+\/\d+\/\d+\?page=/.test(url),
    publish(server, items) {
        server.routes.clear();
        const prefix = "/euscreenxl/1008/ldes";
        const stream = `${server.base}${prefix}#eventstream`;
        const urls: Urls = {
            root: prefix,
            year: (y) => `${prefix}/${y}`,
            month: (y, m) => `${prefix}/${y}/${m}`,
            page: (d, k) => `${prefix}/${d.year}/${d.month}/${d.day}?page=${k}`,
        };
        for (const node of hierarchy(items, urls, 4)) {
            const here = `${server.base}${node.url}`;
            const relations = node.relations.flatMap((r, i) => [
                `_:g${i} a tree:GreaterThanOrEqualToRelation ; tree:node <${server.base}${r.to}> ; tree:path as:published ; tree:value "${r.gte}"^^xsd:dateTime .`,
                ...(r.lt
                    ? [
                          `_:l${i} a tree:LessThanRelation ; tree:node <${server.base}${r.to}> ; tree:path as:published ; tree:value "${r.lt}"^^xsd:dateTime .`,
                      ]
                    : []),
            ]);
            const graphs = node.members.map(
                (m) =>
                    `<${mint.memberId(server, m)}> {\n  <http://mint-projects.image.ntua.gr/data/${m.n}> a <http://www.europeana.eu/schemas/edm/ProvidedCHO> ; <http://purl.org/dc/elements/1.1/title> "Item ${m.n}" .\n}`,
            );
            const body = `${PREFIXES}
${graphs.join("\n")}
{
  <${stream}> a ldes:EventStream ; ldes:timestampPath as:published ; ldes:versionOfPath as:object ; ldes:versionCreateObject as:Create ; ldes:versionDeleteObject as:Delete ;
    ${node.members.length ? `tree:member ${node.members.map((m) => `<${mint.memberId(server, m)}>`).join(" , ")} ;` : ""}
    tree:view <${here}> .
  ${node.relations.length ? `<${here}> tree:relation ${node.relations.flatMap((r, i) => [`_:g${i}`, ...(r.lt ? [`_:l${i}`] : [])]).join(" , ")} .` : ""}
  ${relations.join("\n  ")}
}
`;
            server.route(node.url, { body, type: "application/trig", headers: node.closed ? IMMUTABLE : undefined });
        }
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// An OpenLDES server, such as Telraam's

const PAGE_SIZE = 5;

const openldes: Feed = {
    name: "openldes",
    options: {},
    orders: ["none", "ascending"],
    entry: (server) => `${server.base}/measurements/by-page`,
    memberId: (_, { n, t }) => `https://telraam.net/en/location/${n}#car-lft#${iso(t)}`,
    isLeaf: (url) => url.startsWith("/measurements/by-page?pageNumber="),
    publish(server, items) {
        server.routes.clear();
        const stream = `${server.base}/measurements`;
        const pages = chunk(items, PAGE_SIZE);
        const turtle: Pick<Route, "type" | "etag"> = { type: "text/turtle;charset=UTF-8", etag: true };

        // The description of the LDES is on its own IRI, and lists both views of it
        server.route("/measurements", {
            ...turtle,
            headers: { "cache-control": "public,max-age=60" },
            body: `${PREFIXES}
<${stream}> a ldes:EventStream ; ldes:timestampPath prov:generatedAtTime ; ldes:versionOfPath dc:isVersionOf ; tree:shape [ a sh:NodeShape ] ;
  tree:view <${stream}/by-time> , <${stream}/by-page> .
`,
        });
        // The first page is not numbered
        server.route("/measurements/by-page", {
            ...turtle,
            headers: { "cache-control": "public,max-age=60" },
            body: `${PREFIXES}
<${stream}/by-page> a tree:Node ; dc:isPartOf <${stream}> ; tree:relation [ a tree:Relation ; tree:node <${stream}/by-page?pageNumber=1> ] .
<${stream}> a ldes:EventStream .
`,
        });
        pages.forEach((members, i) => {
            const url = `/measurements/by-page?pageNumber=${i + 1}`;
            const closed = i < pages.length - 1;
            server.route(url, {
                ...turtle,
                headers: { "cache-control": closed ? "public,max-age=31536000,immutable" : "public,max-age=60" },
                body: `${PREFIXES}
<${server.base}${url}> a tree:Node ; dc:isPartOf <${stream}> ${closed ? `; tree:relation [ a tree:Relation ; tree:node <${server.base}/measurements/by-page?pageNumber=${i + 2}> ]` : ""} .
${members.length ? `<${stream}> tree:member ${members.map((m) => `<${openldes.memberId(server, m)}>`).join(" , ")} .` : ""}
${members
    .map(
        (m) =>
            `<${openldes.memberId(server, m)}> a verkeer:Verkeersmeting ; dc:isVersionOf <https://telraam.net/en/location/${m.n}#car-lft> ; prov:generatedAtTime "${iso(m.t)}"^^xsd:dateTime ; verkeer:tellingresultaat ${m.n} .`,
    )
    .join("\n")}
`,
            });
        });
    },
};

export const feeds: Feed[] = [marine, rijks, mint, openldes];

/** `count` items, one every 20 minutes from `start`: pages, days, and months fill up */
export function items(count: number, from = 0, start = Date.UTC(2026, 0, 30, 22, 0, 0)): Item[] {
    return Array.from({ length: count }, (_, i) => ({ n: from + i + 1, t: new Date(start + i * 20 * 60_000) }));
}
