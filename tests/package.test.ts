import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageName = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name as string;

test.each([
    ["ESM", "node"],
    ["CommonJS", "node"],
    ["ESM", "workerd"],
    ["CommonJS", "workerd"],
])("built package works for %s consumers with the %s condition", (mode, condition) => {
    const script = `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const load = ${mode === "ESM" ? "(name) => import(name)" : "async (name) => require(name)"};
        const name = ${JSON.stringify(packageName)};
        for (const suffix of ["", "/storage", "/storage/level", "/storage/memory", "/storage/do-sqlite"]) {
            await load(name + suffix);
        }
        const { replicateLDES, intoConfig } = await load(name);
        const config = intoConfig({ url: "https://example.invalid" });
        assert.equal(config.url, "https://example.invalid");
        await replicateLDES(config).close();
        const { LevelStorage } = await load(name + "/storage/level");
        const storage = new LevelStorage();
        try {
            await storage.init();
            const store = storage.store("package-check");
            await store.put("key", { value: 1 });
            assert.deepEqual(await store.get("key"), { value: 1 });
        } finally {
            await storage.close();
        }
        console.log("package consumer passed");
    `;
    const output = execFileSync(process.execPath, [`--conditions=${condition}`, "--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, LOG_LEVEL: "error" },
    });
    expect(output).toContain("package consumer passed");
    // Winston honors LOG_LEVEL. The console logger prints the client's info message.
    if (condition === "node") {
        expect(output.trim()).toBe("package consumer passed");
    } else {
        expect(output).toContain("Client has been gracefully closed");
        expect(output).not.toContain("could not load Winston");
    }
});
