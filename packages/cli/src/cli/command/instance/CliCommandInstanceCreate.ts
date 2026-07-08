import type { InstanceCreateResult } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
import { InstanceCreateWizard } from "../../wizard/InstanceCreateWizard.js";

export class CliCommandInstanceCreate {
    async execute(client: CliControlClientLike, wizard: InstanceCreateWizard): Promise<InstanceCreateResult | undefined> {
        const schema = await client.getInstanceCreateSchema();
        const prepared = await wizard.run(schema, async (draft) => await client.validateInstanceCreateDraft(draft));

        if (prepared === undefined) {
            return undefined;
        }

        return await client.createInstance(prepared.draft);
    }
}
