/**
 * ldfetch (the parsers of the client) expects the globals and modules of Node.js.
 * In the browser, they come from polyfills: `stream` is aliased in vitest.browser.config.ts.
 */
import { Buffer } from "buffer/";

const global = globalThis as unknown as { Buffer?: unknown };
global.Buffer ??= Buffer;
