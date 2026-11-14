# Changelog

All notable changes of the `ldes-client` package. The support for LDES 1.0 is stable.
**The support for LDES 2.0 is experimental:** it follows the latest proposals of the LDES 2.0 trajectory
([SEMICeu/LinkedDataEventStreams#116](https://github.com/SEMICeu/LinkedDataEventStreams/pull/116) and its successors),
and changes with them. Such changes can be made in any release, also when they are not backwards compatible,
and they are listed under *LDES 2.0 (experimental)* in every release. Pin the version of this package if you depend on it.

## Unreleased

- External JSON-LD contexts are cached following HTTP caching semantics (using the HTTP cache and the context loader of ldfetch 1.3.10) with a
  minimum TTL of 10 minutes, instead of a fixed TTL that ignored the cache headers. Stale contexts are revalidated with
  `ETag`/`Last-Modified`, and `Cache-Control: no-store` is honoured. Configure it with the new `contextCache` option
  (`minTTL`, `maxTTL`, `store`, or `false`). Pages are still not cached
  ([#32](https://github.com/KNowledgeOnWebScale/ldes-client/issues/32)).
- A page of which the server drops the connection after it sent a successful response and a part of the body is requested
  again, instead of failing the replication with `TypeError: terminated`. This holds for LDES 1.0 and LDES 2.0: in an
  LDES 2.0 the client continues after the members that it read already, and it fails when the page has changed in between.
  The schedule is that of the retries of HTTP codes (`--retry-count`, or `transferRetry` in the library). When a page keeps
  being interrupted, the error names the page. Errors are logged with their message, instead of `{}`
  ([#107](https://github.com/KNowledgeOnWebScale/ldes-client/issues/107)).

- A member is emitted when the consumer of the stream has read it, and not when it is put in the buffer of the stream: the state
  (the members that were emitted, the pages that were finished, the bookmark of an LDES 2.0) is updated then. A consumer that stops
  with members in the buffer used to lose them, as the next run took them for emitted, which happened with every hierarchy of pages
  (the Rijksmuseum and MINT shapes) and now no longer does. No member is lost or emitted twice when a replication is interrupted
  again and again, for LDES 1.0 (unordered and ordered) and LDES 2.0. The stream that `stream()` returns has a buffer of its own that
  has the `highWaterMark`, behind a stream that has none: it ends after the client has closed, and the state can be opened then
  ([#170](https://github.com/KNowledgeOnWebScale/ldes-client/issues/170)).
- A saved state resumes a linked list of pages (OpenLDES `by-page`): the root of such a list does not change, and the immutable first
  page is skipped, so that the pages that were mutable when the run ended were never requested, and new members were not found.
  A new run starts at them, in the unordered and in the ordered strategy. A second run of the mock LDES requests the mutable pages of the first run now (3 fragments, where it was 1 or 2).
- A page of which the modulator index was shared with another page, because pages were pushed at the same time, overwrote it in the
  saved queue and was finished with it. That lost pages in interrupted replications, and in the ordered strategy emitted a member twice.
- A view without `tree:view` that is `dct:isPartOf` an `ldes:EventStream` (the root of an OpenLDES server such as Telraam's) is the view,
  and the LDES is described by the stream. A client that fails to start closes its state, so that the next client can open it, and work
  that was running when a client was closed does not fail with `Database is not open`. A closed client does not start requests that were queued.
- A page that two pages link to is requested once in a run, also when it is mutable, and so is the view page of an LDES of which the
  page that the client was given is not the view: it was requested twice. This holds for both strategies.
- Pages that can change are requested again with their `ETag`, and answered with a 304, in every poll and when a run resumes, in the
  ordered strategy of LDES 1.0 and in LDES 2.0 as well, as the unordered strategy did. The ETag in the state is the one of the version
  of which the consumer read the members. An LDES 2.0 has the ETag and the description message of such a page in its bookmark.
- A client that follows (`polling: true`) and has no `statePath` or `storage` keeps its state in memory. Without it, the unordered
  strategy requested every page again in every poll.
- `skipMissingPages` (`--skip-missing-pages`): skip a page of an LDES 1.0 that answers 404 with a warning, and do not request it again.
  By default, a 404 is an error, as the specification says, and as the page is in the state, so is every run after it. A server removes a
  page with 410. `HttpStatusError` is the error for a response with an error status.
- `perf/latency.mjs` measures the latency of a client that follows a growing feed, the replication of its history, and what a poll costs.

### LDES 2.0 (experimental)

- The bookmark of the state has `pages`: the ETag and the description message of the pages that can change, as they were when a run read
  them completely and the consumer had read all their members. It is saved when a run has finished, as `immutable` is, and the key
  and members of the bookmark are those of the members that the consumer has read.

## 0.4.0

### LDES 2.0 (experimental)

- First implementation of the draft of LDES 2.0. The client detects from the root page whether it reads an LDES 1.0 or
  an LDES 2.0, and the same CLI command and library call work for both. It logs a warning when it replicates an LDES 2.0.
- Pages are read as RDF Message logs, in a streaming way: TriG, N-Quads, N-Triples and Turtle (`VERSION "1.2-messages"`)
  and Jelly-RDF, also when gzipped. NDJSON-LD is not supported yet.
- Members are identified with `ldes:member`, `ldes:memberGraph`, `ldes:memberType` or `ldes:memberPath`, ordered on
  `ldes:timestampPath` and `ldes:sequencePath` or implicitly on page number and index, and traversed as a merge of
  sorted logs using the intervals of the `ldes:relation`s.
- The state is a small bookmark (the key of the last member and the identifiers of the members that share it), so a run
  with `--save` skips all pages before it without requesting them. Pages marked `ldes:immutable` are not fetched again
  once read completely.
- Timestamps without timezone are handled with the configured `defaultTimezone`, the `ldes:defaultTimezone` of the LDES,
  or as one unknown shared timezone.
- Pages are requested concurrently, ahead of when they are needed.
- Conditions (`--condition`, `MaxCountCondition`, ...) apply to an LDES 2.0 as well: they filter members, and relations and
  pages that cannot lead to wanted members are not followed, so a `MaxCountCondition` ends the traversal.
- Not implemented yet: ETag revalidation (`If-None-Match`) and the ordering rule for members that finalize a transaction.

### Added

- `--comment` (`-c`): print a comment before every member with what the LDES says about it (number, IRI, timestamp,
  sequence, version, type, transaction).
- `--format <format>`: the output of the CLI is an RDF Message log in TriG with one message per member (`trig-messages`, the default), or the quads of all members as N-Quads (`n-quads`).
- `npm run test:conformance` and a GitHub workflow that run the
  [ldes-client-conformance-test-suite](https://github.com/pietercolpaert/ldes-client-conformance-test-suite) (LDES 1.0).
- `allowUnsafeAmbiguousView` in the configuration (CLI compatibility mode: choose the first matching view when the
  discovery is ambiguous). The library leaves it disabled to remain compliant.

### Changed

- **BREAKING (RDF-Connect):** the default of `ordered` of the processor (`none`) and of the poll interval are now declared
  in `processor.ttl` with `sh:defaultValue`, which is only applied by `@rdfc/js-runner` >= 3.4.0. Update the runner together
  with this processor. The library and the CLI keep their own defaults.
- **BREAKING (library):** the default poll interval is 1000 ms (was 200 ms).
- **BREAKING (deep imports):** the LDES 1.0 engine moved to `lib/ldes1` (`strategy/` and the traversal part of `fetcher/`),
  and the types that both engines use (`Member`, `LDESInfo`, `FetchedPage`, ...) to `lib/types.ts`. The entry points of
  the package (`dist/lib/client.js` and `.cjs`) did not change.
- `npm run build` starts from an empty `dist`, so that files of an earlier layout are not published.
- `intoConfig` wraps the fetch function in `enhanced_fetch` (retries with backoff, per-domain concurrency limit).
- Dependencies: back to N3.js, `ldfetch` and `extract-cbd-shape` updated, `rdf-lens` ^2.1.0, `@rdfc/js-runner` ^3.4.0.

### Fixed

- The Dockerfile builds the CLI again. It asked for a `bun.lockb` that does not exist, and the `bun.lock` that it would have used
  was out of date, so that the build could not work. It is now a Node.js image that is built with `package-lock.json`, like
  CI does: the build stage compiles the sources, and the final image only has the compiled code and the production dependencies.
  The build context only has what the build needs.
- `intoConfig` keeps the default of an option that is passed as `undefined`, instead of replacing it with `undefined`. The
  RDF-Connect processor passes every option, so an option that the pipeline did not set lost its default: without
  `fetchConfig`, `concurrentFetches` became `undefined`, which turned off the prefetching of pages of an LDES 2.0.
- Extracting the members of a page of an LDES 1.0 is linear in the size of the page, instead of quadratic: the members of a
  page are extracted with one bulk extraction (`bulkExtract` of `extract-cbd-shape`), instead of one extraction per member that
  ignores the graphs of all other members. A page of 20 000 members is extracted in about 1 second, where it took close to a minute,
  and one of 40 000 members in 3 seconds, where it took 4 minutes. This solves the replication of very large pages that
  [#116](https://github.com/KNowledgeOnWebScale/ldes-client/pull/116) wanted to solve with a pool of worker threads.
- A condition on one property was compared with the range of a relation on another property when both were plain IRIs,
  so that relations were wrongly not followed (`cbdEquals`). This affected LDES 1.0 as well.
- Fixes for the LDES1.0 conformance test suite: more complex SHACL paths, `ldes:pollingInterval`, transactions, retry base, and
  the prefixes that are missing or unused (#145, #146, #147, #149, #150).
- ESLint loads its configuration again (missing dev dependencies), the errors it reports are fixed (#157), and the
  `minimatch` advisory GHSA-g3hv-75wg-m249 is resolved (`npm audit` reports no vulnerabilities).
