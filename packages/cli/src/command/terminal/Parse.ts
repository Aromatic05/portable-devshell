import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export type CliTerminalCommand =
    | { all: boolean; instance: string; kind: "terminal.list" }
    | {
          cols?: number;
          command?: string;
          cwd?: string;
          detach: boolean;
          ephemeral: boolean;
          instance: string;
          kind: "terminal.create";
          name?: string;
          rows?: number;
          shell?: string;
          workspace?: string;
      }
    | {
          instance: string;
          kind: "terminal.attach";
          takeover: boolean;
          target?: string;
      }
    | { instance: string; kind: "terminal.inspect"; target?: string }
    | { instance: string; kind: "terminal.close"; target?: string };

export function parseTerminalCommand(
    argv: readonly string[],
): CliParsedCommand {
    switch (argv[0]) {
        case undefined:
        case "help":
        case "--help":
        case "-h":
            return { kind: "help", topic: "terminal" };
        case "list":
            return parseList(argv.slice(1));
        case "create":
            return parseCreate(argv.slice(1));
        case "attach":
            return parseAttach(argv.slice(1));
        case "inspect":
            return parseSingleTarget(argv.slice(1), "terminal.inspect");
        case "close":
            return parseSingleTarget(argv.slice(1), "terminal.close");
        default:
            throw CliRenderError.usage(
                `Unknown terminal command: ${argv[0]}\n\n${renderCliTopicUsage("terminal")}`,
            );
    }
}

function parseList(argv: readonly string[]): CliTerminalCommand {
    let instance: string | undefined;
    let all = false;
    for (const arg of argv) {
        if (arg === "--all" || arg === "-a") {
            all = true;
            continue;
        }
        if (arg.startsWith("-")) {
            throw CliRenderError.usage(`Unknown option for terminal list: ${arg}`);
        }
        if (instance !== undefined) {
            throw CliRenderError.usage(
                "Usage: devshell terminal list <instance> [--all]",
            );
        }
        instance = arg;
    }
    if (instance === undefined) {
        throw CliRenderError.usage("terminal list requires <instance>");
    }
    return { all, instance, kind: "terminal.list" };
}

function parseCreate(argv: readonly string[]): CliTerminalCommand {
    let instance: string | undefined;
    let workspace: string | undefined;
    let name: string | undefined;
    let cwd: string | undefined;
    let command: string | undefined;
    let cols: number | undefined;
    let rows: number | undefined;
    let shell: string | undefined;
    let ephemeral = false;
    let detach = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--workspace") {
            workspace = requireOptionValue(argv, ++index, "--workspace");
        } else if (arg === "--name") {
            name = requireOptionValue(argv, ++index, "--name");
        } else if (arg === "--cwd") {
            cwd = requireOptionValue(argv, ++index, "--cwd");
        } else if (arg === "--command") {
            command = requireOptionValue(argv, ++index, "--command");
        } else if (arg === "--shell") {
            shell = requireOptionValue(argv, ++index, "--shell");
        } else if (arg === "--cols") {
            cols = parsePositiveInt(
                requireOptionValue(argv, ++index, "--cols"),
                "--cols",
                2,
            );
        } else if (arg === "--rows") {
            rows = parsePositiveInt(
                requireOptionValue(argv, ++index, "--rows"),
                "--rows",
                1,
            );
        } else if (arg === "--ephemeral") {
            ephemeral = true;
        } else if (arg === "--detach" || arg === "-d") {
            detach = true;
        } else if (arg.startsWith("-")) {
            throw CliRenderError.usage(
                `Unknown option for terminal create: ${arg}`,
            );
        } else if (instance === undefined) {
            instance = arg;
        } else {
            throw CliRenderError.usage(
                `Unexpected argument for terminal create: ${arg}`,
            );
        }
    }
    if (instance === undefined) {
        throw CliRenderError.usage("terminal create requires <instance>");
    }
    return {
        ...(cols === undefined ? {} : { cols }),
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
        detach,
        ephemeral,
        instance,
        kind: "terminal.create",
        ...(name === undefined ? {} : { name }),
        ...(rows === undefined ? {} : { rows }),
        ...(shell === undefined ? {} : { shell }),
        ...(workspace === undefined ? {} : { workspace }),
    };
}

function parseAttach(argv: readonly string[]): CliTerminalCommand {
    let instance: string | undefined;
    let target: string | undefined;
    let takeover = false;
    for (const arg of argv) {
        if (arg === "--takeover" || arg === "-t") {
            takeover = true;
            continue;
        }
        if (arg.startsWith("-")) {
            throw CliRenderError.usage(
                `Unknown option for terminal attach: ${arg}`,
            );
        }
        if (instance === undefined) {
            instance = arg;
        } else if (target === undefined) {
            target = arg;
        } else {
            throw CliRenderError.usage(
                "Usage: devshell terminal attach <instance> [target] [--takeover]",
            );
        }
    }
    if (instance === undefined) {
        throw CliRenderError.usage("terminal attach requires <instance>");
    }
    return {
        instance,
        kind: "terminal.attach",
        takeover,
        ...(target === undefined ? {} : { target }),
    };
}

function parseSingleTarget(
    argv: readonly string[],
    kind: "terminal.inspect" | "terminal.close",
): CliTerminalCommand {
    const label = kind.split(".")[1];
    let instance: string | undefined;
    let target: string | undefined;
    for (const arg of argv) {
        if (arg.startsWith("-")) {
            throw CliRenderError.usage(
                `Unknown option for terminal ${label}: ${arg}`,
            );
        }
        if (instance === undefined) {
            instance = arg;
        } else if (target === undefined) {
            target = arg;
        } else {
            throw CliRenderError.usage(
                `Usage: devshell terminal ${label} <instance> [target]`,
            );
        }
    }
    if (instance === undefined) {
        throw CliRenderError.usage(`terminal ${label} requires <instance>`);
    }
    return {
        instance,
        kind,
        ...(target === undefined ? {} : { target }),
    };
}

function requireOptionValue(
    argv: readonly string[],
    index: number,
    flag: string,
): string {
    const value = argv[index];
    if (value === undefined || value.length === 0) {
        throw CliRenderError.usage(`${flag} requires a value`);
    }
    return value;
}

function parsePositiveInt(value: string, flag: string, min: number): number {
    if (!/^\d+$/u.test(value)) {
        throw CliRenderError.usage(`${flag} must be an integer >= ${min}`);
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > 4096) {
        throw CliRenderError.usage(
            `${flag} must be an integer between ${min} and 4096`,
        );
    }
    return parsed;
}
