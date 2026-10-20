import assert from "node:assert/strict";
import test from "node:test";
import { TuiKeyDispatcher } from "../../packages/tui/src/interaction/Input.ts";
import { deferred, renderRound4Overlay, round4Tui } from "../../packages/tui/test/support/Round4Harness.ts";

async function pressEscape(harness: ReturnType<typeof round4Tui>) {
    const intents = new TuiKeyDispatcher().dispatch(harness.store.getState().interaction.focusScope,
        { input: "\u001B", key: { escape: true } });
    assert.deepEqual(intents, [{ type: "ui.cancel" }]);
    await harness.dispatcher.dispatch(intents[0]!);
}

test("H-T1: generic Escape must preserve an in-flight destructive confirmation", async () => {
    const pending = deferred<void>(); const entered = deferred<void>();
    const harness = round4Tui({ onInstanceDangerAction: async () => { entered.resolve(); await pending.promise; } });
    await harness.confirm();
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    await pressEscape(harness);
    const text = await renderRound4Overlay(harness);
    pending.resolve(); await accepted;
    assert.match(text, /Delete alpha/u);
    assert.match(text, /Working/u);
});

test("H-T2: completion of dismissed alpha future must not close a replacement beta confirmation", async () => {
    const pending = deferred<void>(); const entered = deferred<void>();
    const harness = round4Tui({ onInstanceDangerAction: async () => { entered.resolve(); await pending.promise; } });
    await harness.confirm();
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    await pressEscape(harness);
    harness.store.setSelectedInstance("beta"); await harness.confirm("beta");
    assert.match(await renderRound4Overlay(harness), /Delete beta/u);
    pending.resolve(); await accepted;
    assert.match(await renderRound4Overlay(harness), /Delete beta/u);
    assert.equal(harness.top()?.kind, "confirmation");
});

test("H-T3: old alpha rejection must not inject its error into a replacement beta confirmation", async () => {
    const pending = deferred<void>(); const entered = deferred<void>();
    const harness = round4Tui({ onInstanceDangerAction: async () => { entered.resolve(); await pending.promise; } });
    await harness.confirm();
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    await pressEscape(harness);
    harness.store.setSelectedInstance("beta"); await harness.confirm("beta");
    pending.reject(new Error("alpha resource locked by checkpoint 42")); await accepted;
    const text = await renderRound4Overlay(harness);
    assert.match(text, /Delete beta/u);
    assert.doesNotMatch(text, /alpha resource locked/u);
});
