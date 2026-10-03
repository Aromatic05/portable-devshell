import type { TuiAppState } from "../state/store/Model.js";
import type {
    TuiMainBoxFlowMetrics,
    TuiMainScreenModel,
    TuiSidebarModel,
} from "../state/Ui.js";
import type { TuiDomainReader } from "../view/domain/Reader.js";

export interface TuiInteractionProjection {
    readonly domains: TuiDomainReader;
    selectMainBoxFlowMetrics(
        state: TuiAppState,
        boxInnerWidth?: number,
    ): TuiMainBoxFlowMetrics;
    selectMainBoxIds(state: TuiAppState): string[];
    selectMainScreenModel(state: TuiAppState): TuiMainScreenModel;
    selectMainScrollKey(state: TuiAppState): string;
    selectSidebarModel(state: TuiAppState): TuiSidebarModel;
}
