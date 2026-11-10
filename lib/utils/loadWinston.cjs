exports.loadWinston = function loadWinston() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep the optional load synchronous and visible to Node bundlers.
        return require("winston");
    } catch (error) {
        console.debug("ldes-client could not load Winston and will use console logging.", error instanceof Error ? error.message : error);
        return undefined;
    }
};
