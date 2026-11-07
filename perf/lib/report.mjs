// Compare only matching layouts and formats measured on the same runner.
export function quantile(values, fraction) {
    const sorted = values.toSorted((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    return (
        sorted[lower] +
        (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
    );
}

export function summarize(cases, samples, repeats, members) {
    return cases.map((scenario) => {
        const runs = samples.filter((r) => r.id === scenario.id);
        if (
            runs.length !== repeats ||
            runs.some(
                (r) =>
                    r.members !== members ||
                    !Number.isFinite(r.seconds) ||
                    r.seconds <= 0 ||
                    !Number.isFinite(r.firstMemberSeconds) ||
                    r.firstMemberSeconds < 0 ||
                    r.firstMemberSeconds > r.seconds ||
                    !Number.isFinite(r.peakRss) ||
                    r.peakRss <= 0,
            )
        ) {
            throw new Error(
                `Incomplete or invalid measurements: ${scenario.id}`,
            );
        }
        const times = runs.map((r) => r.seconds);
        const seconds = quantile(times, 0.5);
        return {
            id: scenario.id,
            layout: scenario.layout,
            format: scenario.format,
            client: scenario.client,
            seconds,
            minSeconds: Math.min(...times),
            maxSeconds: Math.max(...times),
            lowerQuartile: quantile(times, 0.25),
            upperQuartile: quantile(times, 0.75),
            membersPerSecond: members / seconds,
            firstMemberSeconds: quantile(
                runs.map((r) => r.firstMemberSeconds),
                0.5,
            ),
            peakRssMiB: quantile(
                runs.map((r) => r.peakRss / 1048576),
                0.5,
            ),
            responseBytes: scenario.responseBytes,
        };
    });
}

export function compare(summary, threshold) {
    return summary
        .filter((r) => r.client === "current")
        .map((current) => {
            const baseline = summary.find(
                (r) =>
                    r.client === "baseline" &&
                    r.format === current.format &&
                    r.layout === current.layout,
            );
            if (!baseline) return { id: current.id, status: "no baseline" };
            const slowdownPercent =
                (current.seconds / baseline.seconds - 1) * 100;
            // A median shift alone can be an outlier on shared CI runners. Require the middle 50% of timings to separate too.
            const separated = current.lowerQuartile > baseline.upperQuartile;
            return {
                id: current.id,
                baselineId: baseline.id,
                slowdownPercent,
                status:
                    slowdownPercent > threshold
                        ? separated
                            ? "regression"
                            : "noisy slowdown"
                        : "pass",
            };
        });
}

export function markdown(result) {
    const { metadata: m, summary, comparisons, error } = result;
    const lines = [
        `## LDES replication: ${m.delayMs} ms/page`,
        "",
        `${m.members.toLocaleString("en-US")} members × 8 triples; ${m.repeats} measured rounds; ordered: \`${m.ordered}\`.`,
        `Current: \`${m.branchCommit || "unknown"}\`; baseline: \`${m.baselineCommit || "none"}\`.`,
        "",
    ];
    if (error)
        lines.push(
            `**Benchmark failed:** ${error.replaceAll("\n", " ").replaceAll("|", "\\|")}`,
            "",
        );
    if (summary.length) {
        lines.push(
            "| Data pages × members/page | Format | Client | Median (s) | Range (s) | Members/s | First member (ms) | Peak RSS (MiB) | Change in time |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ",
        );
        for (const r of summary) {
            const comparison = comparisons.find((c) => c.id === r.id);
            const change = !comparison
                ? "—"
                : comparison.slowdownPercent === undefined
                  ? "no baseline"
                  : `${comparison.slowdownPercent >= 0 ? "+" : ""}${comparison.slowdownPercent.toFixed(1)}% (${comparison.status})`;
            lines.push(
                `| ${r.layout} | ${r.format} | ${r.client} | ${r.seconds.toFixed(3)} | ${r.minSeconds.toFixed(3)}–${r.maxSeconds.toFixed(3)} | ${Math.round(r.membersPerSecond).toLocaleString("en-US")} | ${(r.firstMemberSeconds * 1000).toFixed(0)} | ${r.peakRssMiB.toFixed(0)} | ${change} |`,
            );
        }
    }
    lines.push(
        "",
        `Regression threshold: >${m.regressionPercent}% longer median replication time with non-overlapping middle 50% of samples.`,
        "Local HTTP; no compression; imports, full RDF verification and output storage excluded from timing. Each replication uses a fresh process. Peak RSS includes imports and excludes the server.",
        "",
    );
    return lines.join("\n");
}

// Stable names let github-action-benchmark keep independent histories for each format and layout.
export function history(result) {
    return result.summary
        .filter((r) => r.client === "current")
        .map((r) => ({
            name: `${r.format} / ${result.metadata.members} members / ${r.layout} / ${result.metadata.delayMs}ms / ${result.metadata.ordered}`,
            unit: "members/s",
            value: r.membersPerSecond,
            extra: `Median of ${result.metadata.repeats} runs; range ${r.minSeconds.toFixed(3)}–${r.maxSeconds.toFixed(3)} s`,
        }));
}
