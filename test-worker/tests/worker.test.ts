import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isPreview = !!process.env.PREVIEW;
const workerDir = new URL("..", import.meta.url).pathname;

let wrangler: ChildProcess | undefined;
let baseUrl: string;
let persistDir: string;
let previewWorkerName: string | undefined;

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
            const addr = server.address();
            if (addr && typeof addr === "object") {
                const port = addr.port;
                server.close(() => resolve(port));
            } else {
                server.close(() => reject(new Error("Could not get port")));
            }
        });
        server.on("error", reject);
    });
}

async function waitForReady(url: string, timeout = 90_000, interval = 500): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return;
        } catch {
            // not ready yet
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Not ready after ${timeout}ms at ${url}`);
}

/** Fetch with retry on 500 for DO propagation delays in preview mode. */
async function fetchRetry(
    input: string | URL | Request,
    init?: RequestInit,
    retries = isPreview ? 10 : 0,
    interval = 3000,
): Promise<Response> {
    for (let i = 0; i <= retries; i++) {
        const res = await fetch(input, init);
        if (res.status !== 500 || i === retries) return res;
        console.error(`Got 500 from ${typeof input === "string" ? input : input.toString()}, retrying (${i + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("unreachable");
}

async function setupDev(): Promise<void> {
    const port = await findFreePort();
    baseUrl = `http://localhost:${port}`;

    persistDir = await mkdtemp(join(tmpdir(), "ldes-test-worker-"));

    wrangler = spawn(
        "npx",
        [
            "wrangler", "dev",
            "--port", String(port),
            "--persist-to", persistDir,
        ],
        {
            cwd: workerDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NO_COLOR: "1" },
        },
    );

    let stderr = "";
    wrangler.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    wrangler.on("exit", (code) => {
        if (code && code !== 0) {
            console.error(`Wrangler stderr:\n${stderr}`);
        }
    });

    await waitForReady(baseUrl);
}

async function teardownDev(): Promise<void> {
    if (wrangler && wrangler.exitCode === null) {
        wrangler.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                wrangler!.kill("SIGKILL");
                resolve();
            }, 5000);
            wrangler!.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    if (persistDir) {
        await rm(persistDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function setupPreview(): Promise<void> {
    const suffix = Math.random().toString(36).slice(2, 7);
    previewWorkerName = `ldes-test-${Date.now()}-${suffix}`;

    console.error(`Deploying preview worker: ${previewWorkerName}`);

    let stdout: string;
    try {
        stdout = execSync(
            `npx wrangler deploy --name ${previewWorkerName}`,
            {
                cwd: workerDir,
                env: { ...process.env, NO_COLOR: "1" },
                timeout: 300_000,
                stdio: ["ignore", "pipe", "pipe"],
            },
        ).toString();
    } catch (err: unknown) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        const out = e.stdout?.toString() ?? "";
        const errOut = e.stderr?.toString() ?? "";
        throw new Error(
            `wrangler deploy failed.\nstdout: ${out}\nstderr: ${errOut}`,
        );
    }

    const urlMatch = stdout.match(/https:\/\/[a-z0-9._-]+\.workers\.dev/);
    if (!urlMatch) {
        throw new Error(
            `Could not find workers.dev URL in deploy output:\n${stdout}`,
        );
    }
    baseUrl = urlMatch[0];
    console.error(`Deployed to: ${baseUrl}`);

    await waitForReady(baseUrl, 120_000, 2000);
}

async function teardownPreview(): Promise<void> {
    if (!previewWorkerName) return;
    console.error(`Deleting preview worker: ${previewWorkerName}`);
    try {
        execSync(
            `npx wrangler delete --name ${previewWorkerName} --force`,
            {
                cwd: workerDir,
                timeout: 60_000,
                stdio: "ignore",
            },
        );
        console.error(`Deleted ${previewWorkerName}`);
    } catch {
        console.error(`Failed to delete ${previewWorkerName} (may not exist)`);
    }
}

beforeAll(async () => {
    if (isPreview) {
        await setupPreview();
    } else {
        await setupDev();
    }
});

afterAll(async () => {
    if (isPreview) {
        await teardownPreview();
    } else {
        await teardownDev();
    }
});

describe("bundle sanity", () => {
    it("esbuild bundle does not contain winston", async () => {
        // Winston is a Node.js-only logging library that should never be bundled
        // into CF Workers. If esbuild pulls it in, it adds ~50K lines of bloat
        // and may break on stricter runtimes.
        const { readFileSync, readdirSync } = await import("node:fs");
        const { join: pjoin } = await import("node:path");
        const wranglerTmp = pjoin(workerDir, ".wrangler", "tmp");
        let bundlePath: string | undefined;
        try {
            const dirs = readdirSync(wranglerTmp);
            for (const d of dirs) {
                const candidate = pjoin(wranglerTmp, d, "index.js");
                try {
                    readFileSync(candidate);
                    bundlePath = candidate;
                    break;
                } catch { /* not this dir */ }
            }
        } catch { /* no .wrangler/tmp */ }

        if (bundlePath) {
            const bundle = readFileSync(bundlePath, "utf-8");
            expect(bundle).not.toContain("winstonjs/winston");
        }
    });
});

describe("test-worker", () => {
    it("responds on /", async () => {
        const res = await fetchRetry(baseUrl);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain("LDES Client Test Worker");
    });

    it("returns 400 when /replicate is called without url", async () => {
        const res = await fetch(`${baseUrl}/replicate`);
        expect(res.status).toBe(400);
    });
});

describe("mock LDES", () => {
    it("serves a valid LDES stream that the client can consume", async () => {
        const mockUrl = `${baseUrl}/mock/basic/stream.ttl`;
        const res = await fetchRetry(
            `${baseUrl}/replicate?url=${encodeURIComponent(mockUrl)}&count=10`,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as {
            received: number;
            members: { id: string }[];
        };
        expect(body.received).toBe(3);
        expect(body.members.map((m) => m.id).sort()).toEqual([
            `${baseUrl}/mock/basic/mem1`,
            `${baseUrl}/mock/basic/mem2`,
            `${baseUrl}/mock/basic/mem3`,
        ].sort());
    });
});

describe("state persistence", () => {
    // Use a unique mock name so this test has its own MockLDES DO and LDESState DO
    const mockName = "persist";

    it("startFresh=true clears persisted state and re-emits all members", async () => {
        const mockName = "fresh-test";
        const mockUrl = `${baseUrl}/mock/${mockName}/stream.ttl`;
        const replicateUrl = `${baseUrl}/replicate?url=${encodeURIComponent(mockUrl)}&count=100`;

        // --- First replication: get 3 members, state is persisted ---
        const res1 = await fetchRetry(replicateUrl);
        expect(res1.status).toBe(200);
        const body1 = await res1.json() as { received: number };
        expect(body1.received).toBe(3);

        // --- Second replication without startFresh: should get 0 (all already emitted) ---
        const res2 = await fetchRetry(replicateUrl);
        expect(res2.status).toBe(200);
        const body2 = await res2.json() as { received: number };
        expect(body2.received).toBe(0);

        // --- Third replication with startFresh=true: should get 3 again (state cleared) ---
        const res3 = await fetchRetry(`${replicateUrl}&startFresh=true`);
        expect(res3.status).toBe(200);
        const body3 = await res3.json() as { received: number };
        expect(body3.received).toBe(3);
    });

    it("client only emits new members after mock advances", async () => {
        const mockUrl = `${baseUrl}/mock/${mockName}/stream.ttl`;
        const replicateUrl = `${baseUrl}/replicate?url=${encodeURIComponent(mockUrl)}&count=100`;

        // --- Phase 1: replicate → should get 3 members ---
        const res1 = await fetchRetry(replicateUrl);
        expect(res1.status).toBe(200);
        const body1 = await res1.json() as {
            received: number;
            members: { id: string }[];
        };
        expect(body1.received).toBe(3);
        const ids1 = body1.members.map((m) => m.id).sort();

        // --- Advance mock to phase 2 (adds mem4, mem5, mem6) ---
        const advRes = await fetchRetry(`${baseUrl}/mock/${mockName}/advance`, {
            method: "POST",
        });
        expect(advRes.status).toBe(200);
        const advBody = await advRes.json() as { phase: number };
        expect(advBody.phase).toBe(2);

        // --- Phase 2: replicate again with same DO → should get only 3 NEW members ---
        const res2 = await fetchRetry(replicateUrl);
        expect(res2.status).toBe(200);
        const body2 = await res2.json() as {
            received: number;
            members: { id: string }[];
        };
        const ids2 = body2.members.map((m) => m.id).sort();

        // The client persisted its emitted state in DO SQLite,
        // so it must not re-emit the 3 members from phase 1.
        expect(body2.received).toBe(3);

        // None of the phase-2 member IDs should overlap with phase-1
        for (const id of ids2) {
            expect(ids1).not.toContain(id);
        }

        // Together, all 6 unique members should be accounted for
        const allIds = [...new Set([...ids1, ...ids2])].sort();
        expect(allIds).toHaveLength(6);
    });
});
