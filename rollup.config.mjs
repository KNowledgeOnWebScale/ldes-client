import pkg from "./package.json" with { type: "json" };

// Get all dependencies from package.json to mark them as external
const dependencies = Object.keys(pkg.dependencies || {});
const peerDependencies = Object.keys(pkg.peerDependencies || {});
const externals = [...dependencies, ...peerDependencies, "#load-winston", "fs", "fs/promises", "path", "os", "url", "stream"];

export default {
    input: {
        client: "./dist/lib/client.js",
        "storage/index": "./dist/lib/storage/index.js",
        "storage/level": "./dist/lib/storage/level.js",
        "storage/memory": "./dist/lib/storage/memory.js",
        "storage/do-sqlite": "./dist/lib/storage/do-sqlite.js",
    },
    output: {
        dir: "./dist/lib",
        entryFileNames: "[name].cjs",
        chunkFileNames: "chunks/[name]-[hash].cjs",
        format: "cjs",
    },
    external: (id) => {
        // Mark as external if it's in the list or starts with a dependency name (handling subpaths)
        return externals.some((dep) => id === dep || id.startsWith(`${dep}/`));
    },
};
