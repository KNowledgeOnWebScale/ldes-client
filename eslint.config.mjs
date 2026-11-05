import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
    globalIgnores(["dist/", "coverage/", "reports/", "node_modules/"]),

    js.configs.recommended,
    tseslint.configs.recommended,

    {
        // The client runs in Node.js and in the browser
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            // An underscore says that the value is unused on purpose
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "none",
                },
            ],
        },
    },

    {
        // Rules that need type information. A promise that is not awaited is how an error gets lost in an
        // event-driven client. Work that nobody waits for on purpose is marked with `void`, or goes through
        // `background()` in the strategies, which reports a failure as an error of the client.
        files: ["lib/**/*.ts", "bin/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": "error",
            "@typescript-eslint/await-thenable": "error",
        },
    },

    // The formatting is the job of Prettier: this turns off the rules of ESLint that would disagree. Keep it last.
    prettier,
]);
