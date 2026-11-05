import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

// Use fresh Node processes to exercise the published exports, including module initialization.
// Vitest's source transforms would otherwise bypass the CommonJS bundle.
test.each([
    ["module", 'import { replicateLDES, intoConfig } from "ldes-client";'],
    [
        "commonjs",
        'const { replicateLDES, intoConfig } = require("ldes-client");',
    ],
])("the built package loads with %s exports", (type, load) => {
    const script = `${load}
        if (typeof replicateLDES !== "function") throw new Error("Missing replicateLDES export");
        if (intoConfig({ url: "https://example.org/ldes" }).url !== "https://example.org/ldes") {
            throw new Error("Invalid configuration");
        }
    `;
    expect(() =>
        execFileSync(process.execPath, ["--input-type", type, "-e", script], {
            cwd: root,
            env: { ...process.env, LOG_LEVEL: "error" },
            stdio: "pipe",
        }),
    ).not.toThrow();
});
