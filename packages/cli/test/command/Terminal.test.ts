import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type {
    TerminalInspectResult,
    TerminalOpenInput,
    TerminalSessionDescriptor,
    TerminalTransport,
} from "@portable-devshell/shared";
import { CliParser } from "../../src/command/Parse.ts";
import {
    executeTerminalCommand,
    renderTerminalTable,
    resolveTerminalTarget,
} from "../../src/command/terminal/Command.ts";
import type { CliDispatchContext } from "../../src/command/Dispatch.ts";

function makeSession(
    overrides: Partial<TerminalSessionDescriptor> = {},
): TerminalSessionDescriptor {
    return {
        cols: 120,
        createdAt: "2026-11-26T00:00:00.000Z",
        cwd: "/workspace/app",
        generation: 1,
        humanControl: false,
        instance: "alpha",
        latestSeq: 5,
        name: "dev-server",
        persistent: true,
        rows: 36,
        state: "running",
        terminalId: "process-11111111-2222-3333-4444-555555555555",
        version: 1,
        workspace: "/workspace",
        ...overrides,
    };
}

test("CliParser parses terminal list/create/attach/inspect/close and help", () => {
    const parser = new CliParser();
    assert.deepEqual(parser.parse(["terminal", "--help"]), {
        kind: "help",
        topic: "terminal",
    });
    assert.deepEqual(parser.parse(["terminal", "list", "alpha", "--all"]), {
        all: true,
        instance: "alpha",
        kind: "terminal.list",
    });
    assert.deepEqual(
        parser.parse([
            "terminal",
            "create",
            "alpha",
            "--workspace",
            "/ws",
            "--name",
            "shell",
            "--cwd",
            "./sub",
            "--cols",
            "100",
            "--rows",
            "30",
            "--detach",
        ]),
        {
            cols: 100,
            cwd: "./sub",
            detach: true,
            ephemeral: false,
            instance: "alpha",
            kind: "terminal.create",
            name: "shell",
            rows: 30,
            workspace: "/ws",
        },
    );
    assert.deepEqual(
        parser.parse(["terminal", "attach", "alpha", "shell", "--takeover"]),
        {
            instance: "alpha",
            kind: "terminal.attach",
            takeover: true,
            target: "shell",
        },
    );
    assert.deepEqual(parser.parse(["terminal", "inspect", "alpha"]), {
        instance: "alpha",
        kind: "terminal.inspect",
    });
    assert.deepEqual(parser.parse(["terminal", "close", "alpha", "1111"]), {
        instance: "alpha",
        kind: "terminal.close",
        target: "1111",
    });
});

test("resolveTerminalTarget resolves exact ID, name, unique UUID prefix, or sole running session", () => {
    const first = makeSession();
    const second = makeSession({
        name: "worker",
        terminalId: "process-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    assert.equal(resolveTerminalTarget([first], undefined, true), first);
    assert.equal(resolveTerminalTarget([first, second], "worker", true), second);
    assert.equal(
        resolveTerminalTarget([first, second], "11111111", true),
        first,
    );
    assert.throws(
        () => resolveTerminalTarget([first, second], undefined, true),
        /Multiple running terminals/u,
    );
});

test("executeTerminalCommand handles list, create --detach, inspect, and close", async () => {
    const sessions: TerminalSessionDescriptor[] = [
        makeSession(),
        makeSession({
            name: "done",
            state: "exited",
            terminalId: "process-99999999-2222-3333-4444-555555555555",
        }),
    ];
    const openedInputs: TerminalOpenInput[] = [];
    const killedIds: string[] = [];
    const transport: TerminalTransport = {
        attach: async () => {
            throw new Error("attach not expected in non-interactive test");
        },
        get: async (identity) =>
            sessions.find((s) => s.terminalId === identity.terminalId)!,
        inspect: async (identity): Promise<TerminalInspectResult> => ({
            cols: 120,
            cursor: { col: 4, row: 1 },
            lines: ["$ pwd", "/workspace/app"],
            rows: 36,
            seq: 5,
            session: sessions.find((s) => s.terminalId === identity.terminalId)!,
        }),
        kill: async (identity) => {
            killedIds.push(identity.terminalId);
            const target = sessions.find(
                (s) => s.terminalId === identity.terminalId,
            )!;
            return { ...target, state: "killed", version: target.version + 1 };
        },
        list: async () => [...sessions],
        open: async (input) => {
            openedInputs.push(input);
            return makeSession({
                cols: input.cols,
                name: input.name,
                persistent: input.persistent,
                rows: input.rows,
                terminalId: "process-22222222-2222-3333-4444-555555555555",
                workspace: input.workspace,
            });
        },
    };

    const output: string[] = [];
    const context = {
        clients: {
            instance: {
                listInstances: async () => [
                    { homeDirectory: "/home/alpha", name: "alpha" },
                ],
            },
            terminal: () => transport,
        },
        controlNegotiated: true,
        outputFormat: "text",
        stderr: { write: () => {} },
        stdin: Readable.from([]),
        stdout: { write: (chunk: string) => output.push(chunk) },
        writeJson: (value: unknown) => output.push(JSON.stringify(value)),
        writeRecords: (_values: readonly unknown[], text: string) =>
            output.push(text),
        writeValue: (_value: unknown, text: string) => output.push(text),
    } as unknown as CliDispatchContext;

    await executeTerminalCommand(
        { all: false, instance: "alpha", kind: "terminal.list" },
        context,
    );
    const listed = output.splice(0).join("");
    assert.match(listed, /dev-server/u);
    assert.doesNotMatch(listed, /\bdone\b/u);
    assert.match(renderTerminalTable(sessions), /running\*/u);

    await executeTerminalCommand(
        {
            detach: true,
            ephemeral: false,
            instance: "alpha",
            kind: "terminal.create",
            name: "ops",
        },
        context,
    );
    assert.deepEqual(openedInputs, [
        {
            cols: 120,
            name: "ops",
            persistent: true,
            rows: 36,
            workspace: "/home/alpha",
        },
    ]);
    assert.match(output.splice(0).join(""), /Created terminal ops/u);

    await executeTerminalCommand(
        { instance: "alpha", kind: "terminal.inspect", target: "dev-server" },
        context,
    );
    assert.match(output.splice(0).join(""), /\/workspace\/app/u);

    await executeTerminalCommand(
        { instance: "alpha", kind: "terminal.close", target: "dev-server" },
        context,
    );
    assert.deepEqual(killedIds, [sessions[0]!.terminalId]);
    assert.match(output.splice(0).join(""), /Closed terminal dev-server/u);
});
