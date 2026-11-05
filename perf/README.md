# Replication benchmarks

One runner, [compare-versions.mjs](compare-versions.mjs), measures replication over local HTTP with identical member data in three formats:

| Format | Pages |
| --- | --- |
| `ldes1` | LDES 1.0 in Turtle, with TREE membership and relations |
| `trig` | LDES 2.0 RDF Message Logs in TriG, one message per member |
| `jelly` | The same LDES 2.0 messages in Jelly-RDF, one frame per message |

Each member has eight triples: a type, timestamp, scalar properties and a nested blank node. Paged layouts have one additional root document; a single-page layout includes the description with the members. Fixtures and Jelly encoding are generated before measurement. No HTTP compression is used.

## Run locally

Use Node.js 24 or newer and build the client first:

```sh
npm ci
npm run build
npm run perf -- --output reports/perf/current.json
```

The default workload replicates 20,000 members with page sizes of 100, 1,000, 5,000 and 20,000, using one warmup and five measured rounds per case. The console report includes throughput, elapsed time, time to first member and peak RSS. Generated output belongs in the ignored `reports/perf/` directory. The earlier PR measurements remain in [results/README.md](results/README.md), with their original raw samples.

To compare builds, prepare a baseline with its own lockfile dependencies:

```sh
git worktree add /tmp/ldes-client-main origin/main
(cd /tmp/ldes-client-main && npm ci && npm run build)
npm run perf -- --baseline /tmp/ldes-client-main \
  --members 10000 --page-sizes 100,1000,10000 \
  --fail-on-regression 25 --output reports/perf/comparison.json
```

The current and baseline builds read exactly the same endpoints. A baseline containing `dist/lib/ldes2/index.js` is measured in all three formats; older builds are measured only in LDES 1.0. Override this detection with `--baseline-formats ldes1|all` when comparing a differently structured build. New formats are reported without a baseline and do not count as regressions.

Add `--delay 50` to simulate 50 ms of server latency on every request. For a quick correctness smoke run, use `--members 100 --page-sizes 25,100 --repeats 1 --warmups 0` without a regression gate.

## Methodology and regression checks

Every replication runs in a fresh child process; the HTTP server holds pre-generated responses in a separate process. Each case first passes a full RDF content check. Timed runs also verify every member ID, duplicates, member count and triple count. Missing data, failed requests, malformed measurements and timeouts fail the run.

Timing starts after module imports, immediately before client construction, and ends when the stream is exhausted. It includes fetching, parsing, extraction, lightweight count checks and consumption into a counting sink. It excludes full RDF verification, fixture generation and output storage. Peak RSS includes imports and excludes server memory. Encoded body sizes sum each document once and exclude HTTP headers.

One unreported warmup per case precedes five measured rounds. Processes are fresh, so warmups warm system caches rather than retaining a JIT-warmed client. Case order rotates across rounds to spread drift. Client configuration uses defaults, with stream high-water mark 100. Default `ordered: none` allows unordered LDES 1.0 output; LDES 2.0 retains stream order. Ordered workloads are selectable but are separate comparisons.

`--fail-on-regression 25` fails when a matching format and layout has both:

- A median replication time more than 25% longer than the baseline.
- A lower quartile above the baseline's upper quartile, so the middle 50% of timing samples do not overlap.

This gate requires a baseline and at least five measured rounds. An overlapping slowdown appears as `noisy slowdown` in the report and warrants a rerun. Memory and first-member latency are reported but do not gate CI. Local synthetic results describe replication cost; member complexity, compression, network conditions and downstream work affect deployment throughput.

## GitHub Actions

[perf-test.yml](../.github/workflows/perf-test.yml) runs on pull requests, pushes to `main`, and manual dispatches. PR runs benchmark the proposed merge against the PR's base commit; main pushes compare against the pre-push commit; manual runs compare against the previous commit. Both builds use their own dependencies and run sequentially on the same Node.js 24 runner.

CI runs two workloads, each with a warmup and five measured rounds:

| Workload | Members | Members/page | Delay/request |
| --- | ---: | --- | ---: |
| Replication | 10,000 | 100, 1,000, 10,000 | none |
| Page latency | 1,000 | 100 | 50 ms |

All available formats are checked against their matching baseline. The 25% gate above determines pass/fail. Both workloads run even if one fails. Job summaries show comparisons; the `performance-results` artifact retains raw samples and configuration for 30 days, including diagnostic output on benchmark failure.

PR jobs use read-only repository permissions and work for forks without a write token or comment permissions. After a successful main push, a separate job publishes throughput history to the existing [dashboard](https://treecg.github.io/ldes-client/docs/), using `gh-pages:docs/`. The HTTP workloads start new series named by format, member count, page size, request delay and ordering; older mock Benchmark.js series remain historical. Historical results from different runners do not determine pass/fail.

## Options and files

| Option | Default / purpose |
| --- | --- |
| `--baseline PATH` | Optional baseline checkout with a built `dist/` |
| `--baseline-commit SHA` | Record the commit for an archived baseline without `.git` |
| `--baseline-formats auto\|ldes1\|all` | `auto`; see capability detection above |
| `--members N` | `20000` |
| `--page-sizes N,N,...` | `100,1000,5000,20000`; sizes are capped at the member count |
| `--page-size N` | Legacy shorthand for size N plus a single-page layout |
| `--ordered none\|ascending\|descending` | `none` |
| `--repeats N` / `--warmups N` | `5` / `1` |
| `--delay MS` | `0`; delay each HTTP response |
| `--timeout SECONDS` | `120` per replication |
| `--fail-on-regression PERCENT` | Optional failure gate; reports use 25% by default |
| `--output FILE` | JSON metadata, samples, summaries, comparisons and errors |
| `--summary FILE` | Append a Markdown report, including `$GITHUB_STEP_SUMMARY` |
| `--benchmark-output FILE` | Current throughput in github-action-benchmark JSON format |

`LDES_CLIENT_CONFIG` accepts additional client configuration as JSON and is recorded in the result. Use consistent settings across comparisons.

`lib/fixtures.mjs` generates the data; `lib/replicate.mjs` measures one child process; `lib/report.mjs` computes statistics and reports. Run `npm run test:perf` to check aggregation, regression decisions and report output.
