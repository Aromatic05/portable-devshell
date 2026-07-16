import type { InstanceCreateResult, ReverseDeviceCodeResult } from "@portable-devshell/shared";

import type { InstanceClient } from "../../modules/instance/InstanceClient.js";
import type { ReverseClient } from "../../modules/reverse/ReverseClient.js";
import { InstanceCreateWizard } from "../../wizard/InstanceCreateWizard.js";

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export class CliCommandInstanceCreate {
    async execute(
        instanceClient: InstanceClient,
        reverseClient: ReverseClient,
        wizard: InstanceCreateWizard
    ): Promise<CliInstanceCreateResult | undefined> {
        const schema = await instanceClient.createSchema();
        const prepared = await wizard.run(schema, async (draft) => await instanceClient.validateCreate(draft));
        if (prepared === undefined) {
            return undefined;
        }
        const result = await instanceClient.create(prepared.draft);
        if (prepared.draft.provider !== "reverse") {
            return result;
        }
        return {
            ...result,
            reverseDeviceCode: await reverseClient.createCode(result.name)
        };
    }
}
