import type { JsonValue } from "@portable-devshell/shared";
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
                draft: parseSingleJson(
                    argv,
                    "config validate requires <jsonDraft>",
                ),
                kind: "config.validate",
            };
        case "update":
            return {
                kind: "config.update",
                request: parseSingleJson(
                    argv,
                    "config update requires <jsonUpdate>",
                ),
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
            kind: "config.update",
            request: {
                instance: {
                    instanceName: required(
                        argv[1],
                        "instance name is required",
                    ),
                    patch: parseJson(
                        required(argv[2], "JSON patch is required"),
                    ),
                },
            },
        };
    }
    if (argv[0] !== "patch" || argv.length !== 2)
        throw CliRenderError.usage(
            `config ${target} patch requires <jsonPatch>`,
        );
    return {
        kind: "config.update",
        request: {
            [target]: parseJson(required(argv[1], "JSON patch is required")),
        },
    };
}

function parseSingleJson(argv: readonly string[], message: string): JsonValue {
    if (argv.length !== 2) throw CliRenderError.usage(message);
    return parseJson(required(argv[1], "JSON input is required"));
}
function parseJson(source: string): JsonValue {
    try {
        return JSON.parse(source) as JsonValue;
    } catch {
        throw CliRenderError.usage("tool input must be valid JSON");
    }
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
