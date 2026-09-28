import assert from "node:assert/strict";
import test from "node:test";

import type { DevshellPiToolSession } from "../../src/provider/pi/adapt/Bridge.ts";
import {
    hasExpandedPiTmuxResources,
    PI_TMUX_TOOL_DOMAIN,
    PiToolExposureController,
} from "../../src/provider/pi/adapt/ToolExposure.ts";
import type { PiSessionLike } from "../../src/provider/pi/runtime/Sdk.ts";
import { PI_SUBAGENT_TOOL_NAMES } from "../../src/provider/pi/subagent/Tools.ts";

class FakeSession implements PiSessionLike {
    readonly sessionId = "main";
    active = [
        "file_read",
        "bash_run",
        "tmux_input",
        "tmux_inspect",
        "tmux_manage",
        "tmux_read",
        "tmux_run",
        ...PI_SUBAGENT_TOOL_NAMES,
    ];
    readonly #listeners = new Set<(event: unknown) => void>();

    async abort() {}
    dispose() {}
    async followUp() {}
    async prompt() {}
    async reload() {}
    async waitForIdle() {}
    getActiveToolNames(): string[] { return [...this.active]; }
    setActiveToolsByName(names: readonly string[]): void { this.active = [...names]; }
    subscribe(listener: (event: unknown) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    emit(event: unknown): void {
        for (const listener of this.#listeners) listener(event);
    }
}

test("Pi tool exposure keeps gateway tools shallow and expands domains only when needed", () => {
    const session = new FakeSession();
    const exposure = new PiToolExposureController(session, {
        agent: {
            expanded: PI_SUBAGENT_TOOL_NAMES,
            gateway: ["agent_spawn"],
        },
        tmux: PI_TMUX_TOOL_DOMAIN,
    });

    assert.deepEqual(new Set(session.active), new Set([
        "file_read",
        "bash_run",
        "agent_spawn",
        "tmux_run",
    ]));

    exposure.setExpanded("agent", true);
    for (const name of PI_SUBAGENT_TOOL_NAMES)
        assert.equal(session.active.includes(name), true, name);
    assert.equal(session.active.includes("tmux_read"), false);

    session.emit({
        type: "tool_execution_end",
        toolName: "tmux_run",
        isError: false,
    });
    for (const name of PI_TMUX_TOOL_DOMAIN.expanded)
        assert.equal(session.active.includes(name), true, name);

    exposure.setExpanded("agent", false);
    assert.equal(session.active.includes("agent_spawn"), true);
    assert.equal(session.active.includes("agent_poll"), false);
    assert.equal(session.active.includes("tmux_read"), true);
    exposure.close();
});

test("Pi tmux exposure ignores the auto-created main pane but expands for real pane/task resources", async () => {
    const run = async (panes: unknown[]) =>
        await hasExpandedPiTmuxResources({
            target: { instance: "local", workspace: "workspace" },
            modelTools: [],
            tools: [{ name: "tmux_manage", description: "", inputSchema: {} }],
            async callTool() { return { panes } as never; },
            async close() {},
        } as DevshellPiToolSession);

    assert.equal(await run([{ id: "%0", name: "main", status: "idle" }]), false);
    assert.equal(
        await run([
            { id: "%0", name: "main", status: "idle" },
            { id: "%1", name: "server", status: "running" },
        ]),
        true,
    );
    assert.equal(
        await run([
            {
                id: "%0",
                name: "main",
                status: "running",
                task: { id: "task-1", status: "running" },
            },
        ]),
        true,
    );
});
