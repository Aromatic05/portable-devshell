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
                    command.draft as ConfigDraft,
                ),
            );
            return true;
        case "config.update":
            context.writeJson(
                await context.clients.config.update(
                    command.request as ConfigBatchUpdateRequest,
                ),
            );
            return true;
        default:
            return false;
    }
}
