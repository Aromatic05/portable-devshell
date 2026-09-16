import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
} from "@portable-devshell/shared";
import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";

export async function executeConfigCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "config.get":
            context.writeJson(await context.clients.config.get());
            return true;
        case "config.validate":
            context.writeJson(
                await context.clients.config.validate(
                    (await context.readJson(
                        command.draftSource,
                        "config draft",
                    )) as ConfigDraft,
                ),
            );
            return true;
        case "config.update": {
            const input = command.input;
            const request =
                input.kind === "batch"
                    ? ((await context.readJson(
                          input.source,
                          "config update",
                      )) as ConfigBatchUpdateRequest)
                    : input.kind === "instance"
                      ? ({
                            instance: {
                                instanceName: input.instance,
                                patch: await context.readJson(
                                    input.source,
                                    "instance config patch",
                                ),
                            },
                        } as ConfigBatchUpdateRequest)
                      : ({
                            [input.kind]: await context.readJson(
                                input.source,
                                `${input.kind} config patch`,
                            ),
                        } as ConfigBatchUpdateRequest);
            context.writeJson(await context.clients.config.update(request));
            return true;
        }
        default:
            return false;
    }
}
