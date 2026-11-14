# The tests

Ha! The most exciting part of the repository! Welcome!

Looking for performance tests? Then you should check the [/perf](/perf) folder.

We’ve made tests for various parts of the LDES client:

## 1. LDES context

### 1.1 Given a URL, detect what’s the event stream and what’s the page IRI

 * Should work with `tree:view`, `dcterms:partOf` and `void:subset``
 * Should work with a URL after redirection

### 1.2 Shape

 * Should extract a SHACL shape when it’s embedded in the page
 * Should extract a SHACL shape when it’s described out of band but linked in the page

### 1.3 Retention policies on a view

 * Should be able to indicate there’s a retention policy and provide the triples as-is

## 2. Extracting members and sending them through the connector architecture

For the member extraction algorithm, we refer to the Extract CBD Shape algorithm’s repository.

## 3. Keeping the state

### 3.1 Keeping state using an HTTP bookkeeper

 * Should be able to replicate and later on synchronize
 * The state should use a LIFO approach after a configurable waterlevel

### 4.2 Keeping the state using a bookmark

This is only possible on LDESes that specifically document the `ldes:timestampPath`.

 * Should be able to replicate and later on synchronize using the documented bookmark


## 5. Resuming and following feeds published like real ones

The tests in [resume/](resume/) model four feeds as they are published (Marine Regions, the Rijksmuseum, MINT and an OpenLDES server such as Telraam's), and an LDES 2.0, on a server that logs the status code of every request ([resume/feedServer.ts](resume/feedServer.ts)). What they check is what happens at the start of a resumed replication and in every poll: which requests are made, and whether they work.

 * A second replication emits nothing, and requests no page that is immutable
 * A replication that resumes after the feed has grown, twice, emits only the new members: also for a linked list of pages of which only the last one grows
 * A replication that is interrupted again and again, with a stream that buffers 1, 7 or 10,000 members, emits every member once (`RESUME_STATS=1` counts it over 15 interrupted replications)
 * No page is requested twice in a replication, also when two pages link to it
 * A client that follows without a configured state does not request pages that are immutable again, and requests pages that can change with their `ETag`, in LDES 1.0 (unordered and ordered) and LDES 2.0
 * A page that was removed is an error (404) or an empty page (410), and the state of the client is not locked by the error
 * An entry that does not work (a redirect that is not valid any more) is an error, and the state is free for the next client

The two Marine Regions polling cases remain skipped because the fixture advertises a daily polling interval.

Two checks are opt-in:

 * `RESUME_STATS=1 npx vitest run tests/resume/interrupt-stats.test.ts` measures losses, duplicates and errors over 240 interrupted
   replications (four feeds, two orders, two buffer sizes, 15 repetitions). Its counts are written to `/tmp/resume-interrupt-stats.txt`
   by default, or to `EXPLORE_OUT`.
 * `RIVERBENCH=1 npx vitest run tests/ldes2/ldes2.test.ts -t 'the real RiverBench dataset'` downloads the live Jelly dataset and checks
   that it contains 10,000 members with 116 quads in the first member. This requires network access; an offline fixture runs by default.
