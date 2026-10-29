# The LDES client

[![CI tests](https://github.com/rdf-connect/ldes-client/actions/workflows/ci-tests.yml/badge.svg)](https://github.com/rdf-connect/ldes-client/actions/workflows/ci-tests.yml) [![npm](https://img.shields.io/npm/v/ldes-client.svg?style=popout)](https://npmjs.com/package/ldes-client)

This package provides a reference implementation of a [Linked Data Event Stream (LDES)](https://w3id.org/ldes/specification) client.

The main functionality is to extract/replicate members within an LDES, and keeping in-sync with it. This library can be used also as a [RDF-Connect](https://rdf-connect.github.io/) processor to build more complex data processing pipelines.

Install the package using: 
```bash
npm install -g ldes-client
```

## Replication and synchronization

The LDES client has two main modes: `replicate` and `sync`. Both are accessible through the command line interface (CLI) with various alternative options.

```bash
ldes-client <url> [--follow] [--ordered <order>] [--after <datetime>] [--before <datetime>] [--save <path>] [--poll-interval <number>] [--basic-auth <username>:<password>] [--shape-file <shapeFile>] [--only-default-graph] [--no-shape] [--materialize] [--last-version-only] [--default-timezone <timezone>] [--condition <conditionFile>] [--concurrent <number>] [--retry-count <number>] [--http-codes codes...] [--safe][--url-is-view] [--loose] [--quiet] [--start-fresh] [--metadata] [--format <format>] [--comment]
```

### CLI options

- `-f` `--follow`: follow the LDES, the client stays in sync
- `-o` `--ordered`: temporal order of member emission based on the `ldes:timestampPath` value (if any). `none|ascending|descending` Default: `none`.
- `--before`: emit only members timestamped before (exclusive) the given timestamp. 
- `--after`: emit only members timestamped after (exclusive) the given timestamp. 
- `-s` `--save`: path to the save state folder, used both to resume and to update.
- `--start-fresh`: the client will start from scratch, discarding any existing saved state.
- `--poll-interval`: time to wait between polling cycles of the LDES. This property applies only when the client is following the LDES.
- `--basic-auth`: user and password for HTTP basic authentication.
- `--shape-file`: shape file (local or remote via URL) to which LDES members should conform (overwrites LDES configured shape if any).
- `--only-default-graph`: the client will consider only the default graph (and the member graph if so) for extracting member triples.
- `--no-shape`: the client ignores any shape defined in the LDES and extracts members based on CBD (Concise Bounded Description) or named graph bounds. 
- `--materialize`: the client emits the canonical version of every member, based on the `ldes:versionOfPath` property value.
- `--last-version-only`: the clients emits only the latest version of every member.
- `-t` `--default-timezone`: default timezone to use for dates in tree:InBetweenRelation. `AoE|Z|±HH:mm` Default: `AoE`.
- `--condition`: filter the LDES stream to only emit members that adhere to this condition.
- `--url-is-view`: informs the client that the given URL corresponds already to a `tree:view` avoiding the client to fail when no declared view is found. 
- `-l` `--loose`: the client is less strict when following `tree:relation` properties and ignores if the page URL does not correspond to the `tree:Node` IRI.
- `--format <format>`: the output format of the members on the standard output. `trig-messages` (default) is an RDF Message log in TriG: one message per member, delimited by `@message .`, so that the boundaries between members are kept and any RDF Messages parser can read it back. `n-quads` prints the quads of all members as N-Quads, without member boundaries.
- `-c` `--comment`: print a comment (`# ...`) before every member with what the LDES says about it: the number of the member in the output, its IRI, its timestamp and sequence (as written in the member), the entity it is a version of (`ldes:versionOfPath`), its type and whether its transaction is finalized. Whatever is unknown is left out. In the message log, the comment follows the `@message .` of the previous member, so parsers ignore it.
- `-q` `--quiet`: the client does not print the extracted members in the console when run via the CLI.
- `--concurrent`: maximum number of concurrent HTTP request that the client can make (default `10`). An LDES 2.0 client also requests this many pages before it needs them: see [Prefetching pages](#prefetching-pages).
- `--retry-count`: maximum number of HTTP request retries that the client would perform before failing.
- `--safe`: enables safe mode of fetching, which will retry when a fetch fails.
- `--http-codes`: list of HTTP response codes over which the client would retry a request.
- `-m`, `--metadata`: include metadata in the emitted members. Notifies the ldes server that it is interested in metadata, via the HTTP header `Accept: application/metadata+trig`.

### Use it as a library

You can also use the `ldes-client` programatically as a library in your TS/JS projects as follows:

```typescript
import { replicateLDES, intoConfig } from "ldes-client";

async function main() {
  const ldesClient = replicateLDES(intoConfig({
    url: "http://my.ldes.org",
    materialize: true,
    // ... (see above for more options)
  }));

  const memberReader = ldesClient.stream({ highWaterMark: 10 }).getReader();
  let member = await memberReader.read();

  while (member) {
    // Do something with the member
    // ...
    // Read the next member
    member = await memberReader.read();

    if (member.done) {
      break;
    }
  }
}

main().catch((err) => {console.error(err)});
```

### `ldes-client` in an RDF-Connect pipeline

The `ldes-client` is also exposed as an [RDF-Connect](https://rdf-connect.github.io/) processor (see the semantic definition at [processor.ttl](https://github.com/rdf-connect/ldes-client/blob/main/processor.ttl) and the wrapper implementation at [`lib/rdf-connect.ts`](https://github.com/rdf-connect/ldes-client/blob/main/lib/rdfc-processor.ts)) and may be used in a pipeline as follows:

```turtle
@prefix rdfc: <https://w3id.org/rdf-connect#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.

### Import the processor definitions
<> owl:imports <./node_modules/@rdfc/js-runner/index.ttl>.
<> owl:imports <./node_modules/ldes-client/processor.ttl>.

### Define the channels your processor needs
<members> a rdfc:Reader, rdfc:Writer.

### Attach the processor to the pipeline under the e.g., the rdfc:NodeRunner
<> a rdfc:Pipeline;
    rdfc:consistsOf [
        rdfc:instantiates rdfc:NodeRunner;
        rdfc:processor <ldes-client>
    ].

### Define and configure the processor
<ldes-client> a rdfc:LdesClient;
    rdfc:url <http://my.ldes.org>;
    rdfc:output <members>;
    rdfc:follow true;
    ...
```

## LDES 2.0

The client supports both [LDES 1.0](https://w3id.org/ldes/specification) and the draft of LDES 2.0 ([SEMICeu/LinkedDataEventStreams#116](https://github.com/SEMICeu/LinkedDataEventStreams/pull/116)). It detects which version it is reading from the root page, following the [compatibility section](https://github.com/SEMICeu/LinkedDataEventStreams/pull/116) of the draft, so the same command and library call work for both:

```bash
ldes-client https://example.org/observations/ --follow --save ./state
```

For an LDES 2.0, the client:

 * reads every page as an [RDF Message](https://w3c-cg.github.io/rsp/spec/messages.html) log, in a streaming way: TriG, N-Quads, N-Triples and Turtle (with `VERSION "1.2-messages"`, a document without messages is one message) and [Jelly-RDF](https://jelly-rdf.github.io), also when gzipped. NDJSON-LD is not supported yet.
 * identifies the member of every message using `ldes:member`, `ldes:memberGraph`, `ldes:memberType` or `ldes:memberPath`, and emits the member with all quads of the message;
 * orders members on their `ldes:timestampPath` and `ldes:sequencePath`, or implicitly on their page number and index in the page, and traverses the pages as a merge of sorted logs using the intervals of the `ldes:relation`s;
 * handles timestamps without a timezone: it uses the configured `defaultTimezone` when that is an offset such as `+01:00` (the CLI default `AoE` is not), otherwise the `ldes:defaultTimezone` of the LDES, and otherwise it assumes all of them share one unknown timezone. It only skips members and relations, and only reports a page that is not ordered, when the order is certain for every timezone;
 * does not fetch a page again once it has been read completely, when the page that links to it states `<page> ldes:immutable true` and it has no relations itself;
 * only keeps a *bookmark* as state (the key of the last member and the identifiers of the members that share it) instead of all members or pages it has seen. With `--save`, the next run skips all pages before the bookmark without requesting them.

The `description` event gives the context information (`info.ldesVersion` is `2`). Not yet implemented: ETag revalidation (`If-None-Match`), the ordering rule for members that finalize a transaction, and the `--condition` options that are not `--after` or `--before`.

#### Prefetching pages

The pages of an LDES 2.0 are merged in the order of their keys, which makes a naive client read them one after the other: it waits for the latency of every page.
The client therefore requests the pages that it is going to follow next, before it needs them (as many as `concurrentFetches` allows, `--concurrent` on the command line, default `10`; with `1` the pages are read one by one):

 * The pages are those of the relations with the smallest lower bound, which are the first to be followed. A relation that the client skips (before the bookmark, or an immutable page that was read completely) is never requested.
 * Memory stays bounded. At most that many pages are requested ahead, the one that is awaited included, and such a page buffers no more than 64 messages: after that, the connection is paused until the merge starts reading the page. The client does not need to read more than one message of a page to know where to continue: when that is the description message, the relations in it are known early, so the pages below it can be requested ahead too.
 * Backpressure applies as before: when the consumer is slow, nothing more than the window is fetched.
 * A page that cannot be loaded is only an error when the merge needs it. Pages that were requested ahead and are not needed (the consumer left) are closed.

On a test LDES of 14 pages with a latency of 50 ms per page (see [perf](perf/README.md)), a run takes about 770 ms with `--concurrent 1` and about 260 ms with the default, the same as the LDES 1.0 client on the same tree (about 230 ms).

HTTP and parsing are done with [ldfetch](https://github.com/pietercolpaert/ldfetch) (its RDF parsers for all serializations including Jelly-RDF) on top of the retrying `fetch` of this client, instead of rdf-dereference.

### Sample: a RiverBench dataset as an LDES

[examples/riverbench/root.trig](examples/riverbench/root.trig) is the root page of an LDES 2.0 that points at the Jelly-RDF distribution of the first 10 000 graphs of the [RiverBench](https://w3id.org/riverbench) dataset `assist-iot-weather-graphs`. It declares that the member is the named graph of each message (`ldes:memberGraph`), orders the members on `prov:atTime` (`ldes:timestampPath`, of which the values have no timezone), links a SHACL shape (`ldes:shape`), and marks the data page immutable. [catalog.ttl](examples/riverbench/catalog.ttl) lists it as a `dcat:Distribution` of the RiverBench dataset, with its title, description, creators, license and temporal resolution.

```bash
ldes-client examples/riverbench/root.trig
```

## Conditions

When passing a condition file to the `ldes-client` CLI, the expected content is a condition where the subject is the file itself.


### Simple condition
```turtle
@prefix csp: <http://vocab.deri.ie/csp#>.
@prefix tree: <https://w3id.org/tree#>.
<> a csp:Condition;
    # Type of relation to filter on
    tree:relationType tree:GreaterThanOrEqualToRelation;
    # Path to extract values for the filter
    tree:path <http://def.isotc211.org/iso19156/2011/Observation#OM_Observation.resultTime>;
    # Alpha value for comparison
    tree:value "2024-01-14T08:35:35.720Z";
    tree:compareType "date".
```

### And condition
```turtle
@prefix csp: <http://vocab.deri.ie/csp#>.
@prefix tree: <https://w3id.org/tree#>.
<> a csp:And;
  csp:and [
    a csp:Condition;
    tree:relationType tree:GreaterThanOrEqualToRelation;
    tree:path <http://def.isotc211.org/iso19156/2011/Observation#OM_Observation.resultTime>;
    tree:value "2024-01-14T08:35:35.720Z"
    tree:compareType "date";
  ];
  csp:and [
    a csp:Condition;
    tree:relationType tree:LessThanRelation;
    tree:path <http://def.isotc211.org/iso19156/2011/Observation#OM_Observation.resultTime>;
    tree:value "2024-01-15T08:35:35.720Z"
    tree:compareType "date";
  ].
```

### Or condition
```turtle
@prefix sh: <http://www.w3.org/ns/shacl#>.
@prefix sosa: <http://www.w3.org/ns/sosa/>.
@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.
@prefix csp:   <http://vocab.deri.ie/csp#> .
@prefix tree: <https://w3id.org/tree#>.

<> a csp:Or;
  csp:or [
    a csp:Condition;
    tree:relationType tree:EqualToRelation;
    tree:value ex:sensor1;
    tree:path ( sosa:madeBySensor [ sh:inversePath sosa:hosts ] );
  ];
  csp:or [
    a csp:Condition;
    tree:relationType tree:EqualToRelation;
    tree:value ex:sensor2;
    tree:path ( sosa:madeBySensor [ sh:inversePath sosa:hosts ] );
  ].
```

## Use cases

These are some of the use cases for which the `ldes-client` can be used:

- I want to replicate all/part of a dataset (published as an LDES) as fast as possible. If this would take a long time, I want this to be fault tolerant and be able to stop and resume later without loosing data.
- I want to stay up to date with all entities present in a dataset (published as an LDES). For this, I don't care about old data, only the newest data per entity is required. Also, I want to periodically trigger the sync process.
- I want to do timeseries analysis, for which I need all data in order, according to their timestamp. I want options to resume, and later stay in sync.

## Software architecture

The client contains two parts, `fetching` the pages (aka. LDES fragments) and `extracting & emitting` the entities (aka. LDES members). Different use cases have different influences on these parts. For example:
- a time series analysis wants to fetch pages first that contain older members, the member emitter only wants to start emitting members when the oldest page has been found.
- getting the latest versions of each member is the inverse, first fetch the youngest pages, so members can immediately be emitted.

The main challenges are related to the coordination between the two parts:
- the member emitter needs to know what the fragment fetcher is doing (did it know that the oldest page is fetched?)
- how to handle the unbounded size nature of an LDES?
  - Keeping state of emitted members is unbounded
  - Keeping state of visited pages is unbounded
These are also influenced by the configuration.

The implementation coordinates the behavior of the two parts through a `Strategy`. So far, two strategies exist:
- [`unordered`](./lib/strategy/unordered.ts): this strategy fetches pages as soon as they are found and emits members without any regard for their temporal order.
- [`ordered`](./lib/strategy/ordered.ts): this strategy tries to fetch first (if the LDES structure allows it) the pages that would logically contain the oldest/newest members depending on the configuration (`ascending` or `descending`); and emits members in order based on their timestamp.

### Fragment Fetcher

The fragment fetcher fetches the fragments. Depending on the chosen strategy, these fragments are managed in a priority queue with different conditions. 

In the case of the `unordered` strategy, the fragments are handled individually in a simple FIFO manner. 

In the case of the `ordered` strategy, the fragments are assembled and targeted via [`RelationChains`](./lib/fetcher/relation.ts#L98), of which two types exist: `important` and `unimportant`. The important relations are, for example, the `tree:GreaterThanRelation` and `tree:GreaterThanOrEqualToRelation` relations, because all other relation types are equivalent.  That is to say, we can only emit members when all unimportant relations are fetched and processed.

Relation chains are chains, because when the client fetches a page, it can find new relations pointing from that page. But we need to distinguish between a relation after an important relation or a relation after an unimportant relation:
- Important relations squash unimportant relations, these chains should only be fetched if all unimportant relations are done.
- Unimportant relations squash other unimportant relations. 
- Important relations squash other important relations, the new _value_ is the bigger value of the two.
The ordering of these chains is thus, first unimportant relations, then important relations ordered on value. These chains dictate the order in which pages are fetched.

Given that multiple relations can be encountered from every new page, it is possible to fetch multiple pages at the same time. However, when following an ordered strategy and considering that fetching is asynchronous, we can only interpret a page that came from a smaller relation, if no pages are _in flight_. These aspects are managed by a [`Modulator`](./lib/fetcher/modulator.ts).

### Fault Tolerance

The fetcher tries to be fault tolerant. HTTP codes that indicate that the server is overloaded or something else is going wrong are caught and retried, following an exponential back-off strategy.
This is the default behaviour when the provided config does not provide a fetch function.

Caught HTTP codes:

- 408: Request timeout
- 425: Too Early
- 429: Too Many requests
- 500: Internal Server Error
- 502: Bad Gateway
- 503: Service Unavailable
- 504: Gateway Timeout

```typescript
// Provide your own codes with a custom retry function
config.fetch = enhanced_fetch({ retry: { codes: [408, 425, 429, 500, 502, 503, 504] } });
```

## Compliance tests

LDES 1.0 compliance is checked with the external [ldes-client-conformance-test-suite](https://github.com/pietercolpaert/ldes-client-conformance-test-suite). The suite runs this client through its `rdf-connect` adapter and writes JSON, EARL, and evidence files for every scenario.

Run the suite from this repository:

```bash
npm ci
npm run test:conformance
```

The command uses `../ldes-client-conformance-test-suite` when that checkout already exists. If it is missing, it clones the suite from GitHub first. Local changes in that sibling checkout are respected.

The command exits with a non-zero status when required conformance tests fail. To generate the report artifacts while adopting or debugging failures, pass `--no-fail` through npm:

```bash
npm run test:conformance -- --no-fail
```

LDES 2.0 tests, which can be the start of a conformance test suite for LDES 2.0, are in [tests/ldes2](tests/ldes2): they run the client against a mock server that serves RDF Message logs in TriG, N-Quads and Jelly-RDF. Run them with `npx vitest run tests/ldes2`, and add `RIVERBENCH=1` to also replicate the real RiverBench dataset over the network.

## Authors and license

 - Tests and design: Pieter Colpaert
 - Actual implementation: Arthur Vercruysse, Ieben Smessaert, Julián Rojas

© 2026 -- Ghent University - IMEC. MIT license
