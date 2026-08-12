import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import type { TodoReadResult } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core/testing";

import {
    ControlRouteComposition,
    ControlSocketServer,
    InstanceRegistry,
} from "@portable-devshell/control/testing";
import {
    createTuiClients,
    currentTuiRoute,
    selectBreadcrumbSegments,
    selectMainScreenModel,
} from "../../src/testing.ts";
import { TuiRuntime } from "../../src/runtime/TuiRuntime.ts";
import { createTestIpcPath } from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("real TuiRuntime drives Todo overview to detail through the control socket", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-todo-detail");
    const socketPath = createTestIpcPath("tui-todo-detail", runtimeDir);
    const server = createTodoServer(socketPath);
    await server.start();
    t.after(async () => {
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    const clients = createTuiClients({ socketPath });
    t.after(() => clients.close());

    const terminal = createTerminal();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients, inkDebug: true },
    );
    const running = runtime.run();
    t.after(async () => {
        await runtime.stop();
    });

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        await waitUntil(() => runtime.store.getState().instances.length === 1);

        await runtime.handleInput("6", {});
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "todo",
        );
        await runtime.handleInput("!", {});
        await waitUntil(
            () => runtime.store.getState().ui.selectedInstance === "alpha",
        );
        await waitUntil(() =>
            selectMainScreenModel(runtime.store.getState()).boxes.some(
                (box) => box.id === "todo-task:task-1",
            ),
        );
        assert.equal(server.todoReadTitles().includes(todoFixture.title), false);

        const overviewBoxes = selectMainScreenModel(
            runtime.store.getState(),
        ).boxes;
        assert.ok(
            overviewBoxes.some((box) => box.id === "todo-task:task-1"),
            "overview should render the root task box",
        );
        assert.equal(
            overviewBoxes.some((box) => box.id.startsWith("todo-item:")),
            false,
            "overview uses summaries; full items are loaded after opening the task",
        );
        for (const box of overviewBoxes) {
            assert.notEqual(
                box.primaryAction,
                undefined,
                `every overview box must expose a primary route: ${box.id}`,
            );
        }

        await runtime.handleInput("", { tab: true });
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "mainBoxes",
        );

        await runtime.handleInput(" ", {});
        await waitUntil(
            () =>
                runtime.store.getState().ui.expandedBoxes[
                    "todo:alpha:todo-task:task-1"
                ] === true,
        );
        assert.equal(
            currentTuiRoute(runtime.store.getState()).view,
            "overview",
            "Space must only expand, not navigate",
        );
        await runtime.handleInput(" ", {});
        await waitUntil(
            () =>
                runtime.store.getState().ui.expandedBoxes[
                    "todo:alpha:todo-task:task-1"
                ] === false,
        );
        assert.equal(
            currentTuiRoute(runtime.store.getState()).view,
            "overview",
            "Space must only collapse, not navigate",
        );

        await runtime.handleInput("", { return: true });
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "todo" && route.view === "detail";
        });
        await waitUntil(() =>
            selectMainScreenModel(runtime.store.getState()).boxes.some(
                (box) => box.id === "todo-item:inspect",
            ),
        );
        assert.equal(server.todoReadTitles().includes(todoFixture.title), true);

        const detailBoxes = selectMainScreenModel(runtime.store.getState()).boxes;
        assert.ok(
            detailBoxes.some((box) => box.id === "todo-summary:task-1"),
            "detail should render the task summary box",
        );
        assert.ok(
            detailBoxes.some((box) => box.id === "todo-item:inspect"),
            "detail should render sub-item inspect",
        );
        assert.ok(
            detailBoxes.some((box) => box.id === "todo-item:implement"),
            "detail should render sub-item implement",
        );
        assert.ok(
            detailBoxes.some((box) => box.id === "todo-item:verify"),
            "detail should render sub-item verify",
        );

        await waitUntil(
            () => runtime.store.getState().ui.mainFocusId === "todo-summary:task-1",
        );
        await runtime.handleInput(" ", {});
        await waitUntil(() => {
            const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
                (candidate) => candidate.id === "todo-summary:task-1",
            );
            return box?.expanded === true;
        });
        const summary = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "todo-summary:task-1",
        );
        assert.ok(
            summary?.expandedLines.some((line) => line.text.includes("1/3")),
            "detail summary should show progress",
        );

        await runtime.handleInput(" ", {});
        await waitUntil(() => {
            const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
                (candidate) => candidate.id === "todo-summary:task-1",
            );
            return box?.expanded === false;
        });

        await runtime.handleInput("", { downArrow: true });
        await waitUntil(
            () => runtime.store.getState().ui.mainFocusId === "todo-item:inspect",
        );
        await runtime.handleInput("", { downArrow: true });
        await waitUntil(
            () => runtime.store.getState().ui.mainFocusId === "todo-item:implement",
        );
        await runtime.handleInput(" ", {});
        await waitUntil(() => {
            const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
                (candidate) => candidate.id === "todo-item:implement",
            );
            return box?.expanded === true;
        });
        const implement = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "todo-item:implement",
        );
        assert.ok(
            implement?.expandedLines.some((line) =>
                line.text.includes("Adding dedicated TUI page"),
            ),
            "detail should render the sub-item description",
        );
        assert.ok(
            implement?.expandedLines.some((line) => line.text.includes("Level")),
            "detail should render the sub-item hierarchy level",
        );
        assert.deepEqual(selectBreadcrumbSegments(runtime.store.getState()), [
            "todo",
            "Todo support",
        ]);

        await runtime.handleInput("", { escape: true });
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "todo" && route.view === "overview";
        });
        assert.equal(
            runtime.store.getState().ui.mainFocusId,
            "todo-task:task-1",
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

function createTodoServer(socketPath: string): {
    start(): Promise<void>;
    stop(): Promise<void>;
    todoReadTitles(): Array<string | undefined>;
} {
    const worker = new FakeWorker("alpha");
    const todoReadTitles: Array<string | undefined> = [];
    const instances = new InstanceRegistry([
        {
            enabled: true,
            mcpCapabilities: [],
            mcpEnabled: false,
            mcpGroups: [],
            mcpPath: "",
            name: "alpha",
            provider: "local",
            todo: {
                currentAssociation() {
                    return undefined;
                },
                async delete() {},
                async read(title?: string) {
                    todoReadTitles.push(title);
                    return title === todoFixture.title
                        ? todoFixture
                        : {
                              items: [],
                              revision: 0,
                              summary: { completed: 0, total: 0 },
                              tasks: todoFixture.tasks,
                          };
                },
                summaries() {
                    return todoFixture.tasks ?? [];
                },
                async write() {
                    return todoFixture;
                },
            },
            worker: worker as unknown as WorkerInstance,
        },
    ]);
    const routes = new ControlRouteComposition({
        config: {
            getConfigView() {
                return {
                    instances: [
                        {
                            enabled: true,
                            mcp: { enabled: false, path: "/alpha/mcp" },
                            name: "alpha",
                            provider: "local",
                        },
                    ],
                    mcp: { enabled: false, listenHost: "127.0.0.1", listenPort: 3210 },
                    version: 1,
                };
            },
        } as never,
        instances,
        mcpStatus: () => ({ running: false, reason: "MCP runtime is disabled." }),
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    return {
        start: async () => await server.start(),
        async stop() {
            await server.stop();
            routes.dispose();
        },
        todoReadTitles: () => [...todoReadTitles],
    };
}

const todoFixture: TodoReadResult = {
    items: [
        { content: "Inspect", id: "inspect", status: "completed" },
        {
            content: "Implement Todo",
            detail: "Adding dedicated TUI page",
            id: "implement",
            status: "in_progress",
        },
        { content: "Verify", id: "verify", status: "pending" },
    ],
    revision: 2,
    summary: { completed: 1, currentItemId: "implement", total: 3 },
    taskId: "task-1",
    tasks: [
        {
            completed: 1,
            revision: 2,
            status: "in_progress",
            taskId: "task-1",
            title: "Todo support",
            total: 3,
            updatedAt: "2026-07-31T00:00:00.000Z",
        },
    ],
    title: "Todo support",
};

class FakeWorker {
    readonly #name: string;

    constructor(name: string) {
        this.#name = name;
    }

    snapshot() {
        return {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 2,
            name: this.#name,
            ready: true,
            status: "ready",
        } as const;
    }

    subscribe() {
        return { events: [], kind: "events" as const, lastSeq: 2 };
    }
}

function createTerminal(): {
    output: string;
    rawModes: boolean[];
    stdin: ReadStream;
    stdout: WriteStream;
    write(value: string): void;
} {
    class Input extends PassThrough {
        readonly isTTY = true;
        readonly rawModes: boolean[] = [];

        ref(): this {
            return this;
        }

        setRawMode(enabled: boolean): this {
            this.rawModes.push(enabled);
            return this;
        }

        unref(): this {
            return this;
        }
    }

    class Output extends PassThrough {
        readonly columns = 120;
        readonly isTTY = true;
        readonly rows = 40;
    }

    const input = new Input();
    const output = new Output();
    let captured = "";
    output.on("data", (chunk) => {
        captured += chunk.toString();
    });

    return {
        get output() {
            return captured;
        },
        rawModes: input.rawModes,
        stdin: input as unknown as ReadStream,
        stdout: output as unknown as WriteStream,
        write(value: string) {
            input.write(value);
        },
    };
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for TUI state.");
        }
        await delay(5);
    }
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
