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
        // event-driven client. Warnings for now: some of them are on purpose, and have to be marked as such.
        files: ["lib/**/*.ts", "bin/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-floating-promises": "warn",
            "@typescript-eslint/no-misused-promises": "warn",
            "@typescript-eslint/await-thenable": "warn",
        },
    },

    // The formatting is the job of Prettier: this turns off the rules of ESLint that would disagree. Keep it last.
    prettier,
]);
