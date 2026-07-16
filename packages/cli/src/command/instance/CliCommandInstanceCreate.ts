import type { InstanceCreateResult, ReverseDeviceCodeResult } from "@portable-devshell/shared";

import type { CliClientInstance } from "../../client/instance/CliClientInstance.js";
import type { CliClientReverse } from "../../client/reverse/CliClientReverse.js";
import { CliWizardInstanceCreate } from "../../wizard/CliWizardInstanceCreate.js";

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export class CliCommandInstanceCreate {
    async execute(
        instanceClient: CliClientInstance,
        reverseClient: CliClientReverse,
        wizard: CliWizardInstanceCreate
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
