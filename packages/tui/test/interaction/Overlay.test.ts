import assert from "node:assert/strict";
import test from "node:test";
import { TuiKeyDispatcher, type TuiKeyPress } from "../../src/interaction/Input.ts";
import { TuiCommandDispatcherOverlay } from "../../src/interaction/command/Overlay.ts";
import { TuiCommandDispatcherFocus } from "../../src/interaction/command/navigation/Focus.ts";
import type { TuiUiIntent } from "../../src/state/Interaction.ts";
import { deferred, round4Tui } from "../support/Round4Harness.ts";

type Harness = ReturnType<typeof round4Tui>;

async function press(harness: Harness, key: TuiKeyPress) {
    const intents = new TuiKeyDispatcher().dispatch(
        harness.store.getState().interaction.focusScope,
        key,
    );
    await harness.dispatcher.dispatchMany(intents);
    return intents;
}

function dangerHarness() {
    const entered = deferred<void>();
    const pending = deferred<void>();
    const calls: unknown[] = [];
    const harness = round4Tui({
        onInstanceDangerAction: async (...args) => {
            calls.push(args);
            entered.resolve();
            await pending.promise;
        },
    });
    return { ...harness, entered, pending, calls };
}

async function start(harness: ReturnType<typeof dangerHarness>) {
    await harness.confirm();
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" });
    await harness.entered.promise;
    assert.equal(harness.top()?.kind, "confirmation");
    return { accepted };
}

const escapes: Record<string, TuiKeyPress> = {
    "Escape flag": { input: "", key: { escape: true } },
    "raw Escape": { input: "\u001B", key: {} },
    "Ctrl+[": { input: "[", key: { ctrl: true } },
};

for (const [name, key] of Object.entries(escapes)) {
    test(`${name} preserves a busy confirmation and restores idle focus`, async () => {
        const harness = dangerHarness();
        harness.store.setFocusScope("sidebarInstances");
        const { accepted } = await start(harness);
        const operation = harness.top();
        assert.deepEqual(await press(harness, key), [{ type: "ui.cancel" }]);
        assert.equal(harness.top(), operation);
        assert.equal(harness.store.getState().interaction.focusScope, "confirm");
        assert.deepEqual(harness.calls, [["delete", "alpha"]]);

        harness.pending.resolve();
        assert.equal(await accepted, true);
        assert.equal(harness.top(), undefined);
        assert.equal(harness.store.getState().interaction.focusScope, "sidebarInstances");

        await harness.confirm();
        await press(harness, key);
        assert.equal(harness.top(), undefined);
        assert.equal(harness.store.getState().interaction.focusScope, "sidebarInstances");
        assert.deepEqual(harness.calls, [["delete", "alpha"]]);
    });
}

test("busy keyboard focus changes and repeated Enter cannot cancel or repeat the operation", async () => {
    const harness = dangerHarness();
    const { accepted } = await start(harness);
    const operation = harness.top();
    for (const key of [
        { tab: true },
        { tab: true, shift: true },
        { leftArrow: true },
        { rightArrow: true },
    ]) {
        const intents = await press(harness, { input: "", key });
        assert.equal(intents[0]?.type, "focus.move");
        assert.equal(harness.top(), operation);
        assert.deepEqual(await press(harness, { input: "", key: { return: true } }), [
            { type: "confirm.accept" },
        ]);
        assert.equal(harness.top(), operation);
    }
    for (const type of ["confirm.cancel", "overlay.closeConfirm", "ui.cancel"] as const) {
        assert.equal(await harness.dispatcher.dispatch({ type }), true);
        assert.equal(harness.top(), operation);
    }
    await harness.dispatcher.dispatch({ type: "confirm.focus", button: "cancel" });
    assert.equal(harness.top(), operation);
    assert.deepEqual(harness.calls, [["delete", "alpha"]]);

    harness.pending.reject(new Error("alpha checkpoint 42 is locked"));
    await accepted;
    const failed = harness.top();
    assert.ok(failed?.kind === "confirmation");
    assert.equal(failed.busy, false);
    assert.equal(failed.error, "alpha checkpoint 42 is locked");
    assert.equal(failed.selectedAction, "confirm");
    await press(harness, { input: "", key: { leftArrow: true } });
    const cancel = harness.top();
    assert.ok(cancel?.kind === "confirmation");
    assert.equal(cancel.selectedAction, "cancel");
    await press(harness, { input: "", key: { return: true } });
    assert.equal(harness.top(), undefined);
    assert.deepEqual(harness.calls, [["delete", "alpha"]]);
});

test("busy accept ignores even a cancel selection and re-enables idle Escape after failure", async () => {
    const harness = round4Tui();
    await harness.confirm();
    const overlay = harness.top();
    assert.ok(overlay?.kind === "confirmation");
    const operation = { ...overlay, busy: true, selectedAction: "cancel" as const };
    harness.store.replaceTopOverlay(operation);
    await press(harness, { input: "", key: { return: true } });
    assert.equal(harness.top(), operation);
    harness.store.replaceTopOverlay({ ...operation, busy: false, error: "rejected" });
    await press(harness, escapes["raw Escape"]!);
    assert.equal(harness.top(), undefined);
});

