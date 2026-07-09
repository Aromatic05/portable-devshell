export type TuiDispatchHandler = () => Promise<boolean | void> | boolean | void;

export class TuiActionDispatcher {
    readonly #handlers = new Map<string, TuiDispatchHandler>();

    register(actionId: string, handler: TuiDispatchHandler): void {
        this.#handlers.set(actionId, handler);
    }

    async dispatch(actionId: string): Promise<boolean> {
        const handler = this.#handlers.get(actionId);

        if (handler === undefined) {
            return false;
        }

        return (await handler()) !== false;
    }
}
