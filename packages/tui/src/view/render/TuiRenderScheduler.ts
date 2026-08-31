import type { TuiAppStore } from "../../state/TuiAppStore.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";

export class TuiRenderScheduler {
    readonly #listeners = new Set<() => void>();
    readonly #unsubscribeStore: () => void;
    readonly #flushDelayMs: number;
    #lastObservedState: TuiAppState;
    #scheduled = false;
    #timer?: NodeJS.Timeout;

    constructor(
        readonly store: TuiAppStore,
        flushDelayMs = 16,
    ) {
        this.#flushDelayMs = flushDelayMs;
        this.#lastObservedState = store.getState();
        this.#unsubscribeStore = store.subscribe(() => {
            const nextState = store.getState();
            const previousState = this.#lastObservedState;
            this.#lastObservedState = nextState;
            if (isRenderRelevantChange(previousState, nextState)) {
                this.#schedule();
            }
        });
    }

    getSnapshot(): TuiAppState {
        return this.store.getState();
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    dispose(): void {
        this.#unsubscribeStore();

        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }

        this.#listeners.clear();
        this.#scheduled = false;
    }

    #schedule(): void {
        if (this.#scheduled) {
            return;
        }

        this.#scheduled = true;
        this.#timer = setTimeout(() => {
            this.#scheduled = false;
            this.#timer = undefined;

            for (const listener of this.#listeners) {
                listener();
            }
        }, this.#flushDelayMs);
    }
}

export function isRenderRelevantChange(
    previous: TuiAppState,
    next: TuiAppState,
): boolean {
    if (previous === next) return false;
    if (
        previous.connection !== next.connection ||
        previous.instances !== next.instances ||
        previous.interaction !== next.interaction ||
        previous.ui !== next.ui ||
        previous.panelErrors !== next.panelErrors ||
        previous.commandRecords !== next.commandRecords ||
        previous.relayByCommand !== next.relayByCommand ||
        previous.globalDerived.connectedInstanceCount !== next.globalDerived.connectedInstanceCount ||
        previous.globalDerived.pendingApprovalCount !== next.globalDerived.pendingApprovalCount
    ) return true;

    const before = selectedInstanceState(previous);
    const after = selectedInstanceState(next);
    switch (next.ui.selectedPage) {
        case "overview":
            return previous.readModel.overview !== next.readModel.overview;
        case "instances":
            return anyInstanceFieldChanged(previous, next, "snapshot") ||
                anyInstanceFieldChanged(previous, next, "approvals") ||
                previous.readModel.artifactShares !== next.readModel.artifactShares ||
                previous.readModel.artifactTransfers !== next.readModel.artifactTransfers ||
                previous.readModel.configView !== next.readModel.configView;
        case "connections":
            return previous.readModel.oauthApprovals !== next.readModel.oauthApprovals ||
                previous.readModel.configView !== next.readModel.configView ||
                previous.readModel.mcpStatus !== next.readModel.mcpStatus ||
                before?.snapshot !== after?.snapshot;
        case "config":
            return previous.readModel.configView !== next.readModel.configView ||
                before?.snapshot !== after?.snapshot;
        case "audit":
            return before?.commentCalls !== after?.commentCalls ||
                before?.approvals !== after?.approvals ||
                before?.logs !== after?.logs ||
                before?.toolCalls !== after?.toolCalls ||
                before?.contextMessages !== after?.contextMessages ||
                before?.snapshot !== after?.snapshot;
        case "logs":
            return before?.logs !== after?.logs || before?.snapshot !== after?.snapshot;
        case "todo":
            return before?.todo !== after?.todo ||
                before?.goals !== after?.goals ||
                before?.snapshot !== after?.snapshot;
        default:
            return false;
    }
}

function selectedInstanceState(state: TuiAppState) {
    const instance = state.ui.selectedInstance;
    return instance === undefined ? undefined : state.readModel.instanceState[instance];
}

function anyInstanceFieldChanged(
    previous: TuiAppState,
    next: TuiAppState,
    field: "approvals" | "snapshot",
): boolean {
    const names = new Set([
        ...Object.keys(previous.readModel.instanceState),
        ...Object.keys(next.readModel.instanceState),
    ]);
    for (const name of names) {
        if (previous.readModel.instanceState[name]?.[field] !== next.readModel.instanceState[name]?.[field]) {
            return true;
        }
    }
    return false;
}
