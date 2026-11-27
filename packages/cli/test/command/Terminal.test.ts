import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
    STREAM_GAP_CODE,
    type TerminalAttachment,
    type TerminalInspectResult,
    type TerminalOpenInput,
    type TerminalSessionDescriptor,
    type TerminalStreamMessage,
    type TerminalTransport,
    type TerminalVersionedIdentity,
} from "@portable-devshell/shared";
import type { TerminalStreamCommandIdentity } from "@portable-devshell/shared/testing";
import { CliRenderError } from "../../src/app/Failure.ts";
import { CliParser } from "../../src/command/Parse.ts";
import { attachControlTerminal } from "../../src/command/terminal/Attach.ts";
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

class FakeAttachStream {
    readonly sent: Array<{ operation: string; payload: unknown }> = [];
    closed = false;
    readonly #messages: TerminalStreamMessage[] = [];
    readonly #waiters: Array<(message: TerminalStreamMessage) => void> = [];

    ack(
        identity: TerminalVersionedIdentity,
        throughSeq: number,
    ): Promise<void> {
        this.sent.push({
            operation: "ack",
            payload: {
                generation: identity.generation,
                terminalId: identity.terminalId,
                throughSeq,
                version: identity.version,
            },
        });
        return Promise.resolve();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.push({ kind: "closed" });
    }

    next(): Promise<TerminalStreamMessage> {
        const message = this.#messages.shift();
        if (message !== undefined) return Promise.resolve(message);
        return new Promise((resolve) => this.#waiters.push(resolve));
    }

    sendControl(
        takeover: boolean,
        command: TerminalStreamCommandIdentity,
    ): Promise<void> {
        this.sent.push({
            operation: "control",
            payload: { ...command, takeover },
        });
        return Promise.resolve();
    }

    sendInput(
        data: string,
        command: TerminalStreamCommandIdentity,
    ): Promise<void> {
        this.sent.push({
            operation: "input",
            payload: { ...command, data },
        });
        return Promise.resolve();
    }

    sendResize(
        cols: number,
        rows: number,
        command: TerminalStreamCommandIdentity,
    ): Promise<void> {
        this.sent.push({
            operation: "resize",
            payload: { ...command, cols, rows },
        });
        return Promise.resolve();
    }

    push(message: TerminalStreamMessage): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#messages.push(message);
        else waiter(message);
    }

