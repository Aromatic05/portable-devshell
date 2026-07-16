import type { TuiAppState } from "../state/reducer/TuiStoreModel.js";
import type { TuiMainBoxFlowMetrics, TuiMainScreenModel } from "../state/TuiViewModel.js";

export interface TuiInteractionProjection {
    selectMainBoxFlowMetrics(state: TuiAppState, boxInnerWidth?: number): TuiMainBoxFlowMetrics;
    selectMainBoxIds(state: TuiAppState): string[];
    selectMainScreenModel(state: TuiAppState): TuiMainScreenModel;
    selectMainScrollKey(state: TuiAppState): string;
}
