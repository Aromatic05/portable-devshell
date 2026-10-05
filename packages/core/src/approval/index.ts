import type {
    ApprovalEventType,
    InstanceName,
    JsonValue,
    ApprovalRequest,
} from "@portable-devshell/shared";
import type { ApprovalPolicy } from "@portable-devshell/shared/config";
import type { StateStore } from "../audit/database/index.js";

import type { ApprovalApi } from "./Api.js";
import { ApprovalService } from "./execution/Service.js";
import { InstanceApprovalStore } from "./Store.js";

export interface ApprovalRuntimeOptions {
    appendEvent(
        type: ApprovalEventType,
        data: Record<string, JsonValue>,
    ): Promise<unknown>;
    instanceName: InstanceName;
    stateStore: StateStore<ApprovalRequest>;
    policy?: ApprovalPolicy;
}

export interface ApprovalRuntime {
    readonly api: ApprovalApi;
    close(): void;
    retire(reason?: string): Promise<void>;
    setPolicy(policy: ApprovalPolicy | undefined): void;
}

export function createApprovalRuntime(
    options: ApprovalRuntimeOptions,
): ApprovalRuntime {
    const service = new ApprovalService({
        events: {
            append: options.appendEvent,
        },
        instanceName: options.instanceName,
        policy: options.policy,
        store: new InstanceApprovalStore(options.stateStore),
    });
    return {
        api: service,
        close: () => service.close(),
        retire: async (reason) => await service.retire(reason),
        setPolicy: (policy) => service.setPolicy(policy),
    };
}
