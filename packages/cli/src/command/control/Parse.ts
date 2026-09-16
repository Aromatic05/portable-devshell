import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export function parseConfigCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case "help":
        case "--help":
        case "-h":
            return expectNoExtra(argv, { kind: "help", topic: "config" });
        case "get":
            return expectNoExtra(argv, { kind: "config.get" });
        case "validate":
            return {
                draftSource: singleJsonSource(
                    argv,
                    "config validate requires <jsonDraft|@file|->",
                ),
                kind: "config.validate",
            };
        case "update":
            return {
                input: {
                    kind: "batch",
                    source: singleJsonSource(
                        argv,
                        "config update requires <jsonUpdate|@file|->",
                    ),
                },
                kind: "config.update",
            };
        case "instance":
            return parsePatch(argv.slice(1), "instance");
        case "mcp":
            return parsePatch(argv.slice(1), "mcp");
        case "web":
            return parsePatch(argv.slice(1), "web");
        default:
            throw CliRenderError.usage(
                `${`Unknown config command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("config")}`,
            );
    }
}

function parsePatch(
    argv: readonly string[],
    target: "instance" | "mcp" | "web",
): CliParsedCommand {
    if (target === "instance") {
        if (argv[0] !== "patch" || argv.length !== 3)
            throw CliRenderError.usage(
                "config instance patch requires <instance> <jsonPatch>",
            );
        return {
            input: {
                instance: required(argv[1], "instance name is required"),
                kind: "instance",
                source: required(argv[2], "JSON patch source is required"),
            },
            kind: "config.update",
        };
    }
    if (argv[0] !== "patch" || argv.length !== 2)
        throw CliRenderError.usage(
            `config ${target} patch requires <jsonPatch>`,
        );
    return {
        input: {
            kind: target,
            source: required(argv[1], "JSON patch source is required"),
        },
        kind: "config.update",
    };
}

function singleJsonSource(argv: readonly string[], message: string): string {
    if (argv.length !== 2) throw CliRenderError.usage(message);
    return required(argv[1], "JSON source is required");
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
