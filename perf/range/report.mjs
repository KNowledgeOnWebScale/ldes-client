/**
 * Markdown tables of the results of perf/range/bench.mjs.
 *
 *   node perf/range/report.mjs reports/perf/range-n10k-a10.json [...more]
 */
import fs from "node:fs";

const kb = (bytes) =>
    bytes >= 10_240 ? `${(bytes / 1024).toFixed(0)} KB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes.toFixed(0)} B`;
const ms = (value) => value.toFixed(1);

for (const file of process.argv.slice(2)) {
    const { params, results } = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(
        `\n**${params.initial.toLocaleString("en")} members, ${params.append} appended per cycle, ${params.cycles} cycles` +
            `${params.delay ? `, ${params.delay} ms latency` : ""}** (head pages of ${params.headSize})\n`,
    );
    console.log(
        "| Strategy | Initial sync | Per cycle: wire bytes | body bytes/member | requests | client CPU ms | CDN gzip ms | wall ms | Client state | Correct |",
    );
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|");
    for (const { summary: s } of results) {
        console.log(
            `| ${s.strategy} | ${kb(s.initialBytes)} | ${kb(s.wireBytesPerCycle ?? s.bytesPerCycle)} | ${kb(s.bytesPerMember)} | ${s.requestsPerCycle.toFixed(1)} | ` +
                `${ms(s.clientCpuMsPerCycle)} | ${ms(s.compressMsPerCycle)} | ${ms(s.wallMsPerCycle)} | ${kb(s.stateBytes)} | ${s.correct ? "yes" : "**no**"} |`,
        );
    }
}
