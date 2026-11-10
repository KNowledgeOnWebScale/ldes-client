# LDES client

[![CI tests](https://github.com/rdf-connect/ldes-client/actions/workflows/ci-tests.yml/badge.svg)](https://github.com/rdf-connect/ldes-client/actions/workflows/ci-tests.yml) [![npm](https://img.shields.io/npm/v/ldes-client.svg)](https://www.npmjs.com/package/ldes-client) [![LDES conformance](https://github.com/rdf-connect/ldes-client/actions/workflows/ldes-conformance.yml/badge.svg)](https://github.com/rdf-connect/ldes-client/actions/workflows/ldes-conformance.yml)

Replicate a [Linked Data Event Stream (LDES)](https://w3id.org/ldes/specification), filter its members, or keep a local consumer synchronized with new data. Use the client from the command line, as a JavaScript/TypeScript library, or in an [RDF-Connect](https://rdf-connect.github.io/) pipeline.

**LDES 1.0 support is stable. LDES 2.0 support is experimental** and follows evolving proposals. LDES 2.0 behavior, options and events may change incompatibly in any release. Pin the package version when relying on it, and check [CHANGELOG.md](CHANGELOG.md) when upgrading.

## Quick start

Use Node.js 24 or newer. Install the CLI:

```sh
npm install -g ldes-client
```

Read all currently available members and exit:

```sh
ldes-client https://example.org/ldes > members.trig
```

Keep polling for new members:

```sh
ldes-client https://example.org/ldes --follow
```

Filter by time and emit members in ascending order:

```sh
ldes-client https://example.org/ldes \
  --after 2026-01-01T00:00:00Z --before 2026-02-01T00:00:00Z \
  --ordered ascending
```

There are no separate replication or synchronization subcommands: `--follow` keeps the process running after it catches up. The client detects the LDES version from the root page.

### Saving state and resuming

Give `--save` a path to save what the client has read:

```sh
ldes-client https://example.org/ldes --follow --save ./state > members.trig
```

The state is saved while the client runs and when you stop it with Ctrl-C. To resume, run the same command with the same `--save` path: the client continues from the saved state and does not emit the members it already emitted, so it only produces what is new. Without `--follow`, it reads what is new and exits, which is how you synchronize on a schedule (for example with cron). Append the output (`>>`) if you want to keep the earlier members in the same file.

Use `--start-fresh` to discard the saved state and read everything again. Use a separate state path for every LDES you replicate. In the library, the same is done with `statePath` (or a custom `storage`, see [State Management](#state-management)).

## Command line

```sh
npx ldes-client <url> [options]
npx ldes-client --help
```

By default, standard output is a TriG RDF Message Log with one message per member. Message delimiters preserve member boundaries. Use `--format n-quads` for a flat stream of quads, or `--comment` to add comments with each member's identifier and available timestamp, sequence, version, type and transaction metadata.

### Reading, filtering and state

| Option | Behavior |
| --- | --- |
| `-f, --follow` | Keep polling for new members. |
| `-o, --ordered <order>` | LDES 1.0 emission order: `none` (default), `ascending` or `descending`. LDES 2.0 retains stream order. |
| `--after <datetime>` / `--before <datetime>` | Filter by timestamp; both bounds are exclusive. |
| `--condition <file>` | Apply a [Turtle condition](#conditions). |
| `-s, --save <path>` | Persist state for resuming and synchronization. |
| `--start-fresh` | Discard existing saved state and start again. |
| `--poll-interval <ms>` | Polling interval while following; default `1000`. |
| `-t, --default-timezone <timezone>` | Default timezone for LDES 1.0 `tree:InBetweenRelation` dates; default `AoE`. See [LDES 2.0](#ldes-20) for timestamps without a timezone. |

### Extraction and output

| Option | Behavior |
| --- | --- |
| `--shape-file <path-or-url>` | Override the LDES 1.0 member extraction shape with a local or remote SHACL shape. |
| `--no-shape` | Extract LDES 1.0 members using Concise Bounded Descriptions (CBD) and named graphs, ignoring declared shapes. |
| `--only-default-graph` | Restrict LDES 1.0 extraction to the default graph and the member's graph. |
| `--materialize` | Materialize versioned members using `ldes:versionOfPath`. |
| `--last-version-only` | Emit only the latest available version of each entity in LDES 1.0. |
| `--format <format>` | `trig-messages` (default) or `n-quads`. |
| `-c, --comment` | Add a comment before each member with its available metadata. |
| `-m, --metadata` | Request LDES 1.0 metadata using `Accept: application/metadata+trig` and include it in the output. |
| `-q, --quiet` | Suppress member output. |

LDES 2.0 members contain all quads of their message; SHACL/CBD extraction options apply to LDES 1.0.

### Fetching and compatibility

| Option | Behavior |
| --- | --- |
| `--concurrent <number>` | Maximum concurrent HTTP requests per domain and LDES 2.0 prefetch window; default `10`. |
| `--basic-auth <username>:<password>` | HTTP Basic authentication. |
| `--retry-count <number>` | Retry limit; default `3`, with `0` for unlimited retries. It also applies to a page of which the transfer is interrupted. |
| `--http-codes <codes...>` | HTTP status codes to retry. |
| `--safe` | Retry thrown fetch errors. |
| `--context-min-ttl <seconds>` | Keep external JSON-LD contexts for at least this long, whatever their cache headers say; default `600`. |
| `--no-context-cache` | Do not cache external JSON-LD contexts. |
| `--url-is-view` | Treat the input URL as a TREE view without discovering one. |
| `-l, --loose` | Follow LDES 1.0 relations even when the page URL differs from the `tree:Node` IRI. |

HTTP statuses `408`, `425`, `429`, `500`, `502`, `503` and `504` are retried with exponential backoff by default. Library callers can customize fetching with `enhanced_fetch`.

A page of which the server drops the connection after it sent a successful response and a part of the body (for example, because it is overloaded) is requested again too, and the client continues after the members that it read already. Library callers can set this with `transferRetry: { maxRetries, base }` (default: 5 new requests, the first after 500 ms, doubling every time; `maxRetries: 0` is unlimited). When the page keeps being interrupted, the client fails with an error that names the page.

### Logging

In Node.js, the CLI and library write logs to standard error, leaving standard output available for member data. Set `LOG_LEVEL` before starting the process to control verbosity:

```sh
LOG_LEVEL=debug npx ldes-client https://example.org/ldes > members.trig
```

Supported levels, from least to most verbose, are `error`, `warn`, `info`, `http`, `verbose`, `debug` and `silly`. The default is `info`. Without an explicit `LOG_LEVEL`, `DEBUG=ldes-client` or `DEBUG=*` selects `debug`; `LOG_LEVEL` takes precedence.

`--quiet` suppresses member output, not logs. For Docker, pass the environment variable with `-e LOG_LEVEL=debug` before the image name.

### Docker

Build the [Dockerfile](Dockerfile) and mount a volume for saved state:

```sh
docker build -t ldes-client .
docker run --rm -v ldes-state:/data ldes-client \
  https://example.org/ldes --follow --save /data/state
```

The image uses Node.js 24, runs as an unprivileged user, and uses `/data` as its working directory. Arguments after the image name are CLI arguments; running the image without arguments displays help.

## JavaScript and TypeScript

Install the library in your project:

```sh
npm install ldes-client
```

`replicateLDES` accepts a partial configuration and fills in defaults. Its stream yields members with an RDF/JS identifier (`id`) and an array of RDF/JS quads (`quads`):

```typescript
import { replicateLDES } from "ldes-client";

const client = replicateLDES({
  url: "https://example.org/ldes",
  statePath: "./state",
});

for await (const member of client.stream({ highWaterMark: 10 })) {
  console.log(member.id.value, member.quads.length);
}
```

Pass `"ascending"` or `"descending"` as the second argument for ordered LDES 1.0 replication. Set `polling: true` to keep following the stream. Other configuration names include `pollInterval`, `concurrentFetches`, `after` and `before` (JavaScript `Date` objects). See [Config](lib/config.ts) for all options and defaults.

The client exposes `description`, `fragment`, `poll`, `mutable` and `error` events. The `description` event includes the detected version as `info.ldesVersion`. Member metadata such as `timestamp`, `sequence` and `isVersionOf` is optional; see [the shared types](lib/types.ts).

To customize HTTP retries:

```typescript
import { enhanced_fetch, replicateLDES } from "ldes-client";

const client = replicateLDES({
  url: "https://example.org/ldes",
  fetch: enhanced_fetch({
    concurrent: 4,
    retry: { codes: [408, 425, 429, 500, 502, 503, 504], maxRetries: 5 },
  }),
});
```

### Caching of JSON-LD contexts

Pages are never cached, as an LDES page is not requested twice in a run (use `statePath` to have the client revalidate pages with their `ETag` on a next run). The external JSON-LD contexts that pages refer to (for example `https://schema.org`) are cached, as all pages share them. The cache follows [HTTP caching semantics](https://www.rfc-editor.org/rfc/rfc9111) (`Cache-Control`, `Expires`, `Vary`, revalidation with `ETag`/`Last-Modified`) through [ldfetch](https://github.com/pietercolpaert/ldfetch#http-caching), but keeps a context for at least 10 minutes (`minTTL`) because contexts are often served without useful cache headers. `Cache-Control: no-store` is always honoured.

```js
replicateLDES({
  url: "https://example.org/ldes",
  // seconds; also `maxTTL` and `store` (anything with get/set/delete, e.g. a disk-backed store), or `false` to disable
  contextCache: { minTTL: 3600 },
});
```

### Supported runtimes

The client runs on Node.js, in the browser and on Cloudflare Workers (workerd). We make sure that it keeps running on Cloudflare Workers: a CI job (`test-worker`) runs the built package in workerd, so that a change that breaks it fails the build. To keep it working, the core does not depend on the filesystem, native modules or process signals: LevelDB and Winston are only loaded where they are available, state goes through the pluggable `Storage` interface (see [State Management](#state-management)), and network access goes through `fetch`. A change that cannot keep this must say so in the pull request and in [CHANGELOG.md](CHANGELOG.md).

## RDF-Connect

The package exposes `rdfc:LdesClient` as an [RDF-Connect](https://rdf-connect.github.io/) processor. This example defines a following client that writes to the `<members>` channel; connect a downstream reader to consume it.

```turtle
@prefix rdfc: <https://w3id.org/rdf-connect#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

<> owl:imports <./node_modules/@rdfc/js-runner/index.ttl>,
               <./node_modules/ldes-client/processor.ttl> .

<members> a rdfc:Reader, rdfc:Writer .

<> a rdfc:Pipeline;
    rdfc:consistsOf [
        rdfc:instantiates rdfc:NodeRunner;
        rdfc:processor <ldes-client>
    ] .

<ldes-client> a rdfc:LdesClient;
    rdfc:url <https://example.org/ldes>;
    rdfc:output <members>;
    rdfc:follow true .
```

See [processor.ttl](processor.ttl) for configuration properties and [lib/rdfc-processor.ts](lib/rdfc-processor.ts) for the implementation.

## LDES 2.0

The same CLI and library entry point support LDES 1.0 and the [LDES 2.0 proposal](https://github.com/SEMICeu/LinkedDataEventStreams/pull/116). The client logs a warning when reading an LDES 2.0.

The experimental LDES 2.0 engine:

- Reads streaming RDF Message Logs in TriG, N-Quads, N-Triples and Turtle, and Jelly-RDF, including gzip-compressed input. NDJSON-LD is not supported. A document without message boundaries is treated as one message.
- Identifies members using `ldes:member`, `ldes:memberGraph`, `ldes:memberType` or `ldes:memberPath`, preserving every quad in the member message.
- Merges sorted pages using `ldes:timestampPath` and `ldes:sequencePath`, or implicit page numbers and member positions.
- Saves a bookmark for resuming, skips pages before it, and remembers completed immutable leaf pages.
- Applies timestamp bounds and conditions to members, and prunes relations or the remainder of a page when their ordering bounds rule out matches. A `MaxCountCondition` stops traversal at the requested count.

For timestamps without a timezone, an explicit configured offset such as `+01:00` or `Z` takes precedence over `ldes:defaultTimezone`. Without either, comparisons account for the unknown timezone. The CLI default `AoE` is not an explicit offset. When the LDES declares `ldes:pollingInterval`, that value determines the polling interval; otherwise the configured `pollInterval` is used.

ETag revalidation (`If-None-Match`) and the ordering rule for members that finalize a transaction are not yet implemented for LDES 2.0. HTTP fetching and RDF parsing use [ldfetch](https://github.com/pietercolpaert/ldfetch).

### Prefetching pages

The client requests upcoming pages before the merge needs them, up to `--concurrent` / `concurrentFetches` (default `10`). Pages skipped by the bookmark or immutable-page state are not requested. Limited message buffering and backpressure keep prefetching from reading entire large pages into memory. Unused prefetched pages are closed when the consumer stops.

Use `--concurrent 1` to read pages one at a time. See [the performance guide](perf/README.md) for throughput and page-latency benchmarks, methodology, and CI regression checks.

### RiverBench example

[examples/riverbench/root.trig](examples/riverbench/root.trig) describes an LDES 2.0 over the first 10,000 graphs of the RiverBench `assist-iot-weather-graphs` dataset, using its Jelly-RDF distribution as a data page:

```sh
ldes-client examples/riverbench/root.trig
```

The example uses named-graph membership, timestamp ordering and an immutable data page. [catalog.ttl](examples/riverbench/catalog.ttl) contains the dataset metadata. Reading it requires network access.

### State Management

By default, the client stores progress with Level. Set `statePath` to keep that
state between client instances. Without a path, Level uses temporary storage.
Existing `statePath` and `startFresh` options continue to work.

Custom storage can return a promise from `init(fresh)`: the client waits for it
before creating stores. When using an adapter directly, await `storage.init()`
or `storage.init(true)` before accessing it; `true` clears saved client state.

Applications can provide a `Storage` implementation through the `storage` config
option. Injected storage enables resume tracking even without `statePath`.
`startFresh: true` clears the adapter's client state before replication starts.

`MemoryStorage` keeps state while the same adapter instance is reused:

```typescript
import { replicateLDES, MemoryStorage } from "ldes-client";

const storage = new MemoryStorage();
const client = replicateLDES({ url, storage });
```

Cloudflare Workers can persist state in a SQLite-backed Durable Object:

```typescript
import { replicateLDES } from "ldes-client";
import { DOSqliteStorage } from "ldes-client/storage/do-sqlite";

const storage = new DOSqliteStorage(ctx.storage, "orders_ldes_state");
const client = replicateLDES({ url, storage });
```

Enable `nodejs_compat` for the client dependencies. The default table is
`ldes_client_storage`. Pass a separate table name as the second constructor
argument for each independent replication in the same Durable Object.
`startFresh` clears the adapter's entire table, including state from any other
client using it. Reuse the same table name when resuming a replication. Closing
a client leaves saved Durable Object and memory state available for the next run.

See `test-worker/` for a runnable local integration fixture. Run
`npm run build`, then `cd test-worker && npm ci && npm test`.
The optional `test:preview` command deploys temporary Workers to your Cloudflare
account and requires credentials; it is separate from local tests.

## Conditions

Pass `--condition condition.ttl` to filter members with a Turtle condition. The condition's subject must be the file itself (`<>`). Conditions apply to both LDES versions. A condition can prune page traversal when its path matches the relation's `tree:path` in LDES 1.0, or the stream's `ldes:timestampPath` in LDES 2.0; other paths only filter members.

### Simple comparison

```turtle
@prefix csp: <http://vocab.deri.ie/csp#> .
@prefix tree: <https://w3id.org/tree#> .
@prefix sosa: <http://www.w3.org/ns/sosa/> .

<> a csp:Condition;
    tree:relationType tree:GreaterThanOrEqualToRelation;
    tree:path sosa:resultTime;
    tree:value "2026-01-01T00:00:00Z";
    tree:compareType "date" .
```

### Combine conditions

Use `csp:And` with `csp:and` for an intersection, or `csp:Or` with `csp:or` for a union. For example, this selects timestamps in `[2026-01-01, 2026-02-01)`:

```turtle
@prefix csp: <http://vocab.deri.ie/csp#> .
@prefix tree: <https://w3id.org/tree#> .
@prefix sosa: <http://www.w3.org/ns/sosa/> .

<> a csp:And;
    csp:and [
        a csp:Condition;
        tree:relationType tree:GreaterThanOrEqualToRelation;
        tree:path sosa:resultTime;
        tree:value "2026-01-01T00:00:00Z";
        tree:compareType "date"
    ], [
        a csp:Condition;
        tree:relationType tree:LessThanRelation;
        tree:path sosa:resultTime;
        tree:value "2026-02-01T00:00:00Z";
        tree:compareType "date"
    ] .
```

`tree:compareType` accepts `string`, `date`, `integer` or `float`. Conditions also support SHACL property paths; see [the condition implementation](lib/condition/condition.ts) and [its shapes](lib/condition/shapes.ts).

## Development

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

Additional checks:

| Command | Purpose |
| --- | --- |
| `npm run test:browser` | Browser tests using Playwright and Chromium. Install Chromium first with `npx playwright install chromium`. |
| `npm run build && cd test-worker && npm ci && npm test` | Integration tests in a local Cloudflare Workers runtime (workerd). |
| `npm run test:conformance` | External LDES 1.0 conformance suite. |
| `npx vitest run tests/ldes2` | LDES 2.0 integration tests against local mock servers. Add `RIVERBENCH=1` to include the network test. |
| `npm run test:perf` | Benchmark statistics and regression-check tests. |
| `npm run perf -- --output reports/perf/current.json` | Local replication benchmark; see [perf/README.md](perf/README.md). |
| `npm run format` | Format TypeScript sources. |

Conformance testing uses `../ldes-client-conformance-test-suite`, cloning it if absent and respecting an existing checkout. Reports are written to `reports/conformance/`. Use `npm run test:conformance -- --no-fail` to generate reports without failing on conformance results.

CI runs lint, type checking, Node.js and browser tests, the Cloudflare Workers (workerd) integration tests in `test-worker/`, conformance checks, and performance regression checks. Performance checks also run on pull requests, comparing the proposed code with its base commit; see [the performance workflow](.github/workflows/perf-test.yml). Husky and lint-staged run checks on staged files before commits. Update [CHANGELOG.md](CHANGELOG.md) for releases; `npm publish` builds the package first.

### Source layout

[lib/client.ts](lib/client.ts) detects the LDES version and exposes the public API. [lib/ldes1](lib/ldes1) implements TREE traversal and member extraction; [lib/ldes2](lib/ldes2) implements message-log traversal and merging. The engines share [conditions](lib/condition), [fetching](lib/fetcher), [utilities](lib/utils) and [types](lib/types.ts).

## License

© 2026 Ghent University – IMEC. MIT license.
