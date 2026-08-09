import type { JsonValue } from "@portable-devshell/shared";

import { CliRenderError } from "./render/CliRenderError.js";
import { renderCliUsage, renderInstanceUsage, renderWatchUsage } from "./render/CliRenderUsage.js";

export type CliParsedCommand =
    | { kind: "help" }
    | { kind: "overview" }
    | { kind: "config.get" }
    | { draft: JsonValue; kind: "config.validate" }
    | { request: JsonValue; kind: "config.update" }
    | { kind: "approval.list"; instance: string }
    | { approvalId: string; decision: "approve" | "deny"; instance: string; kind: "approval.decide"; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    | { approvalId: string; instance: string; kind: "approval.show" }
    | { callId?: string; instance: string; kind: "tool.calls" }
    | { kind: "oauth.status" }
    | { kind: "oauth.list" }
    | { approvalId: string; decision: "approve" | "deny"; kind: "oauth.decide" }
    | { kind: "context.list" }
    | { ctxId?: string; instance: string; kind: "context.messages" }
    | { ctxId: string; instance: string; kind: "context.send"; text: string }
    | { ctxId: string; kind: "context.disable" }
    | { ctxId: string; kind: "context.renew" }
    | { instance: string; kind: "todo.delete"; taskId: string }
    | { kind: "control.logs" }
    | { kind: "control.restart" }
    | { kind: "control.start" }
    | { kind: "control.status" }
    | { kind: "control.stop" }
    | { args: string[]; kind: "artifact" }
    | { kind: "tui" }
    | { input: JsonValue; instance: string; kind: "instance.call"; toolName: string }
    | { kind: "instance.create" }
    | { instance: string; kind: "instance.delete" }
    | { instance: string; kind: "instance.enable" }
    | { instance: string; kind: "instance.disable" }
    | { kind: "instance.help" }
    | { instance: string; kind: "instance.deviceCode" }
    | { kind: "instance.list" }
    | { follow: boolean; instance: string; kind: "instance.logs" }
    | { follow: boolean; instance: string; kind: "instance.todo" }
    | { instance: string; kind: "instance.start" }
    | { instance: string; kind: "instance.status" }
    | { instance: string; kind: "instance.stop" }
    | { instance: string; kind: "instance.revokeToken" }
    | { instance: string; kind: "instance.rotateToken" }
    | { instance: string; kind: "watch.logs" }
    | { instance: string; kind: "watch.status" }
    | { kind: "watch.help" };

export class CliParser {
    parse(argv: readonly string[]): CliParsedCommand {
        if (argv.length === 0) {
            return { kind: "control.status" };
        }

        switch (argv[0]) {
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
            case "artifact":
                return { args: [...argv.slice(1)], kind: "artifact" };
            case "tui":
                return this.#expectNoExtra(argv, { kind: "tui" });
            case "instance":
                return this.#parseInstance(argv.slice(1));
            case "watch":
                return this.#parseWatch(argv.slice(1));
            default:
                throw CliRenderError.usage(`Unknown command: ${argv[0]}\n\n${renderCliUsage()}`);
        }
    }

    #parseInstance(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "help":
            case "--help":
            case "-h":
                return this.#expectNoExtra(argv, { kind: "instance.help" });
            case "create":
                return this.#expectNoExtra(argv, { kind: "instance.create" });
            case "delete":
                return this.#expectInstanceCommand(argv, "instance.delete");
            case "enable":
                return this.#expectInstanceCommand(argv, "instance.enable");
            case "disable":
                return this.#expectInstanceCommand(argv, "instance.disable");
            case "device-code":
                return this.#expectReverseInstanceCommand(argv, "instance.deviceCode");
            case "list":
                return this.#expectNoExtra(argv, { kind: "instance.list" });
            case "status":
                return this.#expectInstanceCommand(argv, "instance.status");
            case "start":
                return this.#expectInstanceCommand(argv, "instance.start");
            case "stop":
                return this.#expectInstanceCommand(argv, "instance.stop");
            case "rotate-token":
                return this.#expectReverseInstanceCommand(argv, "instance.rotateToken");
            case "revoke-token":
                return this.#expectReverseInstanceCommand(argv, "instance.revokeToken");
            case "logs":
                this.#expectLogsArgs(argv);
                return {
                    follow: argv.includes("-f"),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "instance.logs"
                };
            case "todo":
                this.#expectTodoArgs(argv);
                return {
                    follow: argv.includes("--follow") || argv.includes("-f"),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "instance.todo"
                };
            case "call":
                if (argv.length !== 4) {
                    throw CliRenderError.usage("instance call requires <instance> <toolName> <jsonInput>");
                }

                return {
                    input: this.#parseJson(this.#required(argv[3], "tool input JSON is required")),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "instance.call",
                    toolName: this.#required(argv[2], "tool name is required")
                };
            default:
                throw CliRenderError.usage(
                    `${`Unknown instance command: ${argv[0] ?? ""}`.trim()}\n\n${renderInstanceUsage()}`,
                );
        }
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
                throw CliRenderError.usage(`Unknown config command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseApproval(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
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
                throw CliRenderError.usage(`Unknown approval command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseOAuth(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
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
                throw CliRenderError.usage(`Unknown oauth command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseContext(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
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
                throw CliRenderError.usage(`Unknown context command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseTool(argv: readonly string[]): CliParsedCommand {
        if (argv[0] !== "calls" || (argv.length !== 2 && argv.length !== 3)) {
            throw CliRenderError.usage("tool calls requires <instance> [callId]");
        }
        return {
            ...(argv[2] === undefined ? {} : { callId: this.#required(argv[2], "callId is required") }),
            instance: this.#required(argv[1], "instance name is required"),
            kind: "tool.calls",
        };
    }

    #parseTodo(argv: readonly string[]): CliParsedCommand {
        if (argv[0] !== "delete" || argv.length !== 3) {
            throw CliRenderError.usage("todo delete requires <instance> <taskId>");
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
        kind:
            | "approval.list"
            | "instance.delete"
            | "instance.disable"
            | "instance.enable"
            | "instance.start"
            | "instance.status"
            | "instance.stop"
    ): Extract<CliParsedCommand, { kind: typeof kind }> {
        if (argv.length !== 2) {
            throw CliRenderError.usage(`${kind.split(".")[1]} requires <instance>`);
        }

        return {
            instance: this.#required(argv[1], "instance name is required"),
            kind
        } as Extract<CliParsedCommand, { kind: typeof kind }>;
    }

    #expectReverseInstanceCommand(
        argv: readonly string[],
        kind: "instance.deviceCode" | "instance.rotateToken" | "instance.revokeToken"
    ): Extract<CliParsedCommand, { kind: typeof kind }> {
        if (argv.length !== 2) {
            throw CliRenderError.usage(`${argv[0]} requires <instance>`);
        }

        return {
            instance: this.#required(argv[1], "instance name is required"),
            kind
        } as Extract<CliParsedCommand, { kind: typeof kind }>;
    }


    #expectTodoArgs(argv: readonly string[]): void {
        if (argv.length === 2) {
            return;
        }
        if (argv.length === 3 && (argv[2] === "--follow" || argv[2] === "-f")) {
            return;
        }
        throw CliRenderError.usage("instance todo requires <instance> [--follow]");
    }

    #expectLogsArgs(argv: readonly string[]): void {
        if (argv.length === 2) {
            return;
        }

        if (argv.length === 3 && argv[2] === "-f") {
            return;
        }

        throw CliRenderError.usage("instance logs requires <instance> [-f]");
    }
}
