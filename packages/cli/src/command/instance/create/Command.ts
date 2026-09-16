import type {
    InstanceCreateResult,
    ReverseDeviceCodeResult,
} from "@portable-devshell/shared";

import type { ControlClients } from "@portable-devshell/shared";

type CliClientInstance = ControlClients["instance"];
type CliClientReverse = ControlClients["reverse"];
import { CliWizardInstanceCreate } from "./Wizard.js";

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export class CliCommandInstanceCreate {
    async execute(
        instanceClient: CliClientInstance,
        reverseClient: CliClientReverse,
        wizard: CliWizardInstanceCreate,
    ): Promise<CliInstanceCreateResult | undefined> {
        const schema = await instanceClient.createSchema();
        const prepared = await wizard.run(
            schema,
            async (draft) => await instanceClient.validateCreate(draft),
        );
        if (prepared === undefined) {
            return undefined;
        }
        const result = await instanceClient.create(prepared.draft);
        if (prepared.draft.provider !== "reverse") {
            return result;
        }
        return {
            ...result,
            reverseDeviceCode: await reverseClient.createCode(result.name),
        };
    }
}

import type { CliDispatchContext } from "../../Dispatch.js";
import { renderInstanceCreateResult } from "./Render.js";

export async function executeInstanceCreate(
    command: import("../../Parse.js").CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (command.kind !== "instance.create") return false;
    const result = await new CliCommandInstanceCreate().execute(
        context.clients.instance,
        context.clients.reverse,
        new CliWizardInstanceCreate({
            input: context.stdin,
            output:
                context.outputFormat === "text"
                    ? context.stdout
                    : context.stderr,
        }),
    );
    if (result !== undefined)
        context.writeValue(result, renderInstanceCreateResult(result));
    return true;
}
