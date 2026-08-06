import assert from "node:assert/strict";
import test from "node:test";

import type {
    TerminalProcess,
    TerminalProcessExit,
} from "../../src/control/terminal/TerminalProcess.ts";
import { TerminalSessionService } from "../../src/control/terminal/TerminalSessionService.ts";

class FakeTerminalProcess implements TerminalProcess {
    readonly inputs: string[] = [];
    readonly resizes: Array<{ cols: number; rows: number }> = [];
    disposed = false;
    killed = false;
    readonly #data = new Set<(data: string) => void>();
    readonly #exit = new Set<(exit: TerminalProcessExit) => void>();

    get dataListenerCount(): number {
        return this.#data.size;
    }

    get exitListenerCount(): number {
        return this.#exit.size;
    }

    dispose(): void {
        this.disposed = true;
    }

    emit(data: string): void {
        for (const listener of [...this.#data]) listener(data);
    }

    exit(exit: TerminalProcessExit): void {
        for (const listener of [...this.#exit]) listener(exit);
    }

    kill(): void {
        this.killed = true;
    }

    onData(listener: (data: string) => void): () => void {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exit.add(listener);
        return () => this.#exit.delete(listener);
    }

    resize(cols: number, rows: number): void {
        this.resizes.push({ cols, rows });
    }

    write(data: string): void {
        this.inputs.push(data);
    }
}

test("terminal attachments replay by sequence and detach without killing the process", async () => {
    const process = new FakeTerminalProcess();
    const service = new TerminalSessionService({
        idFactory: () => "terminal-one",
        maxReplayBytes: 1024,
    });
    const opened = await service.open({
        backend: { open: async () => process },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });

    process.emit("first");
    const live: Array<{ data: string; seq: number }> = [];
    const attachment = service.attach({
        fromSeq: 0,
        generation: opened.generation,
        onOutput: (frame) => live.push(frame),
        terminalId: opened.terminalId,
    });
    assert.deepEqual(attachment.replay, [{ data: "first", seq: 1 }]);

    process.emit("second");
    await attachment.write("echo ok\r");
    await attachment.resize(120, 40);
    attachment.detach();

    assert.deepEqual(live, [{ data: "second", seq: 2 }]);
    assert.deepEqual(process.inputs, ["echo ok\r"]);
    assert.deepEqual(process.resizes, [{ cols: 120, rows: 40 }]);
    assert.equal(process.killed, false);

    process.emit("third");
    const resumed = service.attach({
        fromSeq: 2,
        generation: opened.generation,
        onOutput() {},
        terminalId: opened.terminalId,
    });
    assert.deepEqual(resumed.replay, [{ data: "third", seq: 3 }]);
});

test("terminal attach rejects stale identity and reports replay overflow as a gap", async () => {
    const process = new FakeTerminalProcess();
    const service = new TerminalSessionService({
        idFactory: () => "terminal-gap",
        maxReplayBytes: 6,
    });
    const opened = await service.open({
        backend: { open: async () => process },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });

    process.emit("1111");
    process.emit("2222");

    assert.throws(
        () =>
            service.attach({
                fromSeq: 0,
                generation: opened.generation,
                onOutput() {},
                terminalId: opened.terminalId,
            }),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "stream.gap");
            assert.deepEqual((error as { details?: unknown }).details, {
                latestSeq: 2,
                oldestAvailableSeq: 2,
                requestedFromSeq: 0,
                terminalId: opened.terminalId,
            });
            return true;
        },
    );

    assert.throws(
        () =>
            service.attach({
                fromSeq: 1,
                generation: opened.generation + 1,
                onOutput() {},
                terminalId: opened.terminalId,
            }),
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
});

test("closing Control detaches recoverable terminal adapters without killing remote PTYs", async () => {
    const process = new FakeTerminalProcess();
    const service = new TerminalSessionService();
    await service.open({
        backend: {
            open: async () => ({
                identity: {
                    generation: 7,
                    recoverable: true,
                    terminalId: "remote-persistent",
                    version: 1,
                },
                process,
            }),
        },
        cols: 80,
        instance: "reverse",
        rows: 24,
    });

    service.close();

    assert.equal(process.disposed, true);
    assert.equal(process.killed, false);
});

test("terminal exit is durable for later attachments and kill is explicit", async () => {
    const process = new FakeTerminalProcess();
    let nextId = 0;
    const service = new TerminalSessionService({
        idFactory: () => `terminal-exit-${++nextId}`,
    });
    const opened = await service.open({
        backend: { open: async () => process },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });
    process.emit("done\r\n");
    process.exit({ exitCode: 7, signal: 0 });

    const attached = service.attach({
        fromSeq: 0,
        generation: opened.generation,
        onOutput() {},
        terminalId: opened.terminalId,
    });
    assert.deepEqual(attached.replay, [{ data: "done\r\n", seq: 1 }]);
    assert.deepEqual(attached.exit, { exitCode: 7, signal: 0 });
    assert.equal(service.get(opened.terminalId).state, "exited");

    const otherProcess = new FakeTerminalProcess();
    const other = await service.open({
        backend: { open: async () => otherProcess },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });
    const killedExits: TerminalProcessExit[] = [];
    service.attach({
        fromSeq: 0,
        generation: other.generation,
        onExit: (exit) => killedExits.push(exit),
        onOutput() {},
        terminalId: other.terminalId,
    });
    await service.kill(other.terminalId, other.generation, other.version);
    assert.equal(otherProcess.killed, true);
    assert.equal(service.get(other.terminalId).state, "killed");
    assert.deepEqual(killedExits, [{ exitCode: -1, signal: 0 }]);
    assert.equal(otherProcess.dataListenerCount, 0);
    assert.equal(otherProcess.exitListenerCount, 0);
    assert.equal(otherProcess.disposed, true);
});

test("closing terminal service fences a pending open and cleans the late process", async () => {
    const process = new FakeTerminalProcess();
    let releaseOpen!: () => void;
    const opened = new Promise<TerminalProcess>((resolve) => {
        releaseOpen = () => resolve(process);
    });
    const service = new TerminalSessionService();
    const request = service.open({
        backend: { open: async () => await opened },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });

    service.close();
    releaseOpen();

    await assert.rejects(
        request,
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
    assert.equal(process.killed, true);
    assert.equal(process.disposed, true);
    assert.deepEqual(service.list(), []);
});

test("closing terminal service removes process listeners before disposing adapters", async () => {
    const process = new FakeTerminalProcess();
    const service = new TerminalSessionService();
    await service.open({
        backend: { open: async () => process },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });
    assert.equal(process.dataListenerCount, 1);
    assert.equal(process.exitListenerCount, 1);

    service.close();

    assert.equal(process.dataListenerCount, 0);
    assert.equal(process.exitListenerCount, 0);
});

test("closing one instance terminates its recoverable sessions without touching another instance", async () => {
    const alpha = new FakeTerminalProcess();
    const beta = new FakeTerminalProcess();
    const service = new TerminalSessionService();
    const openedAlpha = await service.open({
        backend: {
            open: async () => ({
                identity: {
                    createdAt: "2026-08-07T00:00:00.000Z",
                    generation: 10,
                    recoverable: true,
                    terminalId: "alpha-persistent",
                    version: 1,
                },
                process: alpha,
            }),
        },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });
    await service.open({
        backend: { open: async () => beta },
        cols: 80,
        instance: "beta",
        rows: 24,
    });
    const exits: TerminalProcessExit[] = [];
    service.attach({
        fromSeq: 0,
        generation: openedAlpha.generation,
        onExit: (exit) => exits.push(exit),
        onOutput() {},
        terminalId: openedAlpha.terminalId,
    });

    await service.closeInstance("alpha");

    assert.equal(alpha.killed, true);
    assert.equal(alpha.disposed, true);
    assert.deepEqual(exits, [{ exitCode: -1, signal: 0 }]);
    assert.deepEqual(service.list("alpha"), []);
    assert.equal(service.list("beta").length, 1);
    assert.equal(beta.killed, false);
});

test("closing an instance fences a pending open from its replaced backend", async () => {
    const process = new FakeTerminalProcess();
    let releaseOpen!: () => void;
    const opened = new Promise<TerminalProcess>((resolve) => {
        releaseOpen = () => resolve(process);
    });
    const service = new TerminalSessionService();
    const request = service.open({
        backend: { open: async () => await opened },
        cols: 80,
        instance: "alpha",
        rows: 24,
    });

    await service.closeInstance("alpha");
    releaseOpen();

    await assert.rejects(
        request,
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
    assert.equal(process.killed, true);
    assert.equal(process.disposed, true);
    assert.deepEqual(service.list("alpha"), []);
});
