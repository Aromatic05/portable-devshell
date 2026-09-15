import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";

export function parseContextMessageCommand(
    argv: readonly string[],
): CliParsedCommand {
    if (argv[0] === "messages") {
        if (argv.length !== 2 && argv.length !== 3)
            throw CliRenderError.usage(
                "context messages requires <instance> [ctxId]",
            );
        return {
            ...(argv[2] === undefined
                ? {}
                : { ctxId: required(argv[2], "ctxId is required") }),
            instance: required(argv[1], "instance name is required"),
            kind: "context.messages",
        };
    }
    if (argv[0] === "send") {
        if (argv.length !== 4)
            throw CliRenderError.usage(
                "context send requires <instance> <ctxId> <text>",
            );
        return {
            ctxId: required(argv[2], "ctxId is required"),
            instance: required(argv[1], "instance name is required"),
            kind: "context.send",
            text: required(argv[3], "text is required"),
        };
    }
    throw CliRenderError.usage("context message command is invalid");
}
function required(value: string | undefined, message: string): string {
    if (value) return value;
    throw CliRenderError.usage(message);
}

import type { CliDispatchContext } from "../Dispatch.js";
export async function executeContextMessage(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "context.messages":
            context.writeJson(
                await context.clients.contextMessage.list(
                    command.instance,
                    command.ctxId,
                ),
            );
            return true;
        case "context.send":
            context.writeJson(
                await context.clients.contextMessage.queue(command.instance, {
                    ctxId: command.ctxId,
                    text: command.text,
                }),
            );
            return true;
        default:
            return false;
    }
}
