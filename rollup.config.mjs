import pkg from "./package.json" with { type: "json" };

// Get all dependencies from package.json to mark them as external
const dependencies = Object.keys(pkg.dependencies || {});
const peerDependencies = Object.keys(pkg.peerDependencies || {});
const externals = [
    ...dependencies,
    ...peerDependencies,
    "fs",
    "fs/promises",
    "path",
    "os",
    "url",
    "stream",
];

export default {
    input: "./dist/lib/client.js",
    output: {
        file: "./dist/lib/client.cjs",
        format: "cjs",
    },
    plugins: [
        {
            name: "dynamic-import-to-require",
            transform(code, id) {
                if (id.includes("logUtil")) {
                    return {
                        // Preserve import()'s default export: Winston's own .default is its default logger.
                        code: code.replace(
                            /await import\(['"]winston['"]\)/g,
                            '({ default: require("winston") })',
                        ),
                        map: null,
                    };
                }
            },
        },
    ],
    external: (id) => {
        // Mark as external if it's in the list or starts with a dependency name (handling subpaths)
        return externals.some((dep) => id === dep || id.startsWith(`${dep}/`));
    },
};
