import type {
    TerminalInspectResult,
    TerminalSessionDescriptor,
    TerminalTransport,
} from "@portable-devshell/shared";
import { CliRenderError } from "../../app/Failure.js";
import type { CliDispatchContext } from "../Dispatch.js";
import type { CliParsedCommand } from "../Parse.js";
import { attachControlTerminal } from "./Attach.js";

export async function executeTerminalCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (!command.kind.startsWith("terminal.")) return false;
    const terminalClient = context.clients.terminal;
    if (terminalClient === undefined) {
        throw new CliRenderError(
            "terminal.unavailable",
            "Terminal transport is unavailable in this CLI client.",
        );
    }

    switch (command.kind) {
        case "terminal.list": {
            const transport = terminalClient(command.instance);
            const all = await transport.list();
            const filtered = command.all
                ? all
                : all.filter((session) => session.state === "running");
            context.writeRecords(filtered, renderTerminalTable(filtered));
            return true;
        }
        case "terminal.create": {
            const transport = terminalClient(command.instance);
            const workspace =
                command.workspace ??
                (await resolveDefaultWorkspace(command.instance, context));
            const stdoutTty = context.stdout as Partial<NodeJS.WriteStream>;
            const stdinTty = context.stdin as Partial<NodeJS.ReadStream>;
            const cols =
                command.cols ??
                (typeof stdoutTty.columns === "number" && stdoutTty.columns >= 2
                    ? stdoutTty.columns
                    : 120);
            const rows =
                command.rows ??
                (typeof stdoutTty.rows === "number" && stdoutTty.rows >= 1
                    ? stdoutTty.rows
                    : 36);
            const created = await transport.open({
                cols,
                ...(command.command === undefined
                    ? {}
                    : { command: command.command }),
                ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
                ...(command.name === undefined ? {} : { name: command.name }),
                persistent: !command.ephemeral,
                rows,
                workspace,
            });
            const interactive =
                !command.detach &&
                context.outputFormat === "text" &&
                stdinTty.isTTY === true &&
                stdoutTty.isTTY === true;
            if (!interactive) {
                context.writeValue(created, renderCreatedTerminal(created));
                return true;
            }
            await attachControlTerminal({
                initialTakeover: true,
                session: created,
                stderr: context.stderr,
                stdin: context.stdin,
                stdout: context.stdout,
                transport,
            });
            return true;
        }
        case "terminal.attach": {
            if (context.outputFormat !== "text") {
                throw CliRenderError.usage(
                    "terminal attach supports only text output",
                );
            }
            const stdinTty = context.stdin as Partial<NodeJS.ReadStream>;
            const stdoutTty = context.stdout as Partial<NodeJS.WriteStream>;
            if (stdinTty.isTTY !== true || stdoutTty.isTTY !== true) {
                throw CliRenderError.usage(
                    "terminal attach requires an interactive TTY",
                );
            }
            const transport = terminalClient(command.instance);
            const sessions = (await transport.list()).filter(
                (session) => session.state === "running",
            );
            const target = resolveTerminalTarget(sessions, command.target, true);
            await attachControlTerminal({
                initialTakeover: command.takeover,
                session: target,
                stderr: context.stderr,
                stdin: context.stdin,
                stdout: context.stdout,
                transport,
            });
            return true;
        }
        case "terminal.inspect": {
            const transport = terminalClient(command.instance);
            if (transport.inspect === undefined) {
                throw new CliRenderError(
                    "terminal.inspectUnsupported",
                    "Terminal inspect is not supported by this transport.",
                );
            }
            const sessions = await transport.list();
            const target = resolveTerminalTarget(sessions, command.target, false);
            const result = await transport.inspect({
                generation: target.generation,
                terminalId: target.terminalId,
            });
            context.writeValue(result, renderInspectResult(result));
            return true;
        }
        case "terminal.close": {
            const transport = terminalClient(command.instance);
            const sessions = await transport.list();
            const target = resolveTerminalTarget(sessions, command.target, true);
            const closed = await transport.kill({
                generation: target.generation,
                terminalId: target.terminalId,
                version: target.version,
            });
            context.writeValue(
                closed,
                `Closed terminal ${formatTargetLabel(closed)} (${closed.state})\n`,
            );
            return true;
        }
        default:
            return false;
    }
}

