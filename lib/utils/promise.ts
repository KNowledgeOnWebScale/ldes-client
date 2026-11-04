export type LongPromise = {
    waiting: Promise<void>;
    callback: () => void;
};

export function longPromise(): LongPromise {
    const out = {} as LongPromise;
    out.waiting = new Promise((res) => (out.callback = res));
    return out;
}

export function resetPromise(promise: LongPromise) {
    const cb = promise.callback;
    promise.waiting = new Promise((res) => (promise.callback = res));
    cb();
}
