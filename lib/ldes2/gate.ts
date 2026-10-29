/** A gate that the producer waits at while the consumer is not ready for more members (backpressure) */
export class Gate {
    private paused = false;
    private waiting: Array<() => void> = [];

    pause() {
        this.paused = true;
    }

    unpause() {
        this.paused = false;
        const waiting = this.waiting;
        this.waiting = [];
        waiting.forEach((resolve) => resolve());
    }

    wait(): Promise<void> {
        if (!this.paused) return Promise.resolve();
        return new Promise((resolve) => this.waiting.push(resolve));
    }
}
