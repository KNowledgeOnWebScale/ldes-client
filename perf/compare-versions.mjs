// Replicate identical data across client builds and formats. See README.md for methodology and options.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createFixtures } from "./lib/fixtures.mjs";
import { compare, history, markdown, summarize } from "./lib/report.mjs";

const { values: options } = parseArgs({
    options: {
        baseline: { type: "string" },
        "baseline-commit": { type: "string" },
        "baseline-formats": { type: "string", default: "auto" },
        members: { type: "string", default: "20000" },
        "page-sizes": { type: "string" },
        "page-size": { type: "string" },
        ordered: { type: "string", default: "none" },
        repeats: { type: "string", default: "5" },
        warmups: { type: "string", default: "1" },
        timeout: { type: "string", default: "120" },
        delay: { type: "string", default: "0" },
        "fail-on-regression": { type: "string" },
        output: { type: "string" },
        summary: { type: "string" },
        "benchmark-output": { type: "string" },
    },
});
const members = Number(options.members);
const repeats = Number(options.repeats);
const warmups = Number(options.warmups);
const delayMs = Number(options.delay);
const timeoutMs = Number(options.timeout) * 1000;
const regressionPercent = Number(options["fail-on-regression"] ?? 25);
const pageSizes = [
    ...new Set(
        (options["page-sizes"] ?? (options["page-size"] ? `${options["page-size"]},${members}` : "100,1000,5000,20000")).split(",").map(Number),
    ),
];
if (
    ![members, repeats, ...pageSizes].every((v) => Number.isSafeInteger(v) && v > 0) ||
    ![warmups, delayMs].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(regressionPercent) ||
    regressionPercent <= 0
) {
    throw new Error("Members, sizes, repeats, timeout and regression threshold must be positive; warmups and delay must be non-negative integers");
}
if (!["none", "ascending", "descending"].includes(options.ordered)) throw new Error("Invalid --ordered value");
if (options["fail-on-regression"] && (!options.baseline || repeats < 5))
    throw new Error("Regression checks require --baseline and at least five repeats");
if (!["auto", "ldes1", "all"].includes(options["baseline-formats"])) throw new Error("Use --baseline-formats auto|ldes1|all");

const here = path.dirname(fileURLToPath(import.meta.url));
const current = path.resolve(here, "../dist");
const baseline = options.baseline && path.resolve(options.baseline, "dist");
for (const dist of [current, baseline].filter(Boolean)) {
    if (!existsSync(path.join(dist, "lib/client.js"))) throw new Error(`Build the client first: ${dist}`);
}
const baselineHasLdes2 =
    options["baseline-formats"] === "all" ||
    (options["baseline-formats"] === "auto" && baseline && existsSync(path.join(baseline, "lib/ldes2/index.js")));
const baselineFormats = baselineHasLdes2 ? ["ldes1", "trig", "jelly"] : ["ldes1"];
const git = (dir) => {
    try {
        return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
};
const metadata = {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    members,
    quadsPerMember: 8,
    pageSizes: [...new Set(pageSizes.map((s) => Math.min(s, members)))],
    ordered: options.ordered,
    repeats,
    warmups,
    delayMs,
    regressionPercent,
    branchCommit: git(path.resolve(here, "..")),
    baselinePath: baseline,
    baselineCommit: options["baseline-commit"] || (baseline && git(path.dirname(baseline))),
    baselineFormats: baseline ? baselineFormats : [],
    config: process.env.LDES_CLIENT_CONFIG || "defaults",
};

// Allocate a loopback port instead of requiring a fixed port to be free.
let pages;
const server = http.createServer((request, response) => {
    const page = pages.get(request.url.split("?")[0]);
    if (!page) return response.writeHead(404).end();
    const { body, type } = typeof page === "string" ? { body: page, type: "text/turtle" } : page;
    const timer = setTimeout(() => response.writeHead(200, { "content-type": type }).end(body), delayMs);
    response.on("close", () => clearTimeout(timer));
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});

function measure(scenario, verify = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [path.join(here, "lib/replicate.mjs"), scenario.dist, scenario.url, options.ordered, String(members), verify ? "verify" : "measure"],
            {
                env: { ...process.env, LOG_LEVEL: "error" },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let out = "",
            err = "",
            timedOut = false;
        child.stdout.on("data", (d) => {
            out += d;
        });
        child.stderr.on("data", (d) => {
            err = (err + d).slice(-5000);
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`${scenario.id}: timeout after ${timeoutMs / 1000}s`));
            if (code !== 0) return reject(new Error(`${scenario.id}: ${err || out || `exit ${code}`}`));
            try {
                resolve(JSON.parse(out.trim().split("\n").pop()));
            } catch {
                reject(new Error(`${scenario.id}: invalid measurement output`));
            }
        });
    });
}

const result = { metadata, summary: [], comparisons: [], samples: [] };
const cases = [];
try {
    const fixtures = await createFixtures(`http://127.0.0.1:${server.address().port}`);
    pages = fixtures.pages;
    for (const [i, size] of metadata.pageSizes.entries()) {
        const layout = `${Math.ceil(members / size)} × ${size}`;
        for (const format of ["ldes1", "trig", "jelly"]) {
            const name = `${format}-${i}`;
            const url = await fixtures[format](name, members, size);
            const responseBytes = [...pages]
                .filter(([key]) => key.startsWith(`/${name}/`))
                .reduce((sum, [, p]) => sum + Buffer.byteLength(typeof p === "string" ? p : p.body), 0);
            for (const client of ["baseline", "current"]) {
                if (client === "baseline" && (!baseline || !baselineFormats.includes(format))) continue;
                cases.push({
                    id: `${layout}/${format}/${client}`,
                    layout,
                    format,
                    client,
                    dist: client === "baseline" ? baseline : current,
                    url,
                    responseBytes,
                });
            }
        }
    }
    console.log(JSON.stringify(metadata));
    for (const scenario of cases) {
        console.error(`validate: ${scenario.id}`);
        await measure(scenario, true);
    }
    // Adjacent baseline/current measurements use identical responses; rotate the order to spread drift.
    for (let round = -warmups; round < repeats; round++) {
        const offset = (round + warmups) % cases.length;
        for (const scenario of [...cases.slice(offset), ...cases.slice(0, offset)]) {
            console.error(`${round < 0 ? "warmup" : `round ${round + 1}`}: ${scenario.id}`);
            const sample = await measure(scenario);
            if (round >= 0)
                result.samples.push({
                    id: scenario.id,
                    round: round + 1,
                    ...sample,
                });
        }
    }
    result.summary = summarize(cases, result.samples, repeats, members);
    result.comparisons = compare(result.summary, regressionPercent);
} catch (error) {
    result.error = error.message;
    console.error(error);
} finally {
    server.close();
    server.closeAllConnections();
}
function write(file, content, append = false) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    (append ? appendFileSync : writeFileSync)(file, content);
}
if (options.output) write(options.output, JSON.stringify(result, null, 2) + "\n");
const report = markdown(result);
console.log(report);
if (options.summary) write(options.summary, report + "\n", true);
if (!result.error && options["benchmark-output"]) write(options["benchmark-output"], JSON.stringify(history(result), null, 2) + "\n");
const regressions = result.comparisons.filter((r) => r.status === "regression");
if (options["fail-on-regression"] && regressions.length) console.error(`Performance regressions: ${regressions.map((r) => r.id).join(", ")}`);
process.exitCode = result.error || (options["fail-on-regression"] && regressions.length) ? 1 : 0;
