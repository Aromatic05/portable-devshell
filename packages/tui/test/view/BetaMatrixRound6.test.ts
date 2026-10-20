import assert from "node:assert/strict";
import test from "node:test";
import { deferred, round6Tui } from "../support/Round6Harness.ts";

test("round6 TUI: Instance start remains bound to the dispatched instance after focus switches", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    const harness = round6Tui({ onInstanceAction: async (action, instance) => {
        calls.push(`${action}:${instance}`); entered.resolve(); await release.promise;
    } });
    const operation = harness.dispatcher.dispatch({ type: "instance.start", instance: "alpha" });
    await entered.promise;
    harness.store.setSelectedInstance("beta");
    release.resolve();
    assert.equal(await operation, true);
    assert.deepEqual(calls, ["start:alpha"]);
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("round6 TUI: stop and restart dispatches keep target stable across a page and instance change", async () => {
    const calls: string[] = [];
    const harness = round6Tui({ onInstanceAction: async (action, instance) => { calls.push(`${action}:${instance}`); } });
    assert.equal(await harness.dispatcher.dispatch({ type: "instance.stop", instance: "alpha" }), true);
    harness.store.setSelectedPage("overview");
    harness.store.setSelectedInstance("beta");
    assert.equal(await harness.dispatcher.dispatch({ type: "instance.restart", instance: "alpha" }), true);
    assert.deepEqual(calls, ["stop:alpha", "restart:alpha"]);
});

test("round6 TUI: raw event output survives unrelated snapshot refreshes and retains newest bounded window", () => {
    const harness = round6Tui();
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "output", instance: "alpha", seq: 1 } });
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "output", instance: "alpha", seq: 2 } });
    harness.store.setConnectionState("connecting");
    harness.store.setSelectedInstance("beta");
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "output", instance: "alpha", seq: 3 } });
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "output", instance: "alpha", seq: 4 } });
    assert.deepEqual(harness.store.getState().rawEvents.map(({ seq }) => seq), [2, 3, 4]);
});

test("round6 TUI: snapshot replacement through domain reader does not erase retained event output", () => {
    const harness = round6Tui();
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "tool.completed", instance: "alpha", payload: { output: "kept" }, seq: 11 } });
    harness.domains.setInstances([{ name: "alpha", enabled: false, mcpEnabled: true }]);
    harness.store.setConnectionState("connected");
    assert.deepEqual(harness.store.getState().rawEvents, [{ event: "tool.completed", instance: "alpha", payload: { output: "kept" }, seq: 11 }]);
    assert.deepEqual(harness.domains.reader.instances.instances.map(({ name }) => name), ["alpha"]);
});

test("round6 TUI: failed in-flight enable confirmation remains visible while selected instance changes", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const calls: Array<[string, boolean]> = [];
    const harness = round6Tui({ onInstanceEnabledChange: async (instance, enabled) => {
        calls.push([instance, enabled]); entered.resolve(); await release.promise; throw new Error("registry rejected alpha");
    } });
    await harness.dispatcher.dispatch({ type: "overlay.openConfirm", title: "Disable alpha", body: "Review alpha", confirmLabel: "Disable", confirmIntent: { type: "instance.setEnabled", instance: "alpha", enabled: false } });
    await harness.dispatcher.dispatch({ type: "confirm.focus", button: "confirm" });
    const confirm = harness.dispatcher.dispatch({ type: "confirm.accept" });
    await entered.promise;
    harness.store.setSelectedInstance("beta");
    assert.equal(harness.store.getState().interaction.overlays.at(-1)?.kind, "confirmation");
    release.resolve();
    await confirm;
    assert.deepEqual(calls, [["alpha", false]]);
    assert.equal(harness.store.getState().interaction.overlays.at(-1)?.kind, "confirmation");
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("round6 TUI: cancellation before accepting an instance confirmation performs no mutation", async () => {
    const calls: string[] = [];
    const harness = round6Tui({ onInstanceEnabledChange: async (instance, enabled) => { calls.push(`${instance}:${enabled}`); } });
    await harness.dispatcher.dispatch({ type: "overlay.openConfirm", title: "Disable alpha", body: "Review alpha", confirmLabel: "Disable", confirmIntent: { type: "instance.setEnabled", instance: "alpha", enabled: false } });
    await harness.dispatcher.dispatch({ type: "confirm.focus", button: "cancel" });
    assert.equal(await harness.dispatcher.dispatch({ type: "confirm.cancel" }), true);
    assert.deepEqual(calls, []);
    assert.equal(harness.store.getState().interaction.overlays.length, 0);
});

test("round6 TUI: async operation failure is not redirected into the newly selected instance status", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const harness = round6Tui({ onInstanceAction: async (_action, instance) => {
        assert.equal(instance, "alpha"); entered.resolve(); await release.promise; throw new Error("alpha start failed");
    } });
    const operation = harness.dispatcher.dispatch({ type: "instance.start", instance: "alpha" });
    await entered.promise;
    harness.store.setSelectedInstance("beta");
    release.resolve();
    await assert.rejects(operation, /alpha start failed/u);
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("round6 TUI: event replay cursor remains monotonic across reconnect state transitions", () => {
    const harness = round6Tui();
    for (const seq of [41, 42, 43]) harness.store.dispatch({ type: "event.append", rawEvent: { event: "tool.progress", instance: "alpha", seq } });
    harness.store.setConnectionState("disconnected");
    harness.store.setConnectionState("connecting");
    harness.store.setConnectionState("connected");
    harness.store.dispatch({ type: "event.append", rawEvent: { event: "tool.progress", instance: "alpha", seq: 44 } });
    assert.deepEqual(harness.store.getState().rawEvents.map(({ seq }) => seq), [42, 43, 44]);
});
