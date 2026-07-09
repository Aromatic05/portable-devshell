import type { JsonValue } from "@portable-devshell/shared";

import { CliRenderError } from "./render/CliRenderError.js";

export type CliParsedCommand =
    | { kind: "control.logs" }
    | { kind: "control.start" }
    | { kind: "control.status" }
    | { kind: "control.stop" }
    | { kind: "tui" }
    | { input: JsonValue; instance: string; kind: "instance.call"; toolName: string }
    | { kind: "instance.create" }
    | { kind: "instance.list" }
    | { follow: boolean; instance: string; kind: "instance.logs" }
    | { instance: string; kind: "instance.start" }
    | { instance: string; kind: "instance.status" }
    | { instance: string; kind: "instance.stop" }
    | { instance: string; kind: "watch.logs" }
    | { instance: string; kind: "watch.status" };

export class CliParser {
    parse(argv: readonly string[]): CliParsedCommand {
        if (argv.length === 0) {
            return { kind: "control.status" };
        }

        switch (argv[0]) {
            case "start":
                return this.#expectNoExtra(argv, { kind: "control.start" });
            case "stop":
                return this.#expectNoExtra(argv, { kind: "control.stop" });
            case "status":
                return this.#expectNoExtra(argv, { kind: "control.status" });
            case "logs":
                return this.#expectNoExtra(argv, { kind: "control.logs" });
            case "tui":
                return this.#expectNoExtra(argv, { kind: "tui" });
            case "instance":
                return this.#parseInstance(argv.slice(1));
            case "watch":
                return this.#parseWatch(argv.slice(1));
            default:
                throw CliRenderError.usage(`Unknown command: ${argv[0]}`);
        }
    }

    #parseInstance(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
            case "create":
                return this.#expectNoExtra(argv, { kind: "instance.create" });
            case "list":
                return this.#expectNoExtra(argv, { kind: "instance.list" });
            case "status":
                return this.#expectInstanceCommand(argv, "instance.status");
            case "start":
                return this.#expectInstanceCommand(argv, "instance.start");
            case "stop":
                return this.#expectInstanceCommand(argv, "instance.stop");
            case "logs":
                this.#expectLogsArgs(argv);
                return {
                    follow: argv.includes("-f"),
                    instance: this.#required(argv[1], "instance name is required"),
                    kind: "instance.logs"
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
                throw CliRenderError.usage(`Unknown instance command: ${argv[0] ?? ""}`.trim());
        }
    }

    #parseWatch(argv: readonly string[]): CliParsedCommand {
        switch (argv[0]) {
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
                throw CliRenderError.usage(`Unknown watch command: ${argv[0] ?? ""}`.trim());
        }
    }

    #expectNoExtra<T extends CliParsedCommand>(argv: readonly string[], value: T): T {
        if (argv.length !== 1) {
            throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
        }

        return value;
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
        kind: "instance.start" | "instance.status" | "instance.stop"
    ): Extract<CliParsedCommand, { kind: typeof kind }> {
        if (argv.length !== 2) {
            throw CliRenderError.usage(`${kind.split(".")[1]} requires <instance>`);
        }

        return {
            instance: this.#required(argv[1], "instance name is required"),
            kind
        } as Extract<CliParsedCommand, { kind: typeof kind }>;
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