for (const scope of ["mainBoxes", "form", "approvalDetail"] as const) {
    test(`busy confirmation still owns keyboard input after instance navigation restores ${scope}`, async () => {
        const harness = dangerHarness();
        const { accepted } = await start(harness);
        harness.store.setSelectedInstance("beta");
        harness.store.setFocusScope(scope);
        const operation = harness.top();
        const before = harness.store.getState();
        await press(harness, escapes["raw Escape"]!);
        await press(harness, { input: "", key: { tab: true } });
        await press(harness, { input: "", key: { return: true } });
        assert.equal(harness.top(), operation);
        assert.equal(harness.store.getState(), before);
        assert.deepEqual(harness.calls, [["delete", "alpha"]]);
        harness.pending.resolve();
        await accepted;
        assert.equal(harness.top(), undefined);
        assert.equal(harness.store.getState().interaction.focusScope, scope);
        assert.equal(harness.store.getState().ui.selectedInstance, "beta");
    });
}

for (const outcome of ["resolve", "reject"] as const) {
    for (const instance of ["alpha", "beta"] as const) {
        test(`late ${outcome} leaves an identical replacement on ${instance} untouched`, async () => {
            const harness = dangerHarness();
            const { accepted } = await start(harness);
            const operation = harness.top();
            assert.ok(operation?.kind === "confirmation");
            harness.store.setSelectedInstance(instance);
            const replacement = { ...operation, busy: false, error: "replacement failure" };
            harness.store.replaceTopOverlay(replacement);
            const before = harness.store.getState();
            const settle = {
                resolve: () => harness.pending.resolve(),
                reject: () => harness.pending.reject(new Error("obsolete alpha error")),
            };
            settle[outcome]();
            await accepted;
            assert.equal(harness.top(), replacement);
            assert.equal(harness.store.getState(), before);
            assert.equal(harness.store.getState().ui.selectedInstance, instance);
            await press(harness, escapes["raw Escape"]!);
            assert.equal(harness.top(), undefined);
        });
    }

    test(`late ${outcome} cannot change a newer text detail or restore its focus`, async () => {
        const harness = dangerHarness();
        const { accepted } = await start(harness);
        harness.store.setSelectedInstance("beta");
        await harness.dispatcher.dispatch({ type: "textDetail.open", title: "Beta detail", body: "beta" });
        const before = harness.store.getState();
        const settle = {
            resolve: () => harness.pending.resolve(),
            reject: () => harness.pending.reject(new Error("obsolete alpha error")),
        };
        settle[outcome]();
        await accepted;
        assert.equal(harness.store.getState(), before);
        assert.equal(harness.top()?.kind, "text-detail");
        assert.equal(harness.store.getState().interaction.focusScope, "textDetail");
    });

    test(`late ${outcome} after removal does not recreate an overlay`, async () => {
        const harness = dangerHarness();
        const { accepted } = await start(harness);
        harness.store.popOverlay();
        harness.store.setSelectedInstance("beta");
        harness.store.setFocusScope("sidebarInstances");
        const before = harness.store.getState();
        const settle = {
            resolve: () => harness.pending.resolve(),
            reject: () => harness.pending.reject(new Error("obsolete alpha error")),
        };
        settle[outcome]();
        await accepted;
        assert.equal(harness.store.getState(), before);
        assert.equal(harness.top(), undefined);
    });
}

for (const outcome of ["resolve", "reject"] as const) {
    for (const first of ["old", "new"] as const) {
        test(`${outcome} of ${first} operation first preserves the newer operation's lifecycle`, async () => {
            const old = { entered: deferred<void>(), pending: deferred<void>() };
            const next = { entered: deferred<void>(), pending: deferred<void>() };
            const operations = { alpha: old, beta: next };
            const calls: unknown[] = [];
            const harness = round4Tui({ onInstanceDangerAction: async (...args) => {
                calls.push(args);
                const operation = operations[args[1] as keyof typeof operations];
                assert.ok(operation);
                operation.entered.resolve();
                await operation.pending.promise;
            } });
            await harness.confirm();
            const oldAccepted = harness.dispatcher.dispatch({ type: "confirm.accept" });
            await old.entered.promise;
            harness.store.setSelectedInstance("beta");
            await harness.confirm("beta");
            const nextAccepted = harness.dispatcher.dispatch({ type: "confirm.accept" });
            await next.entered.promise;
            const replacement = harness.top();
            const finishOld = async () => {
                const settle = {
                    resolve: () => old.pending.resolve(),
                    reject: () => old.pending.reject(new Error("obsolete alpha error")),
                };
                settle[outcome]();
                await oldAccepted;
            };
            const finishNew = async () => {
                next.pending.reject(new Error("beta checkpoint is locked"));
                await nextAccepted;
                const failed = harness.top();
                assert.ok(failed?.kind === "confirmation");
                assert.equal(failed.title, "Delete beta");
                assert.equal(failed.busy, false);
                assert.equal(failed.error, "beta checkpoint is locked");
            };
            const orders = {
                old: async () => {
                    await finishOld();
                    assert.equal(harness.top(), replacement);
                    await finishNew();
                },
                new: async () => {
                    await finishNew();
                    const failed = harness.top();
                    await finishOld();
                    assert.equal(harness.top(), failed);
                },
            };
            await orders[first]();
            assert.deepEqual(calls, [["delete", "alpha"], ["delete", "beta"]]);
            assert.equal(harness.store.getState().ui.selectedInstance, "beta");
            await press(harness, escapes["raw Escape"]!);
            assert.notEqual(harness.top(), replacement);
        });
    }
}

