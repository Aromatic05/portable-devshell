import type { TuiAppState } from "./reducer/TuiStoreModel.js";

export function contextConversationDraftKey(instance: string, ctxId: string): string {
    return `contextConversation:${instance}:${ctxId}`;
}

export function readContextConversationDraft(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): string {
    const value = state.ui.formDrafts[contextConversationDraftKey(instance, ctxId)];
    return typeof value === "string" ? value : "";
}
