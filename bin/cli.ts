#!/usr/bin/env node
import * as process from "process";
import { Command, Option } from "commander";
import { Writer } from "n3";
import { MessageWriter } from "n3.js-messages";
import { getLoggerFor, memberComment } from "../lib/utils";
import { replicateLDES, enhanced_fetch, intoConfig, processConditionFile } from "../lib/client";

import type { Ordered } from "../lib/strategy";
import type { FetchConfig, LDESInfo } from "../lib/fetcher";

const program = new Command();
let paramURL: string = "";
let polling: boolean = false;
let after: Date | undefined;
let before: Date | undefined;
let materialize: boolean = false;
let lastVersionOnly: boolean = false;
let conditionFile: string | undefined;
let paramPollInterval: number;
let urlIsView = false;
let noShape = false;
let shapeFile: string | undefined;
let ordered: Ordered = "none";
let quiet: boolean = false;
let save: string | undefined;
let onlyDefaultGraph: boolean = false;
let loose: boolean = false;
let defaultTimezone: string | undefined;
let includeMetadata: boolean = false;
let startFresh: boolean = false;
let comment: boolean = false;
let format: "trig-messages" | "n-quads" = "trig-messages";

const fetch_config: FetchConfig = {
    retry: {},
};

program
    .arguments("<url>")
    .option(
        "--after <after>",
        "follow only relations including members after a certain point in time",
    )
    .option("--basic-auth <username>:<password>", "HTTP basic auth information")
    .option(
        "--before <before>",
        "follow only relations including members before a certain point in time",
    )
    .option(
        "-c, --comment",
        "print a comment before every member with what the LDES says about it: its number, IRI, timestamp, sequence, version, type and transaction",
    )
    .option(
        "--concurrent <requests>",
        "Allowed amount of concurrent HTTP request to the same domain",
        "10",
    )
    .option(
        "--condition <condition_file>",
        "turtle file including the conditions for extracting a member",
    )
    .option("-f, --follow", "follow the LDES, the client stays in sync")
    .addOption(
        new Option(
            "--format <format>",
            "output format: an RDF Message log in TriG with one message per member, or the quads of all members as N-Quads",
        )
            .choices(["trig-messages", "n-quads"])
            .default("trig-messages"),
    )
    .option("--http-codes [codes...]", "What HTTP error codes to retry")
    .option(
        "--last-version-only",
        "emit only the latest available version of every member"
    )
    .option(
        "-l --loose",
        "ignores if the page URL does not correspond to the tree:Node IRI when following tree:relation",
    )
    .option(
        "--materialize",
        "materialize versioned members based on the ldes:versionOfPath predicate"
    )
    .option("-m, --metadata", "include metadata in the output members")
    .option(
        "--no-shape",
        "don't extract members with a shape (only use cbd and named graphs)",
    )
    .option(
        "--only-default-graph",
        "extract members only from the default graph and the member graph",
    )
    .addOption(
        new Option("-o --ordered <ordered>", "emit members in order")
            .choices(["ascending", "descending", "none"])
            .default("none"),
    )
    .option("--poll-interval <number>", "specify poll interval")
    .option("-q --quiet", "be quiet and don't print the members in the console (mainly for debugging purposes)")
    .option(
        "--retry-count <retry>",
        "Retry count per failing request (0 is infinite)",
        "3",
    )
    .option(
        "--safe",
        "Safe mode of fetching. The client won't crash on fetching errors",
    )
    .option(
        "-s, --save <path>",
        "folder path (or name if running in the browser) of where to store the state used both to resume and to update",
    )
    .option("--shape-file <shapeFile>", "specify the path of a (remote) file containing a SHACL shape for extracting members")
    .option("--start-fresh", "Clear any previous saved state and execute a fresh run")
    .option("-t --default-timezone <timezone>", "Default timezone for dates in tree:InBetweenRelation", "AoE")
    .option(
        "--url-is-view",
        "the url is the view url, don't try to find the correct view",
    )
    .action((url: string, program) => {
        urlIsView = program.urlIsView;
        noShape = !program.shape;
        save = program.save;
        paramURL = url;
        shapeFile = program.shapeFile;
        polling = program.follow;
        paramPollInterval = program.pollInterval;
        ordered = program.ordered;
        quiet = program.quiet;
        loose = program.loose;
        onlyDefaultGraph = program.onlyDefaultGraph;
        conditionFile = program.condition;
        materialize = program.materialize;
        lastVersionOnly = program.lastVersionOnly;
        defaultTimezone = program.defaultTimezone;
        includeMetadata = program.metadata;
        startFresh = program.startFresh;
        format = program.format;
        comment = program.comment;

        fetch_config.concurrent = parseInt(program.concurrent);
        if (program.basicAuth) {
            fetch_config.auth = {
                auth: program.basicAuth,
                host: new URL(url).host,
                type: "basic",
            };
        }
        fetch_config.retry!.maxRetries = parseInt(program.retryCount);
        fetch_config.safe = program.safe;
        if (program.httpCodes) {
            fetch_config.retry!.codes = program.httpCodes.map(parseInt);
        }

        if (program.after) {
            if (!isNaN(new Date(program.after).getTime())) {
                after = new Date(program.after);
            } else {
                console.error(`--after ${program.after} is not a valid date`);
                process.exit();
            }
        }
        if (program.before) {
            if (!isNaN(new Date(program.before).getTime())) {
                before = new Date(program.before);
            } else {
                console.error(`--before ${program.before} is not a valid date`);
                process.exit();
            }
        }
    });

