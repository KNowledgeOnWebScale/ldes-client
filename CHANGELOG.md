# Changelog

All notable changes of the `ldes-client` package. The support for LDES 1.0 is stable.
**The support for LDES 2.0 is experimental:** it follows the latest proposals of the LDES 2.0 trajectory
([SEMICeu/LinkedDataEventStreams#116](https://github.com/SEMICeu/LinkedDataEventStreams/pull/116) and its successors),
and changes with them. Such changes can be made in any release, also when they are not backwards compatible,
and they are listed under *LDES 2.0 (experimental)* in every release. Pin the version of this package if you depend on it.

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

- A condition on one property was compared with the range of a relation on another property when both were plain IRIs,
  so that relations were wrongly not followed (`cbdEquals`). This affected LDES 1.0 as well.
- Fixes for the LDES1.0 conformance test suite: more complex SHACL paths, `ldes:pollingInterval`, transactions, retry base, and
  the prefixes that are missing or unused (#145, #146, #147, #149, #150).
- ESLint loads its configuration again (missing dev dependencies), the errors it reports are fixed (#157), and the
  `minimatch` advisory GHSA-g3hv-75wg-m249 is resolved (`npm audit` reports no vulnerabilities).
