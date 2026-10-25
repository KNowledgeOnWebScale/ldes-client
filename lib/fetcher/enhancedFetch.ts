import { urlToUrl, getLoggerFor } from "../utils";
import { createLineBufferedFetch } from "./lineBuffer";

const logger = getLoggerFor("EnhancedFetch");

export type AuthConfig = {
    type: "basic";
    auth: string;
    host: string;
};

export type RetryConfig = {
    codes: number[];
    base: number;
    maxRetries: number;
};

export type FetchConfig = {
    auth?: AuthConfig;
    concurrent?: number;
    retry?: Partial<RetryConfig>;
    safe?: boolean;
};

export function enhanced_fetch(
    config: FetchConfig,
    start?: typeof fetch,
): typeof fetch {
    const start_f = start || fetch;
    const safe_f = config.safe
        ? ((async (a, b) => {
            while (true) {
                try {
                    return await start_f(a, b);
                } catch (ex) {
                    logger.debug(
                        `This should not happen, it will not happen this is safe. ${JSON.stringify(
                            ex,
                        )}`,
                    );
                }
            }
        }) as typeof fetch)
        : start_f;

    const fetch_f = config.auth
        ? handle_basic_auth(safe_f, config.auth)
        : safe_f;

    const limitedFetch = limit_fetch_per_domain(
        empty_special_status_fetch(retry_fetch(fetch_f, config.retry || {})),
        config.concurrent,
    );

    // Apply line buffering to work around N3.js chunk-splitting bug
    // https://github.com/rdfjs/N3.js/issues/578
    return createLineBufferedFetch(limitedFetch);
}

export function limit_fetch_per_domain(
    fetch_f: typeof fetch,
    concurrent: number = 10,
): typeof fetch {
    const domain_dict: { [domain: string]: Array<(value: void) => void> } = {};

    const out: typeof fetch = async (input, init) => {
        const url: URL = urlToUrl(input);
        const domain = url.origin;

        if (!(domain in domain_dict)) {
            domain_dict[domain] = [];
        }

        const requests = domain_dict[domain];
        await new Promise((res) => {
            logger.debug(
                `[limit] request ${input} for domain [${domain}] capacity: (${requests.length}/${concurrent})`,
            );
            if (requests.length < concurrent) {
                requests.push(res);
                res({});
            } else {
                requests.push(res);
            }
        });
        const resp = await fetch_f(input, init);

        requests.shift();
        for (let i = 0; i < concurrent; i++) {
            if (requests[i]) {
                requests[i]();
            }
        }

        return resp;
    };

    return out;
}

export function handle_basic_auth(
    fetch_f: typeof fetch,
    config: AuthConfig,
): typeof fetch {
    let authRequired = false;

    const basicAuthValue = `Basic ${Buffer.from(config.auth).toString("base64")}`;
    const setHeader = (init?: RequestInit): RequestInit => {
        const reqInit = init || {};
        const headers = new Headers(reqInit.headers);
        headers.set("Authorization", basicAuthValue);
        reqInit.headers = headers;
        return reqInit;
    };

    const auth_f: typeof fetch = async (input, init) => {
        const url: URL = urlToUrl(input);
        if (authRequired && url.host === config.host) {
            return await fetch_f(input, setHeader(init));
        }

        const resp = await fetch_f(input, init);
        if (resp.status === 401) {
            logger.debug("[auth] Unauthorized, adding basic auth");
            if (url.host === config.host) {
                authRequired = true;
                return await fetch_f(input, setHeader(init));
            }
        }

        return resp;
    };

    return auth_f;
}

export function empty_special_status_fetch(fetch_f: typeof fetch): typeof fetch {
    const status_f: typeof fetch = async (input, init) => {
        const resp = await fetch_f(input, init);
        if (resp.status !== 304 && resp.status !== 410) {
            return resp;
        }

        const headers = new Headers(resp.headers);
        headers.set("content-type", "text/turtle");
        headers.set("x-ldes-client-original-status", resp.status.toString());

        return new Response("", {
            headers,
            status: 200,
            statusText: "OK",
        });
    };

    return status_f;
}

export function retry_fetch(
    fetch_f: typeof fetch,
    partial_config: Partial<RetryConfig>,
): typeof fetch {
    const config: RetryConfig = Object.assign(
        {
            codes: [408, 425, 429, 500, 502, 503, 504],
            base: 500,
            maxRetries: 5,
        },
        partial_config,
    );

    const retry: typeof fetch = async (input, init) => {
        let tryCount = 0;
        let retryTime = config.base;
        while (config.maxRetries == 0 || tryCount < config.maxRetries) {
            const resp = await fetch_f(input, init);
            if (!resp.ok) {
                if (config.codes.some((x) => x == resp.status)) {
                    logger.debug(
                        `[retry_fetch] Got ${resp.status} ${resp.statusText}, retrying ${input} ${tryCount}/${config.maxRetries}`,
                    );
                    // Wait 500ms, 1 second, 2 seconds, 4 seconds, 8 seconds, fail
                    tryCount += 1;
                    await new Promise((res) => setTimeout(res, retryTime));
                    retryTime *= 2;
                    continue;
                }
                return resp;
            }
            return resp;
        }

        throw `Max retries exceeded (${config.maxRetries})`;
    };

    return retry;
}
