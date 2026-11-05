import type { Logform } from "winston";
import type { ConsoleTransportInstance } from "winston/lib/winston/transports";

const PROCESSOR_NAME = "ldes-client";

export interface ILogger {
    debug(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
    verbose(message: string, ...meta: unknown[]): void;
    silly(message: string, ...meta: unknown[]): void;
}

class ConsoleLogger implements ILogger {
    private label: string;

    constructor(label: string) {
        this.label = label;
    }

    private log(level: string, message: string, ...meta: unknown[]) {
        const timestamp = new Date().toISOString();
        const msg = `${timestamp} {${PROCESSOR_NAME}} [${this.label}] ${level}: ${message}`;
        switch (level) {
            case "debug":
            case "verbose":
            case "silly":
                console.debug(msg, ...meta);
                break;
            case "info":
                console.info(msg, ...meta);
                break;
            case "warn":
                console.warn(msg, ...meta);
                break;
            case "error":
                console.error(msg, ...meta);
                break;
            default:
                console.log(msg, ...meta);
        }
    }

    debug(message: string, ...meta: unknown[]): void { this.log("debug", message, ...meta); }
    info(message: string, ...meta: unknown[]): void { this.log("info", message, ...meta); }
    warn(message: string, ...meta: unknown[]): void { this.log("warn", message, ...meta); }
    error(message: string, ...meta: unknown[]): void { this.log("error", message, ...meta); }
    verbose(message: string, ...meta: unknown[]): void { this.log("verbose", message, ...meta); }
    silly(message: string, ...meta: unknown[]): void { this.log("silly", message, ...meta); }
}

let winston: typeof import("winston") | undefined;
if (typeof process !== "undefined" && process.release?.name === "node") {
    try {
        // Non-literal specifier hides from esbuild's static analysis so
        // winston is NOT bundled into CF Worker builds.
        const name = "winston";
        const m = await import(/* @vite-ignore */ name);
        winston = typeof m.createLogger === "function" ? m : m.default;
    } catch {
        // winston not installed — fall back to ConsoleLogger
    }
}

let consoleTransport: ConsoleTransportInstance | undefined;

const classLoggers = new WeakMap<Constructor, ILogger>();
const stringLoggers = new Map<string, ILogger>();

export function getLoggerFor(loggable: string | Instance): ILogger {
    let logger: ILogger;
    if (typeof loggable === "string") {
        if (stringLoggers.has(loggable)) {
            logger = stringLoggers.get(loggable)!;
        } else {
            logger = createLogger(loggable);
            stringLoggers.set(loggable, logger);
        }
    } else {
        const { constructor } = loggable;
        if (classLoggers.has(constructor)) {
            logger = classLoggers.get(constructor)!;
        } else {
            logger = createLogger(constructor.name);
            classLoggers.set(constructor, logger);
        }
    }
    return logger;
}

function createLogger(label: string): ILogger {
    if (winston) {
        // Node.js environment with winston successfully loaded
        if (!consoleTransport) {
            consoleTransport = new winston.transports.Console({
                stderrLevels: [
                    "crit",
                    "error",
                    "emerg",
                    "warn",
                    "warning",
                    "alert",
                    "info",
                    "http",
                    "verbose",
                    "debug",
                    "silly"
                ]
            });

            if (process.env) {
                consoleTransport.level =
                    process.env.LOG_LEVEL ||
                    (process.env.DEBUG?.includes(PROCESSOR_NAME) ||
                        process.env.DEBUG === "*"
                        ? "debug"
                        : "info");
            }
        }

        return winston.createLogger({
            format: winston.format.combine(
                winston.format.label({ label }),
                winston.format.colorize(),
                winston.format.timestamp(),
                winston.format.metadata({
                    fillExcept: ["level", "timestamp", "label", "message"],
                }),
                winston.format.printf(
                    ({
                        level: levelInner,
                        message,
                        label: labelInner,
                        timestamp,
                    }: Logform.TransformableInfo): string =>
                        `${timestamp} {${PROCESSOR_NAME}} [${labelInner}] ${levelInner}: ${message}`,
                ),
            ),
            transports: [consoleTransport],
        });
    } else {
        // Browser environment
        return new ConsoleLogger(label);
    }
}

/**
 * Any class constructor.
 */
interface Constructor {
    name: string;
}

/**
 * Any class instance.
 */
interface Instance {
    constructor: Constructor;
}