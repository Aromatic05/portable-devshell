import { renderExpandableBoxLines } from "../../../view/component/content/Box.js";
import type { TuiAppStore } from "../../../state/store/App.js";
import type { TuiInteractionProjection } from "../../Projection.js";
import { overviewInstanceViewportRows, tuiMessagesHistoryRows, tuiBlockHeight } from "../../../terminal/Public.js";

interface CommandFocusOptions {
    mainBoxInnerColumns?(): number;
    mainContentColumns?(): number;
    mainViewportRows(): number;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherFocus {
    readonly #mainBoxInnerColumns: () => number;
    readonly #mainContentColumns: () => number;
    readonly #mainViewportRows: CommandFocusOptions["mainViewportRows"];
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: CommandFocusOptions) {
        this.#mainBoxInnerColumns = options.mainBoxInnerColumns ?? (() => 80);
        this.#mainContentColumns = options.mainContentColumns ?? (() => 84);
        this.#mainViewportRows = options.mainViewportRows;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    syncMainFocus(): void {
        const boxIds = this.#projection.selectMainBoxIds(
            this.#store.getState(),
        );
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
        return (
            this.#projection
                .selectMainScreenModel(state)
                .boxes.find((box) => box.id === boxId)?.expandedKey ??
            `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`
        );
    }

    instanceNameFromBox(boxId: string | undefined): string | undefined {
        return boxId?.startsWith("instance:")
            ? boxId.slice("instance:".length)
            : undefined;
    }

    approvalIdFromBox(boxId: string): string | undefined {
        const box = this.#projection
            .selectMainScreenModel(this.#store.getState())
            .boxes.find((candidate) => candidate.id === boxId);
        const action = box?.expandedLines.find((line) =>
            line.id?.startsWith(`${boxId}:approval.open:`),
        );
        return action?.id?.slice(`${boxId}:approval.open:`.length);
    }

    mainContentColumns(): number {
        return this.#mainContentColumns();
    }

    mainViewportRows(): number {
        return this.#mainViewportRows();
    }

    scrollMainColumn(delta: number): boolean {
        const state = this.#store.getState();
        const key = this.#projection.selectMainScrollKey(state);
        const max = this.maxMainScrollOffset();
        const stored = state.ui.scrollOffsets[key];
        const current = clamp(stored ?? 0, 0, max);
        const next = clamp(delta === 0 ? current : current + delta, 0, max);
        const target =
            state.ui.selectedPage === "messages" && next === max
                ? Number.MAX_SAFE_INTEGER
                : next;
        if (stored === target || (stored === undefined && target === 0)) {
            return true;
        }
        this.#store.setScrollOffset(key, target);
        return true;
    }

    setMainColumnOffset(offset: number): boolean {
        const state = this.#store.getState();
        const key = this.#projection.selectMainScrollKey(state);
        const max = this.maxMainScrollOffset();
        const next = clamp(offset, 0, max);
        const target =
            state.ui.selectedPage === "messages" && next === max
                ? Number.MAX_SAFE_INTEGER
                : next;
        const stored = state.ui.scrollOffsets[key];
        if (stored === target || (stored === undefined && target === 0)) {
            return true;
        }
        this.#store.setScrollOffset(key, target);
        return true;
    }

    ensureMainFocusVisible(): void {
        const state = this.#store.getState();
        const boxId = state.ui.mainFocusId;
        if (boxId === undefined) {
            return;
        }

        const metrics = this.#projection.selectMainBoxFlowMetrics(
            state,
            this.#mainFlowColumns(state),
        );
        let range = metrics.boxRanges[boxId];
        if (range === undefined) {
            return;
        }

        if (state.interaction.focusScope === "form" || state.interaction.focusScope === "wizard") {
            const box = this.#projection.selectMainScreenModel(state).boxes.find((item) => item.id === boxId);
            if (box !== undefined) {
                const selected = state.interaction.selectedDetailLineIds[box.expandedKey];
                const row = renderExpandableBoxLines(box, this.#mainFlowColumns(state))
                    .findIndex((line) => line.lineId === selected);
                if (row >= 0) range = { start: range.start + row, end: range.start + row + 1 };
            }
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
            this.#store.setScrollOffset(
                metrics.scrollKey,
                clamp(range.end - viewportRows, 0, this.maxMainScrollOffset()),
            );
        }
    }

    boxViewportRows(): number {
        const state = this.#store.getState();
        const model = this.#projection.selectMainScreenModel(state);
        const stateRows = model.loadState.kind === "ready" ? 0 : 1;
        if (state.ui.selectedPage === "overview") {
            const overviewRows = Math.max(
                0,
                this.#mainViewportRows() -
                    tuiBlockHeight(model.errorLines) -
                    stateRows -
                    (model.statusLine === undefined ? 0 : 1),
            );
            return overviewInstanceViewportRows(overviewRows);
        }
        if (state.ui.selectedPage === "messages") {
            return tuiMessagesHistoryRows(this.#mainViewportRows());
        }
        return Math.max(
            0,
            this.#mainViewportRows() -
                1 -
                tuiBlockHeight(model.errorLines) -
                stateRows -
                (model.statusLine === undefined ? 0 : 1) -
                (model.emptyState === undefined ? 0 : 1),
        );
    }

    maxMainScrollOffset(): number {
        const state = this.#store.getState();
        const metrics = this.#projection.selectMainBoxFlowMetrics(
            state,
            this.#mainFlowColumns(state),
        );
        return Math.max(0, metrics.totalLines - this.boxViewportRows());
    }

    #mainFlowColumns(state: ReturnType<TuiAppStore["getState"]>): number {
        return state.ui.selectedPage === "messages"
            ? this.#mainContentColumns()
            : this.#mainBoxInnerColumns();
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
