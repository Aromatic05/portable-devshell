import type { ExtensionInstanceCapability, ExtensionInstanceRecord, ExtensionInstanceSnapshot } from "@portable-devshell/extension/instance";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliModelInstanceReference
} from "@portable-devshell/extension/cli";

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
            return await list(instances, invocation);
        case "status":
            return await status(instances, one(args, "instance status <instance>"), invocation);
        case "logs":
            return await logs(instances, args, invocation);
        case undefined:
            throw usage(INSTANCE_USAGE);
        default:
            throw usage(`Unknown instance model command: ${command}\n\n${INSTANCE_USAGE}`);
    }
}

async function list(
    instances: ExtensionInstanceCapability,
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    const values = await instances.list();
    const projected = await Promise.all(values.map(async (value) => {
        const reference = await invocation.context.instanceReference(value.name);
        return reference === undefined ? undefined : { reference, value };
    }));
    return text(renderList(projected.filter((value): value is InstanceProjection => value !== undefined)));
}

async function status(
    instances: ExtensionInstanceCapability,
    name: string,
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    const reference = await requireReference(invocation, name);
    return text(renderSnapshot(await instances.snapshot(name), reference));
}

async function logs(
    instances: ExtensionInstanceCapability,
    args: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    const { follow, name } = parseFollow(args);
    await requireReference(invocation, name);
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

interface InstanceProjection {
    reference: CliModelInstanceReference;
    value: ExtensionInstanceRecord;
}

function renderList(values: readonly InstanceProjection[]): string {
    if (values.length === 0) return "no instances\n";
    return `${values.map(({ reference, value }) => {
        const status = value.snapshot?.status ?? (value.enabled ? "unavailable" : "disabled");
        const ready = value.snapshot?.ready ?? false;
        const projection = reference.current
            ? "current=true"
            : `handle=${reference.handle ?? "-"}`;
        return `${value.name}\t${status}\tready=${ready}\t${projection}`;
    }).join("\n")}\n`;
}

function renderSnapshot(value: ExtensionInstanceSnapshot, reference: CliModelInstanceReference): string {
    const lines = [
        `instance: ${value.name}`,
        `status: ${value.status}`,
        `ready: ${value.ready}`,
        `daemonState: ${value.daemonState}`,
        `connectionState: ${value.connectionState}`,
        `lastSeq: ${value.lastSeq}`,
        ...(reference.current ? ["current: true"] : [`handle: ${reference.handle ?? "-"}`])
    ];
    if (value.lastErrorCode !== undefined || value.lastErrorMessage !== undefined) {
        lines.push(`lastErrorCode: ${value.lastErrorCode ?? "-"}`);
        lines.push(`lastErrorMessage: ${value.lastErrorMessage ?? "-"}`);
    }
    return `${lines.join("\n")}\n`;
}

async function requireReference(
    invocation: CliModelCommandInvocationContext,
    name: string
): Promise<CliModelInstanceReference> {
    const reference = await invocation.context.instanceReference(name);
    if (reference !== undefined) return reference;
    throw usage(`Instance ${name} is unavailable in the current Context.`);
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
