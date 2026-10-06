import type {
    OperationalOverviewRuntime,
    OperationalOverviewRuntimeOptions,
} from "./Api.js";
import { OperationalOverviewService } from "./Service.js";

export function createOperationalOverviewRuntime(
    options: OperationalOverviewRuntimeOptions,
): OperationalOverviewRuntime {
    return new OperationalOverviewService(options);
}
