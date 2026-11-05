# LDES replication performance comparison

Measured on 2026-11-05 using the same 20,000 synthetic members (160,000 member triples) in every case. Each member has a timestamp, scalar properties and one nested blank node. Every case passed a separate full RDF content check; every timed run emitted exactly 20,000 unique members with 8 triples each.

Baseline: `origin/main` at `e3b3c44a729ca89d345fe7abccfee0a66726d933` (the local tracking ref when measured). Branch: `experiment-ldes-2.0` at `c97b56928c28fdbd90fb5bf04427b12b5c805131`. Each uses its own lockfile dependencies and a fresh build.

Node.js v25.9.0, 12th Gen Intel(R) Core(TM) i7-1265U, linux 6.8.0-146-generic x64. Default client configuration, `ordered: none`, stream high-water mark 100, no saved state, no polling. LDES 2.0 still preserves stream order; LDES 1.0 is allowed to emit unordered. This is a default replication comparison.

The server runs on loopback, without compression or artificial latency, with documents generated before measurement. Timing includes client construction, fetching, parsing, extraction and consuming all members into a counting sink; it excludes module imports, full RDF validation and writing output. Each measurement is a fresh process. One unreported warmup per case precedes five measured rounds, with case order rotated between rounds. Values below are medians of those five runs.

## PR-ready replication timings

| Data pages × members/page | Main: LDES 1.0 Turtle | Branch: LDES 1.0 Turtle | Branch: LDES 2.0 TriG messages | Branch: LDES 2.0 Jelly |
| --- | ---: | ---: | ---: | ---: |
| 200 × 100 | 1.479 s | 1.310 s | 0.503 s | 0.482 s |
| 20 × 1000 | 1.963 s | 1.232 s | 0.404 s | 0.335 s |
| 4 × 5000 | 7.188 s | 1.311 s | 0.391 s | 0.329 s |
| 1 × 20000 | 34.889 s | 1.808 s | 0.398 s | 0.295 s |

Paged layouts have one additional description/root document. The single-page layout includes the description in the data page.

| Layout | Branch 1.0 vs main 1.0 | Branch TriG vs main 1.0 | Branch Jelly vs main 1.0 |
| --- | ---: | ---: | ---: |
| 200 × 100 | 1.13× | 2.94× | 3.07× |
| 20 × 1000 | 1.59× | 4.86× | 5.86× |
| 4 × 5000 | 5.48× | 18.39× | 21.88× |
| 1 × 20000 | 19.30× | 87.72× | 118.19× |

Ratios are baseline median time divided by the compared median time; values above 1 mean faster replication. These are local synthetic measurements, not network deployment predictions.

On the single-page layout, this branch's LDES 1.0 is **19.3× faster than main**. Switching from this branch's LDES 1.0 to LDES 2.0 is **4.55× faster with TriG** and **6.13× faster with Jelly**. Median peak RSS falls from 743 MiB to 188 MiB (TriG) or 183 MiB (Jelly). Jelly's uncompressed documents are larger than TriG's with these writer settings.

Suggested PR text:

> Replicating the same 20,000 members (160,000 triples) over local HTTP, this branch improves LDES 1.0 replication from 1.48 to 1.31 seconds with 100-member pages, and from 34.89 to 1.81 seconds with one 20,000-member page. For that single-page dataset, LDES 2.0 takes 0.398 seconds with TriG RDF Message Logs and 0.295 seconds with Jelly-RDF. These are medians of five fresh-process runs with default replication settings and no HTTP compression; all cases emit identical member data.

## Detailed measurements

| Layout | Client / format | Time range (s) | Members/s | First member (ms) | Peak RSS (MiB) | Encoded bodies (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 200 × 100 | baseline, LDES 1.0 | 1.327–1.570 | 13,518 | 104 | 376 | 3.70 |
| 200 × 100 | this branch, LDES 1.0 | 1.298–1.820 | 15,268 | 152 | 393 | 3.70 |
| 200 × 100 | branch, LDES 2.0 TriG | 0.485–0.519 | 39,745 | 54 | 190 | 3.62 |
| 200 × 100 | branch, LDES 2.0 Jelly | 0.466–0.547 | 41,483 | 65 | 184 | 3.79 |
| 20 × 1000 | baseline, LDES 1.0 | 1.912–2.021 | 10,190 | 145 | 420 | 3.61 |
| 20 × 1000 | this branch, LDES 1.0 | 1.120–1.265 | 16,237 | 493 | 459 | 3.61 |
| 20 × 1000 | branch, LDES 2.0 TriG | 0.382–0.420 | 49,497 | 50 | 193 | 3.56 |
| 20 × 1000 | branch, LDES 2.0 Jelly | 0.326–0.348 | 59,754 | 49 | 185 | 3.68 |
| 4 × 5000 | baseline, LDES 1.0 | 6.987–8.007 | 2,782 | 250 | 456 | 3.60 |
| 4 × 5000 | this branch, LDES 1.0 | 1.253–1.400 | 15,260 | 856 | 486 | 3.60 |
| 4 × 5000 | branch, LDES 2.0 TriG | 0.377–0.457 | 51,168 | 39 | 188 | 3.55 |
| 4 × 5000 | branch, LDES 2.0 Jelly | 0.308–0.478 | 60,869 | 47 | 176 | 3.69 |
| 1 × 20000 | baseline, LDES 1.0 | 33.867–36.952 | 573 | 1469 | 789 | 3.60 |
| 1 × 20000 | this branch, LDES 1.0 | 1.753–1.939 | 11,061 | 1328 | 743 | 3.60 |
| 1 × 20000 | branch, LDES 2.0 TriG | 0.379–0.452 | 50,286 | 46 | 188 | 3.55 |
| 1 × 20000 | branch, LDES 2.0 Jelly | 0.288–0.304 | 67,750 | 38 | 183 | 3.82 |

Peak RSS is the process high-water mark, including imports and excluding the separate server. Encoded body sizes sum each document once, excluding HTTP headers. Turtle and TriG use prefixes; Jelly uses one frame per message with `packMessages: false`, writer defaults, and no outer compression. Different packing/dictionary/compression choices can affect Jelly's size and speed.

The raw [JSON measurements](ldes-comparison-none.json) include every timing and the machine/configuration metadata. See [the runner documentation](../README.md#methodology-and-regression-checks) for methodology and options.

## Reproduce

These results were collected with the runner before the performance-directory cleanup. Build the recorded commits with their respective lockfiles; the current runner can reproduce the workload with:

```sh
node perf/compare-versions.mjs --baseline /tmp/ldes-client-main \
  --members 20000 --page-sizes 100,1000,5000,20000 \
  --baseline-formats ldes1 --ordered none --repeats 5 --warmups 1 --timeout 60 \
  --output reports/perf/comparison.json
```

An exploratory ascending-order baseline run did not finish its initial validation and was interrupted. It is excluded from these measurements.
