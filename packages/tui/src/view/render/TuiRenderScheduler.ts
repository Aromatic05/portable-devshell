import type { TuiAppStore } from "../../state/TuiAppStore.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";

export class TuiRenderScheduler {
    readonly #listeners = new Set<() => void>();
    readonly #unsubscribeStore: () => void;
    readonly #flushDelayMs: number;
    #lastObservedState: TuiAppState;
    #scheduled = false;
    #timer?: NodeJS.Timeout;

    constructor(readonly store: TuiAppStore, flushDelayMs = 16) {
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

export function isRenderRelevantChange(previous: TuiAppState, next: TuiAppState): boolean {
    if (previous === next) {
        return false;
    }
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
    ) {
        return true;
    }

    const page = next.ui.selectedPage;
    const instance = next.ui.selectedInstance;
    if (page === "instances") {
        return previous.snapshotsByInstance !== next.snapshotsByInstance ||
            previous.lastStatusChangeAtByInstance !== next.lastStatusChangeAtByInstance ||
            previous.approvalsByInstance !== next.approvalsByInstance ||
            previous.artifactShares !== next.artifactShares ||
            previous.artifactTransfers !== next.artifactTransfers ||
            previous.configView !== next.configView;
    }
    if (page === "connections") {
        return previous.oauthApprovals !== next.oauthApprovals ||
            previous.configView !== next.configView ||
            previous.mcpStatus !== next.mcpStatus ||
            selectedValueChanged(previous.snapshotsByInstance, next.snapshotsByInstance, instance);
    }
    if (page === "config") {
        return previous.configView !== next.configView ||
            selectedValueChanged(previous.snapshotsByInstance, next.snapshotsByInstance, instance);
    }
    if (page === "audit") {
        return selectedValueChanged(previous.approvalsByInstance, next.approvalsByInstance, instance) ||
            selectedValueChanged(previous.logsByInstance, next.logsByInstance, instance) ||
            selectedValueChanged(previous.toolCallsByInstance, next.toolCallsByInstance, instance) ||
            selectedValueChanged(previous.snapshotsByInstance, next.snapshotsByInstance, instance);
    }
    if (page === "logs") {
        return selectedValueChanged(previous.logsByInstance, next.logsByInstance, instance) ||
            selectedValueChanged(previous.snapshotsByInstance, next.snapshotsByInstance, instance);
    }
    if (page === "todo") {
        return selectedValueChanged(previous.todoByInstance, next.todoByInstance, instance) ||
            selectedValueChanged(previous.snapshotsByInstance, next.snapshotsByInstance, instance);
    }
    return false;
}

function selectedValueChanged<T>(previous: Record<string, T>, next: Record<string, T>, instance: string | undefined): boolean {
    return instance !== undefined && previous[instance] !== next[instance];
}
