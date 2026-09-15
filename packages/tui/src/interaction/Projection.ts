import type { TuiAppState } from "../state/store/Model.js";
import type { TuiMainBoxFlowMetrics, TuiMainScreenModel } from "../state/Ui.js";

export interface TuiInteractionProjection {
    selectMainBoxFlowMetrics(state: TuiAppState, boxInnerWidth?: number): TuiMainBoxFlowMetrics;
    selectMainBoxIds(state: TuiAppState): string[];
    selectMainScreenModel(state: TuiAppState): TuiMainScreenModel;
    selectMainScrollKey(state: TuiAppState): string;
}
