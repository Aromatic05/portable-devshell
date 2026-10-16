import type {
    InstanceCreateResult,
    InstanceTransport,
    ConnectionTransport,
    ReverseDeviceCodeResult,
} from "@portable-devshell/shared";

type CliClientInstance = InstanceTransport;
type CliClientReverse = ConnectionTransport;
import { CliWizardInstanceCreate } from "./Wizard.js";

export interface CliInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
    enrollmentError?: string;
}

export class CliCommandInstanceCreate {
    async execute(
        instanceClient: CliClientInstance,
        reverseClient: CliClientReverse,
        wizard: CliWizardInstanceCreate,
    ): Promise<CliInstanceCreateResult | undefined> {
        const schema = await instanceClient.createInstanceSchema();
        const prepared = await wizard.run(
            schema,
            async (draft) => await instanceClient.validateInstanceCreate(draft),
        );
        if (prepared === undefined) {
            return undefined;
        }
        const result = await instanceClient.createInstance(prepared.draft);
        if (prepared.draft.provider !== "reverse") {
            return result;
        }
        try {
            return {
                ...result,
                reverseDeviceCode: await reverseClient.createCode(result.name),
            };
        } catch (error) {
            // The instance already exists. Do not make a successful create
            // look like a failed operation that should be retried.
            return {
                ...result,
                enrollmentError:
                    error instanceof Error ? error.message : String(error),
            };
        }
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
