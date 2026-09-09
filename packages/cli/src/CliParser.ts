import type { JsonValue } from "@portable-devshell/shared";

import { CliRenderError } from "./render/CliRenderError.js";
import {
    renderCliTopicUsage,
    renderWatchUsage,
    type CliHelpTopic,
} from "./render/CliRenderUsage.js";

export type CliParsedCommand =
    | { kind: "help"; topic?: CliHelpTopic }
    | { kind: "version" }
    | { kind: "overview" }
    | { kind: "config.get" }
    | { draft: JsonValue; kind: "config.validate" }
    | { request: JsonValue; kind: "config.update" }
    | { kind: "approval.list"; instance: string }
    | { approvalId: string; decision: "approve" | "deny"; instance: string; kind: "approval.decide"; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    | { approvalId: string; instance: string; kind: "approval.show" }
    | { after?: string; before?: string; callId?: string; instance: string; kind: "tool.calls"; limit?: number }
    | { kind: "oauth.status" }
    | { kind: "oauth.list" }
    | { approvalId: string; decision: "approve" | "deny"; kind: "oauth.decide" }
    | { kind: "context.list" }
    | { ctxId?: string; instance: string; kind: "context.messages" }
    | { ctxId: string; instance: string; kind: "context.send"; text: string }
    | { ctxId: string; kind: "context.disable" }
    | { ctxId: string; kind: "context.renew" }
    | { kind: "debug.targets" }
    | { kind: "debug.list" }
    | { ctxId: string; file: string; kind: "debug.load"; target: string; toolName?: string }
    | { kind: "debug.release"; patchId: string }
    | { kind: "debug.unload"; patchId: string }
    | { instance: string; kind: "todo.delete"; taskId: string }
    | { kind: "control.logs" }
    | { kind: "control.restart" }
    | { kind: "control.start" }
    | { kind: "control.status" }
    | { kind: "control.stop" }
    | { kind: "tui" }
    | { kind: "extension.help" }
    | { kind: "extension.list" }
    | { extensionId: string; kind: "extension.inspect" }
    | { extensionId: string; kind: "extension.enable" | "extension.disable" | "extension.reload" }
    | { kind: "extension.install"; source: string }
    | { extensionId: string; kind: "extension.remove"; purge: boolean }
    | { args: string[]; commandId: string; kind: "cli.command" }
    | { kind: "instance.create" }
    | { instance: string; kind: "watch.logs" }
    | { instance: string; kind: "watch.status" }
    | { kind: "watch.help" };

export class CliParser {
    parse(argv: readonly string[]): CliParsedCommand {
        if (argv.length === 0) {
            return { kind: "control.status" };
        }
        const trailingHelp = this.#trailingHelp(argv);
        if (trailingHelp !== undefined) return trailingHelp;

        switch (argv[0]) {
            case "--version":
            case "-V":
                return this.#expectNoExtra(argv, { kind: "version" });
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help" });
            case "start":
                return this.#expectNoExtra(argv, { kind: "control.start" });
            case "restart":
                return this.#expectNoExtra(argv, { kind: "control.restart" });
            case "stop":
                return this.#expectNoExtra(argv, { kind: "control.stop" });
            case "status":
                return this.#expectNoExtra(argv, { kind: "control.status" });
            case "logs":
                return this.#expectNoExtra(argv, { kind: "control.logs" });
            case "overview":
                return this.#expectNoExtra(argv, { kind: "overview" });
            case "config":
                return this.#parseConfig(argv.slice(1));
            case "approval":
                return this.#parseApproval(argv.slice(1));
            case "tool":
                return this.#parseTool(argv.slice(1));
            case "todo":
                return this.#parseTodo(argv.slice(1));
            case "oauth":
                return this.#parseOAuth(argv.slice(1));
            case "context":
                return this.#parseContext(argv.slice(1));
            case "debug":
                return this.#parseDebug(argv.slice(1));
            case "tui":
                return this.#expectNoExtra(argv, { kind: "tui" });
            case "extension":
                return this.#parseExtension(argv.slice(1));
            case "instance": {
                const args = argv.slice(1);
                return args.length === 1 && args[0] === "create"
                    ? { kind: "instance.create" }
                    : this.#parseCliCommand(argv);
            }
            case "watch":
                return this.#parseWatch(argv.slice(1));
            default:
                return this.#parseCliCommand(argv);
        }
    }

    #trailingHelp(argv: readonly string[]): CliParsedCommand | undefined {
        const last = argv.at(-1);
        if (argv.length < 2 || (last !== "--help" && last !== "-h")) return undefined;
        switch (argv[0]) {
            case "extension":
                return { kind: "extension.help" };
            case "watch":
                return { kind: "watch.help" };
            case "config":
            case "approval":
            case "oauth":
            case "context":
            case "debug":
            case "tool":
            case "todo":
                return { kind: "help", topic: argv[0] };
            case "start":
            case "restart":
            case "stop":
            case "status":
            case "logs":
            case "overview":
            case "tui":
                return { kind: "help" };
            default:
                return undefined;
        }
    }

    #parseExtension(argv: readonly string[]): CliParsedCommand {
        if (argv.length === 0) return { kind: "extension.help" };
        if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
            return this.#expectNoExtra(argv, { kind: "extension.help" });
        }
        switch (argv[0]) {
            case "list":
                return this.#expectNoExtra(argv, { kind: "extension.list" });
            case "install":
                if (argv.length !== 2) throw CliRenderError.usage("extension install requires <bundle-or-directory>");
                return {
                    kind: "extension.install",
                    source: this.#required(argv[1], "extension install source is required")
                };
            case "remove": {
                if (argv.length < 2 || argv.length > 3) {
                    throw CliRenderError.usage("extension remove requires <extensionId> [--purge]");
                }
                const purge = argv[2] === "--purge";
                if (argv[2] !== undefined && !purge) {
                    throw CliRenderError.usage(`Unknown extension remove option: ${argv[2]}`);
                }
                return {
                    extensionId: this.#extensionId(argv[1]),
                    kind: "extension.remove",
                    purge
                };
            }
            case "inspect":
                if (argv.length !== 2) throw CliRenderError.usage("extension inspect requires <extensionId>");
                return {
                    extensionId: this.#extensionId(argv[1]),
                    kind: "extension.inspect"
                };
            case "enable":
            case "disable":
            case "reload":
                if (argv.length !== 2) {
                    throw CliRenderError.usage(`extension ${argv[0]} requires <extensionId>`);
                }
                return {
                    extensionId: this.#extensionId(argv[1]),
                    kind: `extension.${argv[0]}`
                } as CliParsedCommand;
            default:
                throw CliRenderError.usage(`Unknown extension command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseCliCommand(argv: readonly string[]): CliParsedCommand {
        const commandId = this.#cliCommandId(argv[0]);
        return {
            args: [...argv.slice(1)],
            commandId,
            kind: "cli.command"
        };
    }

    #cliCommandId(value: string | undefined): string {
        const commandId = this.#required(value, "CLI command id is required");
        if (/^[a-z][a-z0-9-]*$/u.test(commandId)) return commandId;
        throw CliRenderError.usage("CLI command id must match [a-z][a-z0-9-]*");
    }

    #extensionId(value: string | undefined): string {
        const extensionId = this.#required(value, "extension id is required");
        if (/^[a-z][a-z0-9-]*$/u.test(extensionId)) return extensionId;
        throw CliRenderError.usage("extension id must match [a-z][a-z0-9-]*");
    }

    #parseWatch(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "watch.help" });
            case "logs":
                if (argv.length !== 2) {
                    throw CliRenderError.usage("watch logs requires <instance>");
                }

                return {
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "watch.logs"
                };
            case "status":
                if (argv.length !== 2) {
                    throw CliRenderError.usage("watch status requires <instance>");
                }

                return {
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "watch.status"
                };
            default:
                throw CliRenderError.usage(
                    `${`Unknown watch command: ${argv[0] ?? ""}`.trim()}\n\n${renderWatchUsage()}`,
                );
        }
    }

    #parseConfig(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help", topic: "config" });
            case "get":
                return this.#expectNoExtra(argv, { kind: "config.get" });
            case "validate":
                return {
                    draft: this.#parseSingleJsonArgument(argv, "config validate requires <jsonDraft>"),
                    kind: "config.validate",
                };
            case "update":
                return {
                    kind: "config.update",
                    request: this.#parseSingleJsonArgument(argv, "config update requires <jsonUpdate>"),
                };
            case "instance":
                return this.#parseConfigPatch(argv.slice(1), "instance");
            case "mcp":
                return this.#parseConfigPatch(argv.slice(1), "mcp");
            case "web":
                return this.#parseConfigPatch(argv.slice(1), "web");
            default:
                throw CliRenderError.usage(`${`Unknown config command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("config")}`);
        }
    }

    #parseApproval(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help", topic: "approval" });
            case "list":
                return this.#expectInstanceCommand(argv, "approval.list");
            case "show":
                if (argv.length !== 3) throw CliRenderError.usage("approval show requires <instance> <approvalId>");
                return { approvalId: this.#required(argv[2], "approvalId is required"), instance: this.#required(argv[1], "instance name is required"), kind: "approval.show" };
            case "approve":
            case "deny":
                if (argv.length < 3) throw CliRenderError.usage(`approval ${argv[0]} requires <instance> <approvalId>`);
                return {
                    approvalId: this.#required(argv[2], "approvalId is required"),
                    decision: argv[0],
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "approval.decide",
                    ...this.#parseApprovalOptions(argv.slice(3)),
                };
            default:
                throw CliRenderError.usage(`${`Unknown approval command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("approval")}`);
        }
    }

    #parseOAuth(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help", topic: "oauth" });
            case "status":
                return this.#expectNoExtra(argv, { kind: "oauth.status" });
            case "list":
                return this.#expectNoExtra(argv, { kind: "oauth.list" });
            case "approve":
            case "deny":
                if (argv.length !== 2) {
                    throw CliRenderError.usage(`oauth ${argv[0]} requires <approvalId>`);
                }
                return {
                    approvalId: this.#required(argv[1], "approvalId is required"),
                    decision: argv[0],
                    kind: "oauth.decide",
                };
            default:
                throw CliRenderError.usage(`${`Unknown oauth command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("oauth")}`);
        }
    }

    #parseContext(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help", topic: "context" });
            case "list":
                return this.#expectNoExtra(argv, { kind: "context.list" });
            case "messages":
                if (argv.length !== 2 && argv.length !== 3) {
                    throw CliRenderError.usage("context messages requires <instance> [ctxId]");
                }
                return {
                    ...(argv[2] === undefined ? {} : { ctxId: this.#required(argv[2], "ctxId is required") }),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "context.messages",
                };
            case "send":
                if (argv.length !== 4) {
                    throw CliRenderError.usage("context send requires <instance> <ctxId> <text>");
                }
                return {
                    ctxId: this.#required(argv[2], "ctxId is required"),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "context.send",
                    text: this.#required(argv[3], "text is required"),
                };
            case "disable":
            case "renew":
                if (argv.length !== 2) {
                    throw CliRenderError.usage(`context ${argv[0]} requires <ctxId>`);
                }
                return {
                    ctxId: this.#required(argv[1], "ctxId is required"),
                    kind: argv[0] === "disable" ? "context.disable" : "context.renew",
                };
            default:
                throw CliRenderError.usage(`${`Unknown context command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("context")}`);
        }
    }

    #parseTool(argv: readonly string[]): CliParsedCommand {
        if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
            return this.#expectNoExtra(argv, { kind: "help", topic: "tool" });
        }
        if (argv[0] !== "calls" || argv.length < 2) {
            throw CliRenderError.usage(`tool calls requires <instance> [callId] [--limit <n>] [--before <callId>] [--after <callId>]\n\n${renderCliTopicUsage("tool")}`);
        }
        let optionOffset = 2;
        const callId = argv[2] !== undefined && !argv[2].startsWith("--")
            ? this.#required(argv[2], "callId is required")
            : undefined;
        if (callId !== undefined) optionOffset += 1;
        const options = this.#parseToolCallOptions(argv.slice(optionOffset));
        if (callId !== undefined && (options.after !== undefined || options.before !== undefined || options.limit !== undefined)) {
            throw CliRenderError.usage("tool calls does not accept pagination options with an exact callId");
        }
        return {
            ...(callId === undefined ? {} : { callId }),
            instance: this.#required(argv[1], "instance name is required"),
            kind: "tool.calls",
            ...options,
        };
    }

    #parseDebug(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "help", topic: "debug" });
            case "targets":
                return this.#expectNoExtra(argv, { kind: "debug.targets" });
            case "list":
                return this.#expectNoExtra(argv, { kind: "debug.list" });
            case "load":
                if (
                    (argv.length !== 5 && argv.length !== 7) ||
                    argv[3] !== "--ctx" ||
                    (argv.length === 7 && argv[5] !== "--tool")
                ) {
                    throw CliRenderError.usage(
                        "debug load requires <target> <file> --ctx <ctxId> [--tool <toolName>]",
                    );
                }
                return {
                    ctxId: this.#required(argv[4], "debug ctxId is required"),
                    file: this.#required(argv[2], "debug patch file is required"),
                    kind: "debug.load",
                    target: this.#required(argv[1], "debug target is required"),
                    ...(argv[6] === undefined
                        ? {}
                        : { toolName: this.#required(argv[6], "debug toolName is required") }),
                };
            case "release":
            case "unload":
                if (argv.length !== 2) {
                    throw CliRenderError.usage(`debug ${argv[0]} requires <patchId>`);
                }
                return {
                    kind: argv[0] === "release" ? "debug.release" : "debug.unload",
                    patchId: this.#required(argv[1], "debug patchId is required"),
                };
            default:
                throw CliRenderError.usage(
                    `${`Unknown debug command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("debug")}`,
                );
        }
    }

    #parseToolCallOptions(argv: readonly string[]): { after?: string; before?: string; limit?: number } {
        let after: string | undefined;
        let before: string | undefined;
        let limit: number | undefined;
        for (let index = 0; index < argv.length; index += 2) {
            const option = argv[index];
            const value = argv[index + 1];
            if (value === undefined || (option !== "--after" && option !== "--before" && option !== "--limit")) {
                throw CliRenderError.usage("tool calls options are --limit <n>, --before <callId>, or --after <callId>");
            }
            if (option === "--after") after = this.#required(value, "after callId is required");
            else if (option === "--before") before = this.#required(value, "before callId is required");
            else {
                const parsed = Number(value);
                if (!Number.isSafeInteger(parsed) || parsed < 1) {
                    throw CliRenderError.usage("tool calls --limit requires a positive integer");
                }
                limit = parsed;
            }
        }
        return {
            ...(after === undefined ? {} : { after }),
            ...(before === undefined ? {} : { before }),
            ...(limit === undefined ? {} : { limit }),
        };
    }

    #parseTodo(argv: readonly string[]): CliParsedCommand {
        if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
            return this.#expectNoExtra(argv, { kind: "help", topic: "todo" });
        }
        if (argv[0] !== "delete" || argv.length !== 3) {
            throw CliRenderError.usage(`todo delete requires <instance> <taskId>\n\n${renderCliTopicUsage("todo")}`);
        }
        return { instance: this.#required(argv[1], "instance name is required"), kind: "todo.delete", taskId: this.#required(argv[2], "taskId is required") };
    }

    #parseConfigPatch(argv: readonly string[], target: "instance" | "mcp" | "web"): CliParsedCommand {
        if (target === "instance") {
            if (argv[0] !== "patch" || argv.length !== 3) throw CliRenderError.usage("config instance patch requires <instance> <jsonPatch>");
            return { kind: "config.update", request: { instance: { instanceName: this.#required(argv[1], "instance name is required"), patch: this.#parseJson(this.#required(argv[2], "JSON patch is required")) } } };
        }
        if (argv[0] !== "patch" || argv.length !== 2) throw CliRenderError.usage(`config ${target} patch requires <jsonPatch>`);
        return { kind: "config.update", request: { [target]: this.#parseJson(this.#required(argv[1], "JSON patch is required")) } };
    }

    #parseApprovalOptions(argv: readonly string[]): { policyPatch?: JsonValue; reason?: string; remember?: boolean } {
        let policyPatch: JsonValue | undefined;
        let reason: string | undefined;
        let remember = false;
        for (let index = 0; index < argv.length; index += 1) {
            const option = argv[index]!;
            if (option === "--remember") { remember = true; continue; }
            const value = argv[index + 1];
            if ((option !== "--reason" && option !== "--policy-patch") || value === undefined) {
                throw CliRenderError.usage("approval options are --reason <text>, --remember, or --policy-patch <json>");
            }
            if (option === "--reason") reason = this.#required(value, "reason is required");
            else policyPatch = this.#parseJson(this.#required(value, "policy patch is required"));
            index += 1;
        }
        return { ...(policyPatch === undefined ? {} : { policyPatch }), ...(reason === undefined ? {} : { reason }), ...(remember ? { remember: true } : {}) };
    }

    #expectNoExtra<T extends CliParsedCommand>(argv: readonly string[], value: T): T {
        if (argv.length !== 1) {
            throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
        }

        return value;
    }

    #parseSingleJsonArgument(argv: readonly string[], message: string): JsonValue {
        if (argv.length !== 2) throw CliRenderError.usage(message);
        return this.#parseJson(this.#required(argv[1], "JSON input is required"));
    }

    #required(value: string | undefined, message: string): string {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }

        throw CliRenderError.usage(message);
    }

    #parseJson(source: string): JsonValue {
        try {
            return JSON.parse(source) as JsonValue;
        } catch {
            throw CliRenderError.usage("tool input must be valid JSON");
        }
    }

    #expectInstanceCommand(
        argv: readonly string[],
        kind: "approval.list"
    ): Extract<CliParsedCommand, { kind: typeof kind }> {
        if (argv.length !== 2) {
            throw CliRenderError.usage(`${kind.split(".")[1]} requires <instance>`);
        }

        return {
            instance: this.#required(argv[1], "instance name is required"),
            kind
        } as Extract<CliParsedCommand, { kind: typeof kind }>;
    }

}
