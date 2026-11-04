import { empty_condition as emptyCondition } from "./condition";

import type { NamedNode, Quad } from "@rdfjs/types";
import type { Condition } from "./condition";

export interface ShapeConfig {
    quads: Quad[];
    shapeId: NamedNode;
}

export interface Config {
    loose: boolean;
    polling: boolean;
    url: string;
    urlIsView: boolean;
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
}

export interface WithTarget {
    target: object;
}

const defaultConfig: Config = {
    urlIsView: false,
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
    return Object.assign({}, defaultConfig, defaultTarget, config);
}
