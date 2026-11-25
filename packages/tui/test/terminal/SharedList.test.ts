import assert from "node:assert/strict";
import test from "node:test";
import { TuiSharedTerminalList } from "../../src/terminal/SharedList.ts";
import type { TerminalSessionDescriptor } from "@portable-devshell/shared";

function terminal(id: string, instance: string): TerminalSessionDescriptor {
    return {
        terminalId: id,
        instance,
        generation: 1,
        version: 1,
        state: "running",
        cols: 80,
        rows: 24,
        latestSeq: 0,
        createdAt: "2026-01-01T00:00:00Z",
    };
}

test("shared terminal selection attaches the exact discovered process and returns to the list", async () => {
    const list = new TuiSharedTerminalList(async () => [
        terminal("first", "alpha"),
        terminal("second", "alpha"),
    ]);
    await list.bind("alpha");
    list.move(1);
    assert.equal(list.enter()?.terminalId, "second");
    list.leave();
    assert.equal(list.getSnapshot().active, undefined);
    assert.equal(list.getSnapshot().selectedIndex, 1);
    list.dispose();
});

test("changing the instance ignores the previous instance's delayed terminal listing", async () => {
    let resolve!: (value: TerminalSessionDescriptor[]) => void;
    const list = new TuiSharedTerminalList(async (instance) =>
        instance === "alpha"
            ? await new Promise<TerminalSessionDescriptor[]>((done) => {
                  resolve = done;
              })
            : [terminal("beta", "beta")],
    );
    const first = list.bind("alpha");
    await list.bind("beta");
    resolve([terminal("alpha", "alpha")]);
    await first;
    assert.equal(list.getSnapshot().sessions[0]?.terminalId, "beta");
    list.dispose();
});
