import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
    plugins: [tsconfigPaths()],
    resolve: {
        // The parsers of ldfetch use the streams of Node.js: use the polyfills in the browser
        alias: {
            stream: "readable-stream",
            buffer: "buffer/",
            events: "events/",
            process: "process/browser",
        },
    },
    test: {
        setupFiles: ["./tests/browser/setup.ts"],
        browser: {
            enabled: true,
            provider: playwright(),
            instances: [
                {
                    browser: "chromium",
                },
            ],
            headless: true,
            screenshotFailures: false,
        },
        include: ["tests/browser/**/*.test.ts"],
        globalSetup: ["./tests/browser/globalSetup.ts"],
    },
});
