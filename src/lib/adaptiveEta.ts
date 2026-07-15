import {
    clearLine,
    cursorTo,
} from "node:readline";
import {
    stdout,
} from "node:process";

export class AdaptiveEta {
    private completedItems = 0;
    private currentItemStartedAt = 0;
    private averageMillisecondsPerItem: number;

    constructor(
        private readonly totalItems: number,
        initialAverageMillisecondsPerItem: number,
        private readonly firstItemEstimatedMilliseconds =
            initialAverageMillisecondsPerItem,
    ) {
        this.averageMillisecondsPerItem =
            initialAverageMillisecondsPerItem;
    }

    startItem(): void {
        if (this.currentItemStartedAt !== 0) {
            throw new Error(
                "Cannot start a new ETA item before finishing the current item.",
            );
        }

        this.currentItemStartedAt = Date.now();
    }

    finishItem(learnFromMeasurement = true): number {
        if (this.currentItemStartedAt === 0) {
            return 0;
        }

        const elapsed =
            Date.now() - this.currentItemStartedAt;

        if (learnFromMeasurement) {
            /*
             * Exponential moving average:
             * 35% of the new measurement, 65% of prior history.
             *
             * The caller can disable learning for the first unpaced request
             * and for failed requests, while still advancing progress.
             */
            const learningWeight = 0.35;

            this.averageMillisecondsPerItem =
                this.averageMillisecondsPerItem *
                (1 - learningWeight)
                +
                elapsed *
                learningWeight;
        }

        this.completedItems += 1;
        this.currentItemStartedAt = 0;

        return elapsed;
    }

    getRemainingMilliseconds(): number {
        const remainingItems =
            this.totalItems - this.completedItems;

        if (remainingItems <= 0) {
            return 0;
        }

        const currentItemEstimate =
            this.completedItems === 0
                ? this.firstItemEstimatedMilliseconds
                : this.averageMillisecondsPerItem;

        if (this.currentItemStartedAt === 0) {
            return (
                currentItemEstimate
                +
                Math.max(0, remainingItems - 1) *
                this.averageMillisecondsPerItem
            );
        }

        const currentItemElapsed =
            Date.now() - this.currentItemStartedAt;

        const estimatedCurrentItemRemaining = Math.max(
            0,
            currentItemEstimate - currentItemElapsed,
        );

        return (
            estimatedCurrentItemRemaining
            +
            Math.max(0, remainingItems - 1) *
            this.averageMillisecondsPerItem
        );
    }

    getAverageMillisecondsPerItem(): number {
        return this.averageMillisecondsPerItem;
    }

    getCompletedItems(): number {
        return this.completedItems;
    }
}

export class BottomStatusLine {
    private interval: NodeJS.Timeout | undefined;
    private getText: (() => string) | undefined;
    private visible = false;

    start(getText: () => string): void {
        this.stop();

        this.getText = getText;

        if (!stdout.isTTY) {
            return;
        }

        this.render();

        this.interval = setInterval(() => {
            this.render();
        }, 1_000);
    }

    log(message = ""): void {
        this.clear();
        console.log(message);
        this.render();
    }

    error(message: string): void {
        this.clear();
        console.error(message);
        this.render();
    }

    clear(): void {
        if (!stdout.isTTY || !this.visible) {
            return;
        }

        clearLine(stdout, 0);
        cursorTo(stdout, 0);
        this.visible = false;
    }

    render(): void {
        if (!stdout.isTTY || !this.getText) {
            return;
        }

        this.clear();

        stdout.write(this.getText());
        this.visible = true;
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }

        this.clear();
        this.getText = undefined;
    }
}