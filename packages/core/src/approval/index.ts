import type { ApprovalRuntimeOptions, ApprovalRuntime } from "./Api.js";





import { ApprovalService } from "./execution/Service.js";
import { InstanceApprovalStore } from "./Store.js";





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
