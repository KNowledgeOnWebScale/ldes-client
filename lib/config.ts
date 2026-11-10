import { empty_condition as emptyCondition } from "./condition";
import { enhanced_fetch } from "./fetcher/enhancedFetch";

import type { NamedNode, Quad } from "@rdfjs/types";
import type { Condition } from "./condition";
import type { ContextCacheOptions } from "./fetcher/contextCache";

export interface ShapeConfig {
    quads: Quad[];
    shapeId: NamedNode;
}

export interface Config {
    loose: boolean;
    polling: boolean;
    url: string;
    urlIsView: boolean;
    /**
     * CLI compatibility mode: choose the first matching view when discovery is
     * ambiguous. Library callers must leave this disabled to remain compliant.
     */
    allowUnsafeAmbiguousView: boolean;
    noShape: boolean;
    statePath?: string;
    pollInterval: number;
    condition: Condition;
    defaultTimezone: string;
    after?: Date;
    before?: Date;
    shape?: ShapeConfig;
    shapeFile?: string;
    onlyDefaultGraph?: boolean;
    materialize?: boolean;
    lastVersionOnly?: boolean;
    includeMetadata?: boolean;
    concurrentFetches?: number;
    startFresh?: boolean;
    fetch?: typeof fetch;
    /**
     * How external JSON-LD contexts (such as https://schema.org) are cached. Only these are cached, not the pages.
     * They follow HTTP caching semantics, but are kept for at least `minTTL` seconds (default: 600),
     * as contexts hardly ever change and are often served without useful cache headers.
     * Pass `false` to not cache contexts.
     */
    contextCache?: ContextCacheOptions | false;
}

export interface WithTarget {
    target: object;
}

const defaultConfig: Config = {
    urlIsView: false,
    allowUnsafeAmbiguousView: false,
    noShape: false,
    condition: emptyCondition(),
    loose: false,
    polling: false,
    url: "",
    pollInterval: 1000,
    defaultTimezone: "AoE",
    materialize: false,
    lastVersionOnly: false,
    includeMetadata: false,
    concurrentFetches: 10,
    startFresh: false,
};

const defaultTarget: WithTarget = {
    target: {},
};

export async function getConfig(): Promise<Config & WithTarget> {
    return Object.assign({}, defaultConfig, defaultTarget);
}

export function intoConfig(config: Partial<Config>): Config {
    // An option that is passed as undefined (for example by the RDF-Connect processor, for everything that
    // the pipeline does not set) keeps its default, instead of replacing it with undefined
    const given = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    const out = Object.assign({}, defaultConfig, defaultTarget, given);
    out.fetch = enhanced_fetch(
        {
            retry: {
                base: 10,
                maxRetries: 10,
            },
            concurrent: out.concurrentFetches,
        },
        config.fetch,
    );
    return out;
}
