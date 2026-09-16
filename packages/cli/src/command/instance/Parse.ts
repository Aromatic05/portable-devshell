import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderInstanceUsage, renderWatchUsage } from "../Usage.js";

export function parseInstanceCommand(
    argv: readonly string[],
): CliParsedCommand {
    switch (argv[0]) {
        case "help":
        case "--help":
        case "-h":
            return expectNoExtra(argv, { kind: "instance.help" });
        case "create":
            return expectNoExtra(argv, { kind: "instance.create" });
        case "delete":
            return expectInstance(argv, "instance.delete");
        case "enable":
            return expectInstance(argv, "instance.enable");
        case "disable":
            return expectInstance(argv, "instance.disable");
        case "device-code":
            return expectReverse(argv, "instance.deviceCode");
        case "list":
            return expectNoExtra(argv, { kind: "instance.list" });
        case "status":
            return expectInstance(argv, "instance.status");
        case "start":
            return expectInstance(argv, "instance.start");
        case "stop":
            return expectInstance(argv, "instance.stop");
        case "rotate-token":
            return expectReverse(argv, "instance.rotateToken");
        case "revoke-token":
            return expectReverse(argv, "instance.revokeToken");
        case "logs":
            expectLogsArgs(argv);
            return {
                follow: argv.includes("-f"),
                instance: required(argv[1], "instance name is required"),
                kind: "instance.logs",
            };
        case "todo":
            expectTodoArgs(argv);
            return {
                follow: argv.includes("--follow") || argv.includes("-f"),
                instance: required(argv[1], "instance name is required"),
                kind: "instance.todo",
            };
        case "call":
            if (argv.length !== 5)
                throw CliRenderError.usage(
                    "instance call requires <instance> <workspace> <toolName> <json|@file|->",
                );
            return {
                inputSource: required(argv[4], "tool input source is required"),
                instance: required(argv[1], "instance name is required"),
                kind: "instance.call",
                toolName: required(argv[3], "tool name is required"),
                workspace: required(argv[2], "workspace is required"),
            };
        default:
            throw CliRenderError.usage(
                `${`Unknown instance command: ${argv[0] ?? ""}`.trim()}\n\n${renderInstanceUsage()}`,
            );
    }
}

export function parseWatchCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case "help":
        case "--help":
        case "-h":
            return expectNoExtra(argv, { kind: "watch.help" });
        case "logs":
            if (argv.length !== 2)
                throw CliRenderError.usage("watch logs requires <instance>");
            return {
                instance: required(argv[1], "instance name is required"),
                kind: "watch.logs",
            };
        case "status":
            if (argv.length !== 2)
                throw CliRenderError.usage("watch status requires <instance>");
            return {
                instance: required(argv[1], "instance name is required"),
                kind: "watch.status",
            };
        default:
            throw CliRenderError.usage(
                `${`Unknown watch command: ${argv[0] ?? ""}`.trim()}\n\n${renderWatchUsage()}`,
            );
    }
}
function expectInstance(
    argv: readonly string[],
    kind:
        | "instance.delete"
        | "instance.disable"
        | "instance.enable"
        | "instance.start"
        | "instance.status"
        | "instance.stop",
): CliParsedCommand {
    if (argv.length !== 2)
        throw CliRenderError.usage(`${kind.split(".")[1]} requires <instance>`);
    return {
        instance: required(argv[1], "instance name is required"),
        kind,
    } as CliParsedCommand;
}
function expectReverse(
    argv: readonly string[],
    kind:
        "instance.deviceCode" | "instance.rotateToken" | "instance.revokeToken",
): CliParsedCommand {
    if (argv.length !== 2)
        throw CliRenderError.usage(`${argv[0]} requires <instance>`);
    return {
        instance: required(argv[1], "instance name is required"),
        kind,
    } as CliParsedCommand;
}
function expectTodoArgs(argv: readonly string[]): void {
    if (
        argv.length === 2 ||
        (argv.length === 3 && (argv[2] === "--follow" || argv[2] === "-f"))
    )
        return;
    throw CliRenderError.usage("instance todo requires <instance> [--follow]");
}
function expectLogsArgs(argv: readonly string[]): void {
    if (argv.length === 2 || (argv.length === 3 && argv[2] === "-f")) return;
    throw CliRenderError.usage("instance logs requires <instance> [-f]");
}
function required(value: string | undefined, message: string): string {
    if (value) return value;
    throw CliRenderError.usage(message);
}
function expectNoExtra<T extends CliParsedCommand>(
    argv: readonly string[],
    value: T,
): T {
    if (argv.length !== 1)
        throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
    return value;
}
