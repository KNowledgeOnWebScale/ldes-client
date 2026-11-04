# Performance tests for the LDES client

## Datasets

TODO 

## Tests

Special flags cannot be used in the tests. An LDES client MUST be able to work without any extra information.

### 1. Replication velocity

Client config:
 1. Unordered
 2. Ordered

###  2. From an existing state, catch up with a feed

Pre-configures a state on different existing LDESes, and tests performance of catching up with the feed.

### LDES 1.0 and LDES 2.0 with the same pagination

`perftest.js` runs every test on a tree of 14 pages (depth 3, width 3) with the same members in the LDES 1.0 and in the LDES 2.0 form:

| test | pages | members | delay per page |
| --- | --- | --- | --- |
| `tree-3-3`, `ldes2-tree-3-3` | 14 | 130 | 50 ms |
| `tree-3-3-nodelay`, `ldes2-tree-3-3-nodelay` | 14 | 1300 | none |

The first pair shows the effect of the latency of the pages, the second the cost of the client itself.
The LDES 1.0 tree is a `tree:relation` tree with Turtle pages ([tests/helper.ts](../tests/helper.ts)). The LDES 2.0 tree ([ldes2Tree.js](ldes2Tree.js)) has RDF Message logs in TriG as pages. A page has a description message with `ldes:relation`s to its child pages,
with the sequence interval of all the members below the child, followed by one member message per member. The member number is the sequence (`ldes:sequencePath`).
Every test checks that the client emitted all the members.

The LDES 2.0 client requests the pages that it follows next ahead of time (as many as `concurrentFetches`, default 10). With `concurrentFetches: 1` the pages are read one by one, which takes about 14 × 50 ms; with the default, it takes about as long as the LDES 1.0 client, which fetches pages concurrently.

### 3. Performance result
Locates at: [https://treecg.github.io/ldes-client/](https://treecg.github.io/ldes-client/)

### Comparing versions: `compare-versions.mjs`

A quick check that replicates the same members with a baseline build of the client (for example `main`) over an LDES 1.0, with this build over the same LDES 1.0, and with this build over the same members as an LDES 2.0. Every case runs in its own process against a local server, in two layouts: paged, and everything in one very large page. It reports the time, members per second, peak memory and the longest time that the event loop was blocked.

```bash
npm run build
git worktree add ../ldes-client-main origin/main && (cd ../ldes-client-main && npm ci && npm run build)
node perf/compare-versions.mjs --baseline ../ldes-client-main --members 10000 --page-size 1000
```

Options: `--members`, `--page-size`, `--ordered none|ascending|descending` and `--timeout` (seconds, per case). Without `--baseline`, only this build is measured. A baseline cannot read an LDES 2.0, so that case is only run for this build. Run it a few times before drawing conclusions: it is a single measurement per case.
