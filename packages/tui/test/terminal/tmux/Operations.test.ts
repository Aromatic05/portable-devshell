import assert from "node:assert/strict";
import test from "node:test";
import { type JsonValue } from "@portable-devshell/shared";
import { TuiRuntimeTmuxOperations } from "../../../src/app/operation/Tmux.ts";
import { TuiTmuxPaneTerminalSession } from "../../../src/terminal/tmux/Session.ts";
import { TuiControlSession } from "../../../src/testing.ts";
import { TuiTestDomains } from "../../support/DomainHarness.ts";

{
    interface RecordedCall {
        input: JsonValue;
        instance: string;
        toolName: string;
        workspace: string;
    }

    function createHarness(responder: (call: RecordedCall) => JsonValue) {
        const calls: RecordedCall[] = [];
        const domains = new TuiTestDomains();
        domains.setInstances([
            {
                enabled: true,
                homeDirectory: "/home/alpha",
                mcpEnabled: true,
                name: "alpha",
            },
        ]);
        const session = new TuiControlSession({ domains: domains.domains });
        const operations = new TuiRuntimeTmuxOperations({
            clients: {
                tool: (instance: string) => ({
                    async call(
                        toolName: string,
                        input: JsonValue,
                        workspace: string,
                    ): Promise<JsonValue> {
                        const call: RecordedCall = {
                            input,
                            instance,
                            toolName,
                            workspace,
                        };
                        calls.push(call);
                        return responder(call);
                    },
                }),
            } as never,
            domains: domains.domains,
            operationTimeoutMs: 1000,
            reconnect: async () => undefined,
        });
        return { calls, domains, operations, session };
    }

    test("listPanes records a tmux_manage list call and preserves each task's actual status", async () => {
        const harness = createHarness((): JsonValue => ({
            panes: [
                { id: "%0", name: "main", status: "idle", workspace: "/home/alpha" },
                {
                    id: "%1",
                    name: "server",
                    status: "running",
                    workspace: "/home/alpha",
                    task: { id: "task-9", status: "running" },
                },
                {
                    id: "%2",
                    name: "done",
                    status: "0",
                    workspace: "/home/alpha",
                    task: { id: "task-5", status: "0" },
                },
            ],
        }));
        harness.domains.setToolCalls("alpha", [
            {
                callId: "call-home-tmux",
                inputSummary: '{"command":"list"}',
                instance: "alpha",
                source: "mcp",
                startedAt: "2026-08-29T08:00:00.000Z",
                status: "completed",
                toolName: "tmux_manage",
                workspace: "/home/alpha",
            } as never,
        ]);

        const panes = await harness.operations.listPanes("alpha");

        assert.deepEqual(harness.calls, [
            {
                input: { command: "list", scope: "instance" },
                instance: "alpha",
                toolName: "tmux_manage",
                workspace: "/home/alpha",
            },
        ]);
        assert.deepEqual(panes, [
            {
                id: "%1",
                name: "server",
                status: "running",
                task: { id: "task-9", status: "running" },
                workspace: "/home/alpha",
            },
            {
                id: "%2",
                name: "done",
                status: "0",
                task: { id: "task-5", status: "0" },
                workspace: "/home/alpha",
            },
            {
                id: "%0",
                name: "main",
                status: "idle",
                workspace: "/home/alpha",
            },
        ]);
    });

    test("instance discovery survives Context exit and history pruning; identical pane ids retain backend routing after cwd changes", async () => {
        let cwd = "/work/project/changed";
        const harness = createHarness((call): JsonValue => {
            if (call.toolName === "tmux_manage") {
                assert.deepEqual(call.input, { command: "list", scope: "instance" });
                assert.equal(call.workspace, "/home/alpha");
                return { panes: [
                    { id: "%0", name: "home", status: "running", workspace: "/home/alpha",
                        task: { id: "task-home", status: "running" } },
                    { id: "%0", name: "project", status: "running", workspace: "/work/project", cwd,
                        task: { id: "task-project", status: "running" } },
                ] };
            }
            if (call.toolName === "tmux_inspect") {
                return { panes: [{ id: "%0", name: "project", status: "running", cwd,
                    lines: ["project output"], task: { id: "task-project", status: "running" } }] };
            }
            assert.equal(call.toolName, "tmux_input");
            return { task: { id: "task-project", status: "running" }, output: [] };
        });
        harness.domains.setContexts([{ ctxId: "ctx-project", environments: [
            { instance: "alpha", workspace: "/work/project" },
            { instance: "beta", workspace: "/other" },
        ] } as never]);
        harness.domains.setToolCalls("alpha", [{ workspace: "/work/project" } as never]);
        const terminal = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
        await terminal.bind("alpha");
        assert.deepEqual(terminal.getSnapshot().panes.map(({ id, workspace }) => ({ id, workspace })), [
            { id: "%0", workspace: "/home/alpha" },
            { id: "%0", workspace: "/work/project" },
        ]);
        assert.equal(harness.calls.length, 1);
        terminal.selectIndex(1);
        await terminal.activate();
        assert.equal(terminal.getSnapshot().active?.workspace, "/work/project");
        assert.equal(terminal.getSnapshot().active?.cwd, cwd);
        assert.equal(terminal.getSnapshot().active?.attached, true);
        assert.equal(harness.calls.at(-1)?.workspace, "/work/project");
        harness.domains.setContexts([]);
        harness.domains.setToolCalls("alpha", []);
        cwd = "/elsewhere";
        await terminal.refresh();
        assert.equal(terminal.getSnapshot().panes.length, 2);
        assert.equal(terminal.getSnapshot().selectedIndex, 1);
        assert.equal(terminal.getSnapshot().active?.cwd, "/elsewhere");
        assert.equal(terminal.getSnapshot().active?.workspace, "/work/project");
        await terminal.handleInput("hello\r");
        assert.deepEqual(harness.calls.at(-1), {
            input: { input: "hello^M", task: "task-project", timeMs: 0 },
            instance: "alpha", toolName: "tmux_input", workspace: "/work/project",
        });
        terminal.dispose();
        const cold = await harness.operations.listPanes("alpha");
        assert.deepEqual(cold.map((pane) => pane.workspace), ["/home/alpha", "/work/project"]);
    });

    test("instance discovery rejects missing ownership instead of routing through home or cwd", async () => {
        const harness = createHarness((): JsonValue => ({
            panes: [{ id: "%0", name: "project", status: "idle", cwd: "/work/project/changed" }],
        }));
        await assert.rejects(() => harness.operations.listPanes("alpha"), /without its owning workspace/u);
    });

    test("instance discovery surfaces unmapped legacy workspace errors without guessing from Contexts", async () => {
        const harness = createHarness((): JsonValue => ({
            error: { code: "tmux.workspaceUnresolved", message: "original workspace identity is missing" },
        }));
        harness.domains.setContexts([{ ctxId: "ctx-project", environments: [
            { instance: "alpha", workspace: "/work/project" },
        ] } as never]);
        await assert.rejects(() => harness.operations.listPanes("alpha"), /tmux\.workspaceUnresolved/u);
        assert.equal(harness.calls.length, 1);
    });

    test("inspectPane records a tmux_inspect call scoped to the requested pane and line window", async () => {
        const harness = createHarness((call): JsonValue => {
            assert.deepEqual(call.input, {
                end: 0,
                pane: "server",
                start: -50,
            });
            return {
                panes: [
                    {
                        command: "node server.js",
                        cwd: "/work",
                        id: "%1",
                        lines: ["one", "two"],
                        locked: false,
                        name: "server",
                        status: "running",
                        task: { id: "task-9", status: "running" },
                    },
                ],
            };
        });

        const detail = await harness.operations.inspectPane(
            "alpha",
            "/work/server",
            "server",
            50,
        );

        assert.equal(harness.calls.length, 1);
        assert.equal(harness.calls[0]?.toolName, "tmux_inspect");
        assert.equal(harness.calls[0]?.instance, "alpha");
        assert.deepEqual(detail, {
            command: "node server.js",
            cwd: "/work",
            id: "%1",
            lines: ["one", "two"],
            locked: false,
            name: "server",
            status: "running",
            taskId: "task-9",
            taskStatus: "running",
            workspace: "/work/server",
        });
    });

    test("inspectPane clamps the requested window to the worker maximum of 200 lines", async () => {
        const harness = createHarness((): JsonValue => ({ panes: [] }));

        await harness.operations.inspectPane(
            "alpha",
            "/work/server",
            "server",
            5000,
        );

        assert.deepEqual(harness.calls[0]?.input, {
            end: 0,
            pane: "server",
            start: -200,
        });
    });

    test("inspectPane returns undefined when the worker no longer reports the pane", async () => {
        const harness = createHarness((): JsonValue => ({
            panes: [{ id: "%0", name: "main", status: "idle" }],
        }));

        const detail = await harness.operations.inspectPane(
            "alpha",
            "/work/server",
            "gone",
            50,
        );

        assert.equal(detail, undefined);
        assert.equal(harness.calls[0]?.toolName, "tmux_inspect");
    });

    test("sendInput records a tmux_input call addressed to the running task", async () => {
        const harness = createHarness((call): JsonValue => {
            assert.deepEqual(call.input, {
                input: "hello^M",
                task: "task-9",
                timeMs: 0,
            });
            return {
                output: ["hello"],
                task: { id: "task-9", status: "running" },
            };
        });

        const result = await harness.operations.sendInput(
            "alpha",
            "/work/server",
            "task-9",
            "hello^M",
        );

        assert.equal(harness.calls.length, 1);
        assert.equal(harness.calls[0]?.toolName, "tmux_input");
        assert.equal(harness.calls[0]?.instance, "alpha");
        assert.deepEqual(result, {
            output: ["hello"],
            status: "running",
            task: "task-9",
        });
    });

    test("sendInput reports the terminal task status returned by the worker", async () => {
        const harness = createHarness((): JsonValue => ({
            output: ["bye"],
            task: { id: "task-9", status: "0" },
        }));

        const result = await harness.operations.sendInput(
            "alpha",
            "/work/server",
            "task-9",
            "^D",
        );

        assert.deepEqual(result, {
            output: ["bye"],
            status: "0",
            task: "task-9",
        });
    });

    test("tmux operations surface a coded worker error instead of parsing it as data", async () => {
        const harness = createHarness((): JsonValue => ({
            error: { code: "tmux.paneNotFound", message: "no such pane" },
        }));

        await assert.rejects(
            () =>
                harness.operations.inspectPane(
                    "alpha",
                    "/work/server",
                    "missing",
                    50,
                ),
            /tmux\.paneNotFound: no such pane/u,
        );
    });

    test("inspectPane gives an exact pane id precedence over another pane's matching name", async () => {
        const harness = createHarness((): JsonValue => ({
            panes: [
                { id: "%1", name: "%2", status: "idle", lines: ["wrong"] },
                {
                    id: "%2",
                    name: "target",
                    status: "running",
                    lines: ["right"],
                },
            ],
        }));

        const detail = await harness.operations.inspectPane(
            "alpha",
            "/work/server",
            "%2",
            50,
        );

        assert.equal(detail?.id, "%2");
        assert.equal(detail?.name, "target");
        assert.deepEqual(detail?.lines, ["right"]);
    });
}
