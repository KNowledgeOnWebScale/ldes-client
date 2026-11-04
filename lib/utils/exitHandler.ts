import { getLoggerFor } from "./logUtil";

const logger = getLoggerFor("ExitHandler");

function noOp() { }

const listeners: {
    event: string;
    listener: (error: Error) => void
}[] = [];

/**
 * Clean up all registered exit handlers.
 * This is useful when running multiple client instances in the same process.
 * For example, when running unit tests.
 */
export function cleanUpHandlers() {
    listeners.forEach(({ event, listener }) => {
        process.removeListener(event, listener);
    });
}

export function handleExit(callback: () => void | Promise<void>) {
    // attach user callback to the process event emitter
    // if no callback, it will still exit gracefully on Ctrl-C
    callback = callback || noOp;

    // Make sure we only call the callback once.
    let callbackCalled = false;
    const fn = async function (event: string, code?: number, message?: Error) {
        if (!callbackCalled) {
            callbackCalled = true;
            logger.debug(
                `[handleExit] Exiting on '${event}' event with code '${code}'.`,
            );
            if (message) {
                logger.error(
                    `[handleExit] Uncaught Exception: ${message.name} - ${message.message}\n${message.stack}`,
                );
            }
            cleanUpHandlers();
            await callback();
        } else {
            logger.debug(
                `[handleExit] Exit handler function has already been called. Ignoring '${event}' with code '${code}'.`,
            );
        }

        if (code && process.listeners(<NodeJS.Signals>event).length <= 0) {
            // Only call exit if there are no other listeners registered for this event.
            process.exit(code);
        }
    };

    // do app specific cleaning before exiting
    const sigInt = async () => await fn("SIGINT", 2);
    const sigTerm = async () => await fn("SIGTERM", 143);
    const sigBreak = async () => await fn("SIGBREAK", 149);
    const uncaughtException = async (error: Error) => await fn("uncaughtException", 99, error);
    const unhandledRejection = async (error: Error) => await fn("unhandledRejection", 99, error);

    // catch ctrl+c event and exit normally
    process.once("SIGINT", sigInt);
    process.once("SIGTERM", sigTerm);
    process.once("SIGBREAK", sigBreak);
    process.once("uncaughtException", uncaughtException);
    process.once("unhandledRejection", unhandledRejection);

    listeners.push({ event: "SIGINT", listener: sigInt });
    listeners.push({ event: "SIGTERM", listener: sigTerm });
    listeners.push({ event: "SIGBREAK", listener: sigBreak });
    listeners.push({ event: "uncaughtException", listener: uncaughtException });
    listeners.push({ event: "unhandledRejection", listener: unhandledRejection });
}