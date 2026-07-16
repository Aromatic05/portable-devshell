import type { TuiAppStore } from "../../store/TuiAppStore.js";
import { selectMainBoxFlowMetrics, selectMainBoxIds, selectMainScreenModel, selectMainScrollKey } from "../../store/TuiSelectors.js";

interface CommandFocusOptions {
    mainViewportRows(): number;
    store: TuiAppStore;
}

export class TuiCommandDispatcherFocus {
    readonly #mainViewportRows: CommandFocusOptions["mainViewportRows"];
    readonly #store: TuiAppStore;

    constructor(options: CommandFocusOptions) {
        this.#mainViewportRows = options.mainViewportRows;
        this.#store = options.store;
    }

    pauseLogFollow(): void {
        const state = this.#store.getState();
        if (state.ui.selectedPage === "logs" && state.ui.selectedInstance !== undefined) {
            this.#store.setLogsFollow(state.ui.selectedInstance, false);
        }
    }

    syncMainFocus(): void {
        const boxIds = selectMainBoxIds(this.#store.getState());
        if (boxIds.length === 0) {
            this.#store.setMainFocusId(undefined);
            return;
        }
        const current = this.#store.getState().ui.mainFocusId;
        if (current === undefined || !boxIds.includes(current)) {
            this.#store.setMainFocusId(boxIds[0]);
        }
        this.ensureMainFocusVisible();
    }

    expandedKey(boxId: string): string {
        const state = this.#store.getState();
        return selectMainScreenModel(state).boxes.find((box) => box.id === boxId)?.expandedKey ?? `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
    }

    instanceNameFromBox(boxId: string | undefined): string | undefined {
        return boxId?.startsWith("instance:") ? boxId.slice("instance:".length) : undefined;
    }

    approvalIdFromBox(boxId: string): string | undefined {
        const box = selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        const action = box?.expandedLines.find((line) => line.id?.startsWith(`${boxId}:approval.open:`));
        return action?.id?.slice(`${boxId}:approval.open:`.length);
    }

    scrollMainColumn(delta: number): boolean {
        const key = selectMainScrollKey(this.#store.getState());
        const current = this.#store.getState().ui.scrollOffsets[key] ?? 0;
        const next = clamp(delta === 0 ? current : current + delta, 0, this.maxMainScrollOffset());
        this.#store.setScrollOffset(key, next);
        return true;
    }

    setMainColumnOffset(offset: number): boolean {
        const key = selectMainScrollKey(this.#store.getState());
        this.#store.setScrollOffset(key, clamp(offset, 0, this.maxMainScrollOffset()));
        return true;
    }

    ensureMainFocusVisible(): void {
        const state = this.#store.getState();
        const boxId = state.ui.mainFocusId;
        if (boxId === undefined) {
            return;
        }

        const metrics = selectMainBoxFlowMetrics(state);
        const range = metrics.boxRanges[boxId];
        if (range === undefined) {
            return;
        }

        const viewportRows = this.boxViewportRows();
        if (viewportRows <= 0) {
            return;
        }

        const current = state.ui.scrollOffsets[metrics.scrollKey] ?? 0;
        if (range.start < current) {
            this.#store.setScrollOffset(metrics.scrollKey, range.start);
            return;
        }

        if (range.end > current + viewportRows) {
            this.#store.setScrollOffset(metrics.scrollKey, clamp(range.end - viewportRows, 0, this.maxMainScrollOffset()));
        }
    }

    boxViewportRows(): number {
        const model = selectMainScreenModel(this.#store.getState());
        return Math.max(0, this.#mainViewportRows() - 1 - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
    }

    maxMainScrollOffset(): number {
        const metrics = selectMainBoxFlowMetrics(this.#store.getState());
        return Math.max(0, metrics.totalLines - this.boxViewportRows());
    }}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
