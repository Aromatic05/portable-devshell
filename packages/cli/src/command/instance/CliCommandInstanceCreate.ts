import type {
    ControlClients,
    InstanceCreateDraft,
    InstanceCreateResult,
    ReverseDeviceCodeResult
} from "@portable-devshell/shared";

import type { CliClientCommand } from "../../client/CliCommandAdapter.js";
import { CliWizardInstanceCreate } from "../../wizard/CliWizardInstanceCreate.js";

type CliClientInstanceCreatePresentation = Pick<
    ControlClients["instance"],
    "createSchema" | "validateCreate"
>;

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export class CliCommandInstanceCreate {
    async execute(
        instanceClient: CliClientInstanceCreatePresentation,
        commandClient: CliClientCommand,
        wizard: CliWizardInstanceCreate
    ): Promise<CliInstanceCreateResult | undefined> {
        const schema = await instanceClient.createSchema();
        const prepared = await wizard.run(schema, async (draft) => await instanceClient.validateCreate(draft));
        if (prepared === undefined) return undefined;
        return readCreateResult(await commandClient.command(
            "instance",
            ["create", JSON.stringify(prepared.draft satisfies InstanceCreateDraft)]
        ));
    }
}

function readCreateResult(
    result: Awaited<ReturnType<CliClientCommand["command"]>>
): CliInstanceCreateResult {
    if (result.kind !== "json" || typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
        throw new Error("Instance create command returned an invalid result.");
    }
    const value = result.value as unknown as CliInstanceCreateResult;
    if (typeof value.name !== "string" || typeof value.enabled !== "boolean") {
        throw new Error("Instance create command returned an invalid result.");
    }
    return value;
}