test("rejection followed by a keyboard retry clears the old error and serializes the new attempt", async () => {
    const first = { entered: deferred<void>(), pending: deferred<void>() };
    const second = { entered: deferred<void>(), pending: deferred<void>() };
    const attempts = [first, second];
    const calls: unknown[] = [];
    const harness = round4Tui({ onInstanceDangerAction: async (...args) => {
        calls.push(args);
        const attempt = attempts.shift();
        assert.ok(attempt);
        attempt.entered.resolve();
        await attempt.pending.promise;
    } });
    harness.store.setFocusScope("sidebarInstances");
    await harness.confirm();
    const initial = press(harness, { input: "", key: { return: true } });
    await first.entered.promise;
    first.pending.reject(new Error("revision 7 locked"));
    await initial;
    const failed = harness.top();
    assert.ok(failed?.kind === "confirmation");
    assert.equal(failed.error, "revision 7 locked");
    assert.equal(failed.busy, false);

    const retry = press(harness, { input: "", key: { return: true } });
    await second.entered.promise;
    const operation = harness.top();
    assert.ok(operation?.kind === "confirmation");
    assert.equal(operation.busy, true);
    assert.equal(operation.error, undefined);
    assert.equal(operation.title, "Delete alpha");
    await press(harness, escapes["raw Escape"]!);
    await press(harness, { input: "", key: { return: true } });
    assert.equal(harness.top(), operation);
    assert.deepEqual(calls, [["delete", "alpha"], ["delete", "alpha"]]);
    second.pending.resolve();
    await retry;
    assert.equal(harness.top(), undefined);
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarInstances");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
});

test("a false decision result leaves the owned confirmation retryable and cannot affect its replacement", async () => {
    const harness = round4Tui();
    const entered = deferred<void>();
    const pending = deferred<boolean>();
    const retryPending = deferred<boolean>();
    const attempts = [pending, retryPending];
    const calls: TuiUiIntent[] = [];
    const overlay = new TuiCommandDispatcherOverlay({
        dispatch: async (intent) => {
            calls.push(intent);
            entered.resolve();
            const attempt = attempts.shift();
            assert.ok(attempt);
            return await attempt.promise;
        },
        focus: new TuiCommandDispatcherFocus({ store: harness.store, projection: harness.domains.projection, mainViewportRows: () => 24 }),
        focusManager: harness.focusManager,
        store: harness.store,
    });
    await harness.confirm();
    const accepted = overlay.dispatch({ type: "confirm.accept" });
    await entered.promise;
    pending.resolve(false);
    assert.equal(await accepted, true);
    const failed = harness.top();
    assert.ok(failed?.kind === "confirmation");
    assert.equal(failed.busy, false);
    assert.equal(failed.error, "Action could not be completed.");
    const retry = overlay.dispatch({ type: "confirm.accept" });
    const retryOverlay = harness.top();
    assert.ok(retryOverlay?.kind === "confirmation");
    assert.equal(retryOverlay.busy, true);
    assert.equal(retryOverlay.error, undefined);
    harness.store.setSelectedInstance("beta");
    await harness.confirm("beta");
    const replacement = harness.top();
    retryPending.resolve(false);
    await retry;
    assert.equal(harness.top(), replacement);
    assert.deepEqual(calls, [
        { type: "instance.delete", instance: "alpha" },
        { type: "instance.delete", instance: "alpha" },
    ]);
});

for (const type of ["approval.decide", "approval.confirmDeny"] as const) {
    test(`late ${type} success cannot close a newer approval detail`, async () => {
        const entered = deferred<void>();
        const pending = deferred<void>();
        const calls: unknown[] = [];
        const harness = round4Tui({ onApprovalDecision: async (...args) => {
            calls.push(args);
            entered.resolve();
            await pending.promise;
        } });
        await harness.dispatcher.dispatch({ type: "approval.open", instance: "alpha", approvalId: "old" });
        await harness.confirm("alpha", { type, instance: "alpha", approvalId: "old", decision: "approve" });
        const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" });
        await entered.promise;
        harness.store.setSelectedInstance("beta");
        await harness.dispatcher.dispatch({ type: "approval.open", instance: "beta", approvalId: "new" });
        const before = harness.store.getState();
        pending.resolve();
        await accepted;
        assert.equal(harness.store.getState(), before);
        assert.deepEqual(harness.top(), { kind: "approval", instance: "beta", approvalId: "new", selectedAction: "back" });
        assert.deepEqual(calls, [["alpha", "old", type === "approval.decide" ? "approve" : "deny"]]);
    });
}
