import type { InstanceCreateResult, ReverseDeviceCodeResult } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
import { InstanceCreateWizard } from "../../wizard/InstanceCreateWizard.js";

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export class CliCommandInstanceCreate {
    async execute(client: CliControlClientLike, wizard: InstanceCreateWizard): Promise<CliInstanceCreateResult | undefined> {
        const schema = await client.getInstanceCreateSchema();
        const prepared = await wizard.run(schema, async (draft) => await client.validateInstanceCreateDraft(draft));

        if (prepared === undefined) {
            return undefined;
        }

        const result = await client.createInstance(prepared.draft);
        if (prepared.draft.provider !== "reverse") {
            return result;
        }

        return {
            ...result,
            reverseDeviceCode: await client.createReverseDeviceCode(result.name)
        };
    }
}
