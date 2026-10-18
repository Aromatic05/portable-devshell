import type { JsonValue } from "@portable-devshell/shared";
import type { TuiAppState } from "../state/store/Model.js";
import type {
    TuiMainBoxFlowMetrics,
    TuiMainScreenModel,
    TuiSidebarModel,
} from "../state/Ui.js";
import type { TuiDomainReader } from "../app/control/Reader.js";

export interface TuiInteractionProjection {
    auditInputText(input: JsonValue | undefined, fallback: string | undefined): string;
    auditOutputText(output: JsonValue | undefined): string;
    readonly domains: TuiDomainReader;
    resolveAuditOutput(
        output: JsonValue | undefined,
        instance: string,
        callId: string,
    ): JsonValue | undefined;
    selectMainBoxFlowMetrics(
        state: TuiAppState,
        boxInnerWidth?: number,
    ): TuiMainBoxFlowMetrics;
    selectMainBoxIds(state: TuiAppState): string[];
    selectMainScreenModel(state: TuiAppState): TuiMainScreenModel;
    selectMainScrollKey(state: TuiAppState): string;
    selectSidebarModel(state: TuiAppState): TuiSidebarModel;
}