async function resolveDefaultWorkspace(
    instance: string,
    context: CliDispatchContext,
): Promise<string> {
    const entries = await context.clients.instance.listInstances();
    const home = entries.find((entry) => entry.name === instance)?.homeDirectory;
    if (home !== undefined && home.length > 0) return home;
    throw CliRenderError.usage(
        `Could not determine default workspace for ${instance}; pass --workspace <path>.`,
    );
}

export function resolveTerminalTarget(
    sessions: readonly TerminalSessionDescriptor[],
    target: string | undefined,
    preferRunning: boolean,
): TerminalSessionDescriptor {
    const running = sessions.filter((session) => session.state === "running");
    const pool = preferRunning ? running : sessions;
    if (target === undefined || target.length === 0) {
        if (running.length === 1) return running[0]!;
        if (running.length === 0) {
            throw CliRenderError.usage(
                "No running terminal sessions found on this instance.",
            );
        }
        const candidates = running
            .map((session) => `  ${formatTargetLabel(session)}`)
            .join("\n");
        throw CliRenderError.usage(
            `Multiple running terminals found; specify a target ID or name:\n${candidates}`,
        );
    }

    const exactId = pool.find((session) => session.terminalId === target);
    if (exactId !== undefined) return exactId;

    const exactName = pool.filter((session) => session.name === target);
    if (exactName.length === 1) return exactName[0]!;
    if (exactName.length > 1) {
        throw CliRenderError.usage(
            `Multiple terminals share the name "${target}"; specify a full terminal ID.`,
        );
    }

    const prefixMatches = pool.filter((session) => {
        const bare = session.terminalId.startsWith("process-")
            ? session.terminalId.slice("process-".length)
            : session.terminalId;
        return (
            session.terminalId.startsWith(target) || bare.startsWith(target)
        );
    });
    if (prefixMatches.length === 1) return prefixMatches[0]!;
    if (prefixMatches.length > 1) {
        throw CliRenderError.usage(
            `Ambiguous terminal target "${target}" matches ${prefixMatches.length} sessions.`,
        );
    }

    throw CliRenderError.usage(`Terminal "${target}" was not found.`);
}

export function renderTerminalTable(
    sessions: readonly TerminalSessionDescriptor[],
): string {
    if (sessions.length === 0) return "No terminal sessions.\n";
    const rows = sessions.map((session) => ({
        ctrl: session.humanControl ? "human" : "model",
        detail: session.command ?? session.cwd ?? "",
        id: shortId(session.terminalId),
        name: session.name ?? "-",
        size: `${session.cols}x${session.rows}`,
        state: session.persistent
            ? `${session.state}*`
            : session.state,
    }));
    const header = {
        ctrl: "CTRL",
        detail: "CWD / CMD",
        id: "ID",
        name: "NAME",
        size: "SIZE",
        state: "STATE",
    };
    const widths = {
        ctrl: Math.max(header.ctrl.length, ...rows.map((r) => r.ctrl.length)),
        id: Math.max(header.id.length, ...rows.map((r) => r.id.length)),
        name: Math.max(header.name.length, ...rows.map((r) => r.name.length)),
        size: Math.max(header.size.length, ...rows.map((r) => r.size.length)),
        state: Math.max(
            header.state.length,
            ...rows.map((r) => r.state.length),
        ),
    };
    const formatRow = (row: typeof header) =>
        `${row.id.padEnd(widths.id)}  ${row.name.padEnd(widths.name)}  ${row.state.padEnd(widths.state)}  ${row.size.padEnd(widths.size)}  ${row.ctrl.padEnd(widths.ctrl)}  ${row.detail}`.trimEnd();
    return [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
}

function renderCreatedTerminal(session: TerminalSessionDescriptor): string {
    const label = formatTargetLabel(session);
    return `Created terminal ${label} (${session.cols}x${session.rows}, ${session.persistent ? "persistent" : "ephemeral"})\n`;
}

function renderInspectResult(result: TerminalInspectResult): string {
    const header = `${formatTargetLabel(result.session)} · ${result.cols}x${result.rows} · seq ${result.seq} · ${result.session.humanControl ? "human" : "model"}`;
    const body = result.lines.join("\n");
    return `${header}\n${body}\n`;
}

function shortId(terminalId: string): string {
    const bare = terminalId.startsWith("process-")
        ? terminalId.slice("process-".length)
        : terminalId;
    return bare.length > 12 ? bare.slice(0, 12) : bare;
}

function formatTargetLabel(session: TerminalSessionDescriptor): string {
    return session.name !== undefined && session.name.length > 0
        ? `${session.name} (${session.terminalId})`
        : session.terminalId;
}

export type { TerminalTransport };