    asTerminalAttachment(): TerminalAttachment {
        return this as unknown as TerminalAttachment;
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for terminal attach condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function makeAttachHarness(session: TerminalSessionDescriptor) {
    const stream = new FakeAttachStream();
    const stdin = new PassThrough() as PassThrough & {
        isRaw?: boolean;
        isTTY?: boolean;
        setRawMode?(mode: boolean): void;
    };
    stdin.isTTY = true;
    stdin.setRawMode = (mode: boolean) => {
        stdin.isRaw = mode;
    };
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
        columns: session.cols,
        isTTY: true,
        rows: session.rows,
        write: (chunk: string) => stdoutChunks.push(chunk),
    };
    const stderr = {
        write: (chunk: string) => stderrChunks.push(chunk),
    };
    const transport: TerminalTransport = {
        attach: async () => {
            stream.push({ kind: "seed", session });
            return stream.asTerminalAttachment();
        },
        get: async () => session,
        kill: async () => session,
        list: async () => [session],
        open: async () => session,
    };
    return { stderr, stderrChunks, stdin, stdout, stdoutChunks, stream, transport };
}

test("attachControlTerminal emits full ANSI reset on detach and handles Ctrl+] keybindings", async () => {
    const session = makeSession({ humanControl: true });
    const h = makeAttachHarness(session);

    const running = attachControlTerminal({
        initialTakeover: true,
        session,
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        transport: h.transport,
    });

    await waitFor(() =>
        h.stream.sent.some((entry) => entry.operation === "resize"),
    );

    // Ctrl+] then ] sends literal 0x1d
    h.stdin.write(Buffer.from([0x1d, 0x5d]));
    await waitFor(() =>
        h.stream.sent.some(
            (entry) =>
                entry.operation === "input" &&
                (entry.payload as { data: string }).data === "\u001d",
        ),
    );

    // Multi-byte UTF-8 split across chunks
    h.stdin.write(Buffer.from([0xf0, 0x9f]));
    h.stdin.write(Buffer.from([0x98, 0x80]));
    await waitFor(() =>
        h.stream.sent.some(
            (entry) =>
                entry.operation === "input" &&
                (entry.payload as { data: string }).data === "😀",
        ),
    );

    // Unknown key after Ctrl+] does NOT detach and updates title hint
    h.stdin.write(Buffer.from([0x1d, 0x61])); // Ctrl+] a
    await waitFor(() =>
        h.stdoutChunks.some((chunk) =>
            chunk.includes("Ctrl+] d: detach · t: toggle control · ]: send ^]"),
        ),
    );
    assert.equal(h.stream.closed, false);

    // Ctrl+] d detaches and emits full reset sequence
    h.stdin.write(Buffer.from([0x1d, 0x64]));
    await running;

    const fullReset =
        "\u001B]0;\u0007\u001B[0m\u001B[?25h\u001B[?1l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?2004l\u001B[?1049l";
    assert.equal(h.stdoutChunks.at(-1), fullReset);
    assert.equal(h.stdin.isRaw, false);
});

test("attachControlTerminal detaches on Ctrl+] Ctrl+]", async () => {
    const session = makeSession({ humanControl: true });
    const h = makeAttachHarness(session);

    const running = attachControlTerminal({
        initialTakeover: true,
        session,
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        transport: h.transport,
    });

    await waitFor(() =>
        h.stdoutChunks.some((chunk) => chunk.includes("[CONTROL]")),
    );

    h.stdin.write(Buffer.from([0x1d, 0x1d]));
    await running;
    assert.equal(h.stream.closed, true);
});

test("attachControlTerminal keeps observe session alive on controlChanged error and rings bell", async () => {
    const session = makeSession({ humanControl: false });
    const h = makeAttachHarness(session);

    const running = attachControlTerminal({
        initialTakeover: false,
        session,
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        transport: h.transport,
    });

    await waitFor(() =>
        h.stdoutChunks.some((chunk) => chunk.includes("[OBSERVE]")),
    );

    h.stdin.write(Buffer.from([0x1d, 0x74])); // Ctrl+] t
    await waitFor(() =>
        h.stream.sent.some((entry) => entry.operation === "control"),
    );
    const controlCmd = h.stream.sent.find(
        (entry) => entry.operation === "control",
    )!.payload as TerminalStreamCommandIdentity;

    h.stream.push({
        clientSeq: controlCmd.clientSeq,
        error: "another human holds control",
        humanControl: false,
        kind: "controlChanged",
        session: { ...session, version: session.version + 1 },
    });

    await waitFor(() =>
        h.stdoutChunks.some((chunk) =>
            chunk.includes("another human holds control"),
        ),
    );
    assert.equal(h.stdoutChunks.includes("\x07"), true);
    assert.equal(h.stream.closed, false);

    // Session is still alive and receives output
    h.stream.push({
        frame: { data: "still-streaming", seq: 6 },
        kind: "output",
    });
    await waitFor(() => h.stdoutChunks.includes("still-streaming"));

    h.stdin.write(Buffer.from([0x1d, 0x64]));
    await running;
});

test("attachControlTerminal caps stream.gap reconnects within window", async () => {
    const session = makeSession({ humanControl: false });
    let attachCount = 0;
    const h = makeAttachHarness(session);
    h.transport.attach = async () => {
        attachCount += 1;
        const stream = new FakeAttachStream();
        stream.push({ kind: "seed", session });
        const gapError = Object.assign(new Error("stream gap"), {
            code: STREAM_GAP_CODE,
        });
        stream.push({ error: gapError, kind: "closed" });
        return stream.asTerminalAttachment();
    };

    await assert.rejects(
        attachControlTerminal({
            initialTakeover: false,
            session,
            stderr: h.stderr,
            stdin: h.stdin,
            stdout: h.stdout,
            transport: h.transport,
        }),
        /stream gap/u,
    );
    assert.equal(attachCount, 6);
});

test("terminal.attach requires an interactive TTY", async () => {
    const session = makeSession();
    const transport: TerminalTransport = {
        attach: async () => {
            throw new Error("attach should not be called without TTY");
        },
        get: async () => session,
        kill: async () => session,
        list: async () => [session],
        open: async () => session,
    };
    const context = {
        clients: {
            instance: { listInstances: async () => [] },
            terminal: () => transport,
        },
        controlNegotiated: true,
        outputFormat: "text",
        stderr: { write: () => {} },
        stdin: Readable.from([]),
        stdout: { write: () => {} },
        writeJson: () => {},
        writeRecords: () => {},
        writeValue: () => {},
    } as unknown as CliDispatchContext;

    await assert.rejects(
        executeTerminalCommand(
            { instance: "alpha", kind: "terminal.attach", takeover: false },
            context,
        ),
        (error: unknown) =>
            error instanceof CliRenderError &&
            error.code === "cli.usage" &&
            /interactive TTY/u.test(error.message),
    );
});

test("attachControlTerminal detaches cleanly on stdin EOF", async () => {
    const session = makeSession({ humanControl: true });
    const h = makeAttachHarness(session);

    const running = attachControlTerminal({
        initialTakeover: true,
        session,
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        transport: h.transport,
    });

    await waitFor(() =>
        h.stdoutChunks.some((chunk) => chunk.includes("[CONTROL]")),
    );

    h.stdin.end();
    await running;

    assert.equal(h.stream.closed, true);
    assert.equal(h.stdin.listenerCount("end"), 0);
    assert.equal(h.stdin.listenerCount("close"), 0);
});

test("terminal.create and terminal.attach print workspace and shortcut banners to stderr", async () => {
    const session = makeSession({
        name: "dev-shell",
        workspace: "/repo/workspace",
    });

    const createHarness = makeAttachHarness(session);
    const createContext = {
        clients: {
            instance: {
                listInstances: async () => [
                    { homeDirectory: "/home/alpha", name: "alpha" },
                ],
            },
            terminal: () => ({
                ...createHarness.transport,
                open: async (input: { workspace: string }) => ({
                    ...session,
                    workspace: input.workspace,
                }),
            }),
        },
        controlNegotiated: true,
        outputFormat: "text",
        stderr: createHarness.stderr,
        stdin: createHarness.stdin,
        stdout: createHarness.stdout,
        writeJson: () => {},
        writeRecords: () => {},
        writeValue: () => {},
    } as unknown as CliDispatchContext;

    const creating = executeTerminalCommand(
        {
            detach: false,
            ephemeral: false,
            instance: "alpha",
            kind: "terminal.create",
            name: "dev-shell",
            workspace: "/repo/workspace",
        },
        createContext,
    );
    await waitFor(() =>
        createHarness.stdoutChunks.some((chunk) => chunk.includes("[CONTROL]")),
    );
    createHarness.stdin.write(Buffer.from([0x1d, 0x64]));
    await creating;

    assert.equal(
        createHarness.stderrChunks.join(""),
        "[created dev-shell (process-11111111-2222-3333-4444-555555555555) on alpha · workspace: /repo/workspace · Ctrl+] t: hand off · Ctrl+] d: detach]\n[detached from dev-shell (process-11111111-2222-3333-4444-555555555555) — session still running]\n",
    );

    const attachHarness = makeAttachHarness(session);
    const attachContext = {
        clients: {
            instance: { listInstances: async () => [] },
            terminal: () => attachHarness.transport,
        },
        controlNegotiated: true,
        outputFormat: "text",
        stderr: attachHarness.stderr,
        stdin: attachHarness.stdin,
        stdout: attachHarness.stdout,
        writeJson: () => {},
        writeRecords: () => {},
        writeValue: () => {},
    } as unknown as CliDispatchContext;

    const attaching = executeTerminalCommand(
        {
            instance: "alpha",
            kind: "terminal.attach",
            takeover: false,
            target: "dev-shell",
        },
        attachContext,
    );
    await waitFor(() =>
        attachHarness.stdoutChunks.some((chunk) => chunk.includes("[OBSERVE]")),
    );
    attachHarness.stdin.write(Buffer.from([0x1d, 0x64]));
    await attaching;

    assert.equal(
        attachHarness.stderrChunks.join(""),
        "[attaching dev-shell (process-11111111-2222-3333-4444-555555555555) on alpha (observe) · workspace: /repo/workspace · Ctrl+] t: toggle control · Ctrl+] d: detach]\n[detached from dev-shell (process-11111111-2222-3333-4444-555555555555) — session still running]\n",
    );
});

test("terminal create parses --shell and forwards it to transport.open", async () => {
    const parser = new CliParser();
    const parsed = parser.parse([
        "terminal",
        "create",
        "alpha",
        "--shell",
        "/bin/zsh",
        "--detach",
    ]);
    assert.deepEqual(parsed, {
        detach: true,
        ephemeral: false,
        instance: "alpha",
        kind: "terminal.create",
        shell: "/bin/zsh",
    });

    const openedInputs: TerminalOpenInput[] = [];
    const transport: TerminalTransport = {
        attach: async () => {
            throw new Error("attach not expected");
        },
        get: async () => makeSession(),
        kill: async () => makeSession(),
        list: async () => [],
        open: async (input) => {
            openedInputs.push(input);
            return makeSession({
                cols: input.cols,
                rows: input.rows,
                workspace: input.workspace,
            });
        },
    };
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
        stdout: { write: () => {} },
        writeJson: () => {},
        writeRecords: () => {},
        writeValue: () => {},
    } as unknown as CliDispatchContext;

    await executeTerminalCommand(parsed, context);
    assert.equal(openedInputs[0]?.shell, "/bin/zsh");
});

