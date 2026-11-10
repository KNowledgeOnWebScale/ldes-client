import assert from "node:assert/strict";
import test from "node:test";
import { compare, history, markdown, summarize } from "../lib/report.mjs";

const scenario = (client, format = "ldes1") => ({
    id: `${format}/${client}`,
    client,
    format,
    layout: "1 × 100",
    responseBytes: 1000,
});
const runs = (c, times) =>
    times.map((seconds, round) => ({
        id: c.id,
        seconds,
        round: round + 1,
        members: 100,
        firstMemberSeconds: seconds / 2,
        peakRss: 104857600,
    }));
function result(baseTimes, currentTimes, format = "ldes1") {
    const cases = [scenario("baseline", format), scenario("current", format)];
    return summarize(cases, [...runs(cases[0], baseTimes), ...runs(cases[1], currentTimes)], 5, 100);
}

test("median throughput resists one slow outlier", () => {
    const [r] = summarize([scenario("current")], runs(scenario("current"), [1, 1, 1, 1, 100]), 5, 100);
    assert.equal(r.seconds, 1);
    assert.equal(r.membersPerSecond, 100);
    assert.equal(r.maxSeconds, 100);
});

test("incomplete runs or missing members cannot look like a speedup", () => {
    assert.throws(() => summarize([scenario("current")], [], 5, 100), /Incomplete/);
    const samples = runs(scenario("current"), [1, 1, 1, 1, 1]);
    samples[0].members = 99;
    assert.throws(() => summarize([scenario("current")], samples, 5, 100), /invalid/);
});

test("non-finite timings and memory measurements fail validation", () => {
    for (const field of ["seconds", "firstMemberSeconds", "peakRss"]) {
        const samples = runs(scenario("current"), [1, 1, 1, 1, 1]);
        samples[0][field] = Infinity;
        assert.throws(() => summarize([scenario("current")], samples, 5, 100), /invalid/);
    }
});

test("stable slowdowns over 25% fail for each matching format", () => {
    for (const format of ["ldes1", "trig", "jelly"]) {
        const [r] = compare(result([1, 1, 1, 1, 1], [1.3, 1.3, 1.3, 1.3, 1.3], format), 25);
        assert.equal(r.status, "regression");
        assert.ok(Math.abs(r.slowdownPercent - 30) < 0.001);
    }
});

test("improvements and the threshold boundary pass", () => {
    assert.equal(compare(result([1, 1, 1, 1, 1], [0.5, 0.5, 0.5, 0.5, 0.5]), 25)[0].status, "pass");
    assert.equal(compare(result([1, 1, 1, 1, 1], [1.25, 1.25, 1.25, 1.25, 1.25]), 25)[0].status, "pass");
});

test("overlapping middle quartiles are reported as noise instead of failing", () => {
    assert.equal(compare(result([0.5, 0.5, 1, 2, 2], [1, 1, 1.5, 1.5, 2]), 25)[0].status, "noisy slowdown");
});

test("new formats are not compared against another format", () => {
    const summary = result([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]);
    summary.push({ ...summary[1], id: "trig/current", format: "trig" });
    assert.equal(compare(summary, 25)[1].status, "no baseline");
});

test("history contains only current throughput and identifies workload changes", () => {
    const data = {
        metadata: { members: 100, delayMs: 50, ordered: "none", repeats: 5 },
        summary: result([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]),
    };
    const series = history(data);
    assert.equal(series.length, 1);
    assert.equal(series[0].value, 100);
    assert.equal(series[0].unit, "members/s");
    assert.match(series[0].name, /100 members.*50ms.*none/);
});

test("a failed run is explicit in the Actions summary", () => {
    const report = markdown({
        metadata: {
            members: 100,
            delayMs: 0,
            repeats: 5,
            regressionPercent: 25,
        },
        summary: [],
        comparisons: [],
        error: "missing member",
    });
    assert.match(report, /Benchmark failed.*missing member/);
});