program.parse(process.argv);

async function main() {
    const t0 = Date.now();
    const writer = new Writer();
    const logger = getLoggerFor("cli");
    // One message per member. The log is not ended with stdout: that stays open for the process itself.
    const messageLog =
        !quiet && format === "trig-messages"
            ? new MessageWriter(process.stdout, { format: "TriG", end: false })
            : undefined;

    const client = replicateLDES(
        intoConfig({
            loose,
            noShape,
            polling,
            url: paramURL,
            allowUnsafeAmbiguousView: true,
            statePath: save,
            pollInterval: paramPollInterval,
            urlIsView: urlIsView,
            after,
            before,
            shapeFile,
            onlyDefaultGraph,
            condition: await processConditionFile(conditionFile),
            defaultTimezone,
            materialize,
            lastVersionOnly,
            includeMetadata,
            concurrentFetches: fetch_config.concurrent,
            startFresh,
            fetch: enhanced_fetch(fetch_config),
        }),
        ordered,
    );

    let ldesInfo: LDESInfo | undefined;
    client.on("description", (info) => {
        ldesInfo = info;
        logger.verbose(`LDES description found: ${JSON.stringify({
            url: paramURL,
            shape: info.shape,
            timestampPath: info.timestampPath,
            isVersionOfPath: info.versionOfPath,
            shapeQuads: writer.quadsToString(info.shapeQuads),
        }, null, 2)}`);
    });

    client.on("fragment", (fragment) => {
        logger.debug(`Got fragment: ${fragment.url} (immutable: ${fragment.immutable})`);
    });

    client.on("error", (error) => {
        console.error("Error", error);
    });


    const reader = client.stream({ highWaterMark: 10 }).getReader();

    let streamResult = await reader.read();
    let memCount = 0;

    while (streamResult) {
        if (streamResult.value) {
            memCount += 1;

            if (memCount % 100 == 1) {
                logger.verbose(
                    `Got member number ${memCount} with ID ${streamResult.value.id.value} and ${streamResult.value.quads.length} quads`,
                );
            }

            const text = comment && !quiet ? memberComment(streamResult.value, memCount, ldesInfo) : "";
            if (messageLog) {
                // The comment follows the delimiter of the previous message (or the version) and precedes the member
                await messageLog.beginMessage();
                if (text) {
                    await new Promise<void>((resolve, reject) =>
                        process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
                    );
                }
                for (const quad of streamResult.value.quads) {
                    await messageLog.addQuad(quad);
                }
                await messageLog.endMessage();
            } else if (!quiet) {
                console.log(text + writer.quadsToString(streamResult.value.quads));
            }
        }

        if (streamResult.done) {
            break;
        }

        streamResult = await reader.read();
    }

    await messageLog?.end();

    logger.verbose(`Found ${client.memberCount} members in ${client.fragmentCount} fragments (took ${Date.now() - t0} ms)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
