import type { ExtensionInstanceCapability, ExtensionInstanceSnapshot } from "@portable-devshell/extension/instance";
import type { CliCommandResult, CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

export const INSTANCE_USAGE = [
    "Usage:",
    "  devshell instance list",
    "  devshell instance status <instance>",
    "  devshell instance logs <instance> [-f]"
].join("\n");

export async function executeInstanceCommand(
    instances: ExtensionInstanceCapability,
    argv: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    const [command, ...args] = argv;
    switch (command) {
        case "help":
        case "--help":
        case "-h":
            expect(args, 0, "instance help");
            return text(INSTANCE_USAGE);
        case "list":
            expect(args, 0, "instance list");
            return text(renderList(await instances.list()));
        case "status":
            return text(renderSnapshot(await instances.snapshot(one(args, "instance status <instance>"))));
        case "logs":
            return await logs(instances, args, invocation);
        case undefined:
            throw usage(INSTANCE_USAGE);
        default:
            throw usage(`Unknown instance model command: ${command}\n\n${INSTANCE_USAGE}`);
    }
}

async function logs(
    instances: ExtensionInstanceCapability,
    args: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    const { follow, name } = parseFollow(args);
    if (!follow) return text(renderLogs(await instances.readLogs(name)));
    const io = invocation.io;
    if (io === undefined) throw usage("instance logs -f requires streaming CLI I/O");

    let nextLogSeq = 1;
    const emitNewLogs = async (): Promise<void> => {
        const entries = await instances.readLogs(name, { fromSeq: nextLogSeq });
        if (entries.length === 0) return;
        nextLogSeq = entries.at(-1)!.seq + 1;
        await io.writeStdout(renderLogs(entries));
    };

    const snapshot = await instances.snapshot(name);
    await emitNewLogs();
    await instances.watchEvents(name, {
        eventTypes: ["log.appended"],
        fromSeq: snapshot.lastSeq + 1,
        onEvent: emitNewLogs,
        onGap: async () => await emitNewLogs(),
        signal: invocation.signal
    });
    return text("");
}

function renderList(values: Awaited<ReturnType<ExtensionInstanceCapability["list"]>>): string {
    if (values.length === 0) return "no instances\n";
    return `${values.map((value) => {
        const status = value.snapshot?.status ?? (value.enabled ? "unavailable" : "disabled");
        const ready = value.snapshot?.ready ?? false;
        return `${value.name}\t${status}\tready=${ready}`;
    }).join("\n")}\n`;
}

function renderSnapshot(value: ExtensionInstanceSnapshot): string {
    const lines = [
        `instance: ${value.name}`,
        `status: ${value.status}`,
        `ready: ${value.ready}`,
        `daemonState: ${value.daemonState}`,
        `connectionState: ${value.connectionState}`,
        `lastSeq: ${value.lastSeq}`
    ];
    if (value.lastErrorCode !== undefined || value.lastErrorMessage !== undefined) {
        lines.push(`lastErrorCode: ${value.lastErrorCode ?? "-"}`);
        lines.push(`lastErrorMessage: ${value.lastErrorMessage ?? "-"}`);
    }
    return `${lines.join("\n")}\n`;
}

function renderLogs(entries: Awaited<ReturnType<ExtensionInstanceCapability["readLogs"]>>): string {
    return entries.length === 0
        ? ""
        : `${entries.map((entry) => `[${entry.seq}] ${entry.stream} ${entry.message.replace(/\n$/u, "")}`).join("\n")}\n`;
}

function parseFollow(args: readonly string[]): { follow: boolean; name: string } {
    if (args.length < 1 || args.length > 2 || args[0] === undefined || args[0].length === 0) {
        throw usage("instance logs <instance> [-f]");
    }
    if (args.length === 1) return { follow: false, name: args[0] };
    if (args[1] !== "-f") throw usage("instance logs <instance> [-f]");
    return { follow: true, name: args[0] };
}

function one(args: readonly string[], usageText: string): string {
    if (args.length !== 1 || args[0] === undefined || args[0].length === 0) throw usage(usageText);
    return args[0];
}

function expect(args: readonly string[], count: number, usageText: string): void {
    if (args.length !== count) throw usage(usageText);
}

function text(value: string): CliCommandResult {
    return { kind: "text", text: value };
}

function usage(message: string): TypeError {
    return new TypeError(message);
}
