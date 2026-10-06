import type { Instance } from "@portable-devshell/core";
import type {
    OAuthApprovalRequest,
    OperationalOverview,
} from "@portable-devshell/shared";

import type { OperationalOverviewInstanceCollection } from "./collector/Instance.js";
import type { OperationalOverviewSystemCollection } from "./collector/System.js";

export interface OperationalOverviewApi {
    read(): Promise<OperationalOverview>;
}

export interface OperationalOverviewRegistryPort {
    list(): readonly Instance[];
}

export interface OperationalOverviewApprovalPort {
    list(): Promise<readonly OAuthApprovalRequest[]>;
}

export interface OperationalOverviewInstanceCollectorPort {
    collect(
        descriptor: Instance,
        now: Date,
    ): Promise<OperationalOverviewInstanceCollection>;
}

export interface OperationalOverviewSystemCollectorPort {
    collect(): Promise<OperationalOverviewSystemCollection>;
}

export interface OperationalOverviewRuntime
    extends OperationalOverviewApi {}

export interface OperationalOverviewRuntimeOptions {
    instanceCollector: OperationalOverviewInstanceCollectorPort;
    instances: OperationalOverviewRegistryPort;
    now?: () => Date;
    oauthApprovals?: () => OperationalOverviewApprovalPort | undefined;
    processId?: () => number;
    systemCollector?: OperationalOverviewSystemCollectorPort;
    uptimeSeconds?: () => number;
}
