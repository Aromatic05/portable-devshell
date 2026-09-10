import type { TuiAppState } from "../reducer/TuiStoreModel.js";

export function isActiveContextForInstance(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): boolean {
    const context = state.readModel.contexts.find((record) => record.ctxId === ctxId);
    return context?.status === "active" &&
        context.environments.some((environment) => environment.instance === instance);
}
