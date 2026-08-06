import assert from "node:assert/strict";
import test from "node:test";

import type {
    WorkerTerminalAttachResult,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    WorkerRpcError,
} from "@portable-devshell/core";

import {
    ReverseTerminalBackend,
    type ReverseTerminalWorkerPort,
} from "../../src/control/terminal/ReverseTerminalBackend.ts";

class FakeReverseTerminalWorker implements ReverseTerminalWorkerPort {
    readonly attaches: Array<{
        fromSeq: number;
        generation: number;
        terminalId: string;
    }> = [];
    readonly writes: Array<WorkerTerminalIdentity & { data: string }> = [];
    readonly resizes: Array<
        WorkerTerminalIdentity & { cols: number; rows: number }
    > = [];
    readonly kills: WorkerTerminalIdentity[] = [];
    notification?: (notification: WorkerTerminalNotification) => void;
    connected?: () => void;
    disconnected?: (error: WorkerRpcError) => void;
    version = 1;
    latestSeq = 1;
    resizeGate?: Promise<void>;
    writeGate?: Promise<void>;

    descriptor(): WorkerTerminalDescriptor {
        return {
            cols: 80,
            createdAtMs: 1,
            generation: 9,
            latestSeq: this.latestSeq,
            rows: 24,
            state: "running",
            terminalId: "remote-terminal",
            version: this.version,
        };
    }

    async openTerminal(): Promise<WorkerTerminalDescriptor> {
        return this.descriptor();
    }

    async attachTerminal(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult> {
        this.attaches.push(input);
        const replay =
            input.fromSeq < this.latestSeq
                ? [
                      {
                          dataBase64: Buffer.from("replay").toString("base64"),
                          seq: this.latestSeq,
                      },
                  ]
                : [];
        return { replay, session: this.descriptor() };
    }

    async writeTerminal(input: WorkerTerminalIdentity & { data: string }) {
        this.writes.push(input);
        await this.writeGate;
        return { ...input, accepted: true };
    }

    async resizeTerminal(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ) {
        this.resizes.push(input);
        await this.resizeGate;
        this.version += 1;
        return { ...input, accepted: true, version: this.version };
    }

    async killTerminal(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor> {
        this.kills.push(input);
        return {
            ...this.descriptor(),
            state: "exited",
            version: this.version + 1,
        };
    }

    async listTerminals(): Promise<WorkerTerminalDescriptor[]> {
        return [this.descriptor()];
    }

    onTerminalNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void {
        this.notification = listener;
        return () => {
            this.notification = undefined;
        };
    }

    onRpcConnected(listener: () => void): () => void {
        this.connected = listener;
        return () => {
            this.connected = undefined;
        };
    }

    onRpcDisconnected(listener: (error: WorkerRpcError) => void): () => void {
        this.disconnected = listener;
        return () => {
            this.disconnected = undefined;
        };
    }
}

test("reverse terminal backend replays, fences async operations, and resumes after reconnect", async () => {
    const worker = new FakeReverseTerminalWorker();
    const backend = new ReverseTerminalBackend({ worker });
    const opened = await backend.open({ cols: 80, rows: 24 });
    const process = "process" in opened ? opened.process : opened;
    const output: string[] = [];
    process.onData((data) => output.push(data));
    assert.deepEqual(output, ["replay"]);
    assert.deepEqual(worker.attaches, [
        {
            fromSeq: 0,
            generation: 9,
            terminalId: "remote-terminal",
        },
    ]);

    let releaseWrite!: () => void;
    worker.writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
    });
    let writeSettled = false;
    const writing = Promise.resolve(process.write("pwd\r")).then(() => {
        writeSettled = true;
    });
    await waitFor(() => worker.writes.length === 1);
    assert.equal(writeSettled, false);
    assert.equal(
        Buffer.from(worker.writes[0]!.data, "base64").toString(),
        "pwd\r",
    );
    releaseWrite();
    await writing;

    let releaseResize!: () => void;
    worker.resizeGate = new Promise<void>((resolve) => {
        releaseResize = resolve;
    });
    const resizing = process.resize(100, 40);
    await waitFor(() => worker.resizes.length === 1);
    worker.connected?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
        worker.attaches.length,
        1,
        "recovery must wait behind the in-flight versioned resize",
    );
    releaseResize();
    await resizing;
    assert.equal(worker.resizes[0]?.version, 1);
    assert.equal(worker.version, 2);

    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("live").toString("base64"),
            generation: 9,
            seq: 2,
            terminalId: "remote-terminal",
        },
    });
    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("duplicate").toString("base64"),
            generation: 9,
            seq: 2,
            terminalId: "remote-terminal",
        },
    });
    assert.deepEqual(output, ["replay", "live"]);

    await waitFor(() => worker.attaches.length === 2);
    assert.deepEqual(worker.attaches[1], {
        fromSeq: 2,
        generation: 9,
        terminalId: "remote-terminal",
    });

    await process.kill();
    assert.equal(worker.kills[0]?.version, 2);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
