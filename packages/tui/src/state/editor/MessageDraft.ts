import type { TuiAppState } from "../store/Model.js";

export function contextMessageDraftKey(
    instance: string,
    ctxId: string,
): string {
    return `contextMessage:${instance}:${ctxId}`;
}

export function readContextMessageDraft(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): string {
    const value =
        state.ui.formDrafts[contextMessageDraftKey(instance, ctxId)];
    return typeof value === "string" ? value : "";
}