test("pipe tasks render pipe/read-only in table, reject takeover/inspect, ignore Ctrl+] t, and print detach banner", async () => {
    const pipeSession = makeSession({
        cols: 0,
        command: "npm run build",
        humanControl: false,
        name: "build-job",
        persistent: false,
        pty: false,
        rows: 0,
        terminalId: "process-pipepipe-2222-3333-4444-555555555555",
    });
    const table = renderTerminalTable([pipeSession]);
    assert.match(table, /\bpipe\b/u);
    assert.match(table, /\bread-only\b/u);
    assert.doesNotMatch(table, /\b0x0\b/u);

    const h = makeAttachHarness(pipeSession);
    const context = {
        clients: {
            instance: { listInstances: async () => [] },
            terminal: () => ({
                ...h.transport,
                inspect: async () => {
                    throw new Error("inspect should not be called on pipe task");
                },
            }),
        },
        controlNegotiated: true,
        outputFormat: "text",
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        writeJson: () => {},
        writeRecords: () => {},
        writeValue: () => {},
    } as unknown as CliDispatchContext;

    await assert.rejects(
        executeTerminalCommand(
            {
                instance: "alpha",
                kind: "terminal.attach",
                takeover: true,
                target: "build-job",
            },
            context,
        ),
        (error: unknown) =>
            error instanceof CliRenderError &&
            error.code === "cli.usage" &&
            /Pipe tasks are read-only/u.test(error.message),
    );

    await assert.rejects(
        executeTerminalCommand(
            {
                instance: "alpha",
                kind: "terminal.inspect",
                target: "build-job",
            },
            context,
        ),
        (error: unknown) =>
            error instanceof CliRenderError &&
            error.code === "cli.usage" &&
            /Pipe tasks have no PTY screen/u.test(error.message),
    );

    const attaching = executeTerminalCommand(
        {
            instance: "alpha",
            kind: "terminal.attach",
            takeover: false,
            target: "build-job",
        },
        context,
    );
    await waitFor(() =>
        h.stdoutChunks.some((chunk) => chunk.includes("[PIPE]")),
    );
    assert.doesNotMatch(h.stdoutChunks[0] ?? "", /0x0/u);

    // Ctrl+] t on pipe task rings bell and does not sendControl
    h.stdin.write(Buffer.from([0x1d, 0x74]));
    await waitFor(() =>
        h.stdoutChunks.some((chunk) =>
            chunk.includes("pipe tasks are read-only"),
        ),
    );
    assert.equal(h.stdoutChunks.includes("\x07"), true);
    assert.equal(
        h.stream.sent.some((entry) => entry.operation === "control"),
        false,
    );

    // Detach via Ctrl+] d prints detached banner to stderr after FULL_TERMINAL_RESET
    h.stdin.write(Buffer.from([0x1d, 0x64]));
    await attaching;

    const fullReset =
        "\u001B]0;\u0007\u001B[0m\u001B[?25h\u001B[?1l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?2004l\u001B[?1049l";
    assert.equal(h.stdoutChunks.at(-1), fullReset);
    assert.equal(
        h.stderrChunks.join(""),
        "[attaching build-job (process-pipepipe-2222-3333-4444-555555555555) on alpha (pipe · read-only) · workspace: /workspace · Ctrl+] d: detach]\n[detached from build-job (process-pipepipe-2222-3333-4444-555555555555) — session still running]\n",
    );
});

test("attachControlTerminal does not print detach banner when session exits", async () => {
    const session = makeSession({ humanControl: false, name: "short-job" });
    const h = makeAttachHarness(session);

    const running = attachControlTerminal({
        initialTakeover: false,
        session,
        stderr: h.stderr,
        stdin: h.stdin,
        stdout: h.stdout,
        transport: h.transport,
    });

    await waitFor(() =>
        h.stdoutChunks.some((chunk) => chunk.includes("[OBSERVE]")),
    );
    h.stream.push({ event: { exitCode: 0 }, kind: "exit" });
    await running;

    const stderrText = h.stderrChunks.join("");
    assert.match(stderrText, /\[terminal exited: code=0\]/u);
    assert.doesNotMatch(stderrText, /detached from/u);
});
