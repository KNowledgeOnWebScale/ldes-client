import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageName = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name as string;

test.each(["ESM", "CommonJS"])("built package works for %s consumers", (mode) => {
    const script = `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const load = ${mode === "ESM" ? "(name) => import(name)" : "async (name) => require(name)"};
        const name = ${JSON.stringify(packageName)};
        for (const suffix of ["", "/storage", "/storage/level", "/storage/memory", "/storage/do-sqlite"]) {
            await load(name + suffix);
        }
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
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(output).toContain("package consumer passed");
});
