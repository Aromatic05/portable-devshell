import type { WebState } from "./Model.js";
import { errorMessage, withRequestTimeout } from "./Request.js";

export interface WebOperationAccess {
    getState(): WebState;
    isCurrent(generation: number): boolean;
    setState(state: WebState): void;
}

export class WebOperationCoordinator {
    #controllers = new Map<string, AbortController>();
    #failures = new Map<string, string>();

    failure(operation: string): string | undefined {
        return this.#failures.get(operation);
    }

    constructor(
        private readonly access: WebOperationAccess,
        private readonly timeoutMs: number,
    ) {}

    async run(
        operation: string,
        success: string,
        generation: number,
        action: (signal: AbortSignal) => Promise<void>,
    ): Promise<boolean> {
        const state = this.access.getState();
        if (
            !this.access.isCurrent(generation) ||
            state.operations[operation] !== undefined
        )
            return false;

        const controller = new AbortController();
        this.#failures.delete(operation);
        this.#controllers.set(operation, controller);
        this.access.setState({
            ...state,
            error: undefined,
            notice: undefined,
            operations: { ...state.operations, [operation]: "pending" },
        });
        const aborted = abortPromise(controller.signal);
        try {
            await withRequestTimeout(
                Promise.race([action(controller.signal), aborted.promise]),
                this.timeoutMs,
                operation,
                "uncertain",
            );
            if (
                !this.access.isCurrent(generation) ||
                controller.signal.aborted
            ) {
                return false;
            }
            this.complete(operation, { notice: success });
            return true;
        } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
            if (!this.access.isCurrent(generation)) return false;
            this.complete(operation, { error: errorMessage(error) });
            return false;
        } finally {
            aborted.dispose();
            if (this.#controllers.get(operation) === controller) {
                this.#controllers.delete(operation);
            }
        }
    }

    cancelAll(error = new Error("Web operations were cancelled.")): void {
        const controllers = [...this.#controllers];
        this.#controllers.clear();
        this.#failures.clear();
        for (const [operation, controller] of controllers) {
            this.#failures.set(operation, errorMessage(error));
            controller.abort(error);
        }
    }

    private complete(
        operation: string,
        result: { error?: string; notice?: string },
    ): void {
        const state = this.access.getState();
        if (result.error !== undefined) this.#failures.set(operation, result.error);
        const { [operation]: _completed, ...operations } = state.operations;
        this.access.setState({ ...state, ...result, operations });
    }
}

export function approvalOperationKey(instance: string, approvalId: string): string {
    return `approval:${JSON.stringify([instance, approvalId])}`;
}

function abortPromise(signal: AbortSignal): {
    dispose(): void;
    promise: Promise<never>;
} {
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<never>((_resolve, reject) => {
        rejectPromise = reject;
    });
    const abort = (): void => rejectPromise(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    return {
        dispose: () => signal.removeEventListener("abort", abort),
        promise,
    };
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Web operation was aborted.");
}
