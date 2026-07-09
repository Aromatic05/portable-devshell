import assert from "node:assert/strict";
import test from "node:test";

import { TuiFocusManager, TuiFormState, TuiInteractionController, TuiModalState } from "../../dist/index.js";

test("TuiFocusManager skips hidden entries and restores the previous focus when leaving nested scopes", () => {
    const focusManager = new TuiFocusManager();

    focusManager.registerScope({ id: "sidebar" });
    focusManager.registerScope({ id: "panel", parentId: "sidebar" });
    focusManager.registerScope({ id: "modal", parentId: "panel" });

    focusManager.setScopeEntries("sidebar", [
        { actionId: "sidebar.instances", id: "sidebar.instances" },
        { actionId: "sidebar.config", id: "sidebar.config" }
    ]);
    focusManager.setScopeEntries("panel", [
        { actionId: "instance.select", id: "instance.list" },
        { actionId: "status.open", id: "status.panel", visible: false },
        { actionId: "logs.open", id: "logs.panel" },
        { actionId: "audit.open", id: "tool.audit.box" },
        { actionId: "approval.open", id: "approval.inbox.item" }
    ]);
    focusManager.setScopeEntries("modal", [
        { actionId: "modal.confirm", id: "modal.confirm" },
        { actionId: "modal.cancel", id: "modal.cancel" }
    ]);

    focusManager.enterScope("sidebar", "sidebar.config");
    focusManager.enterScope("panel", "logs.panel");

    assert.equal(focusManager.currentFocusId(), "logs.panel");

    focusManager.focusDirectional("down");
    assert.equal(focusManager.currentFocusId(), "tool.audit.box");

    focusManager.focusDirectional("down");
    assert.equal(focusManager.currentFocusId(), "approval.inbox.item");

    focusManager.enterScope("modal", "modal.cancel");
    assert.equal(focusManager.currentFocusId(), "modal.cancel");

    assert.equal(focusManager.exitScope(), true);
    assert.equal(focusManager.currentScopeId(), "panel");
    assert.equal(focusManager.currentFocusId(), "approval.inbox.item");
});

test("TuiInteractionController drives save and cancel actions through tab navigation and enter", async () => {
    const submittedDrafts: Array<{ name: string }> = [];
    let refreshCount = 0;
    const controller = new TuiInteractionController({
        form: new TuiFormState(
            { name: "alpha" },
            {
                onRefresh: () => {
                    refreshCount += 1;
                },
                onSubmit: async (draft) => {
                    submittedDrafts.push(draft);
                    return draft;
                },
                validate: (draft) => (draft.name.length === 0 ? { name: "required" } : {})
            }
        ),
        modal: new TuiModalState()
    });

    controller.focusManager.registerScope({ id: "root" });
    controller.focusManager.registerScope({ id: "form", parentId: "root" });
    controller.focusManager.setScopeEntries("root", [{ actionId: "open.form", id: "sidebar.config" }]);
    controller.focusManager.setScopeEntries("form", [
        { id: "config.form" },
        { actionId: "form.save", id: "save.button" },
        { actionId: "form.cancel", id: "cancel.button" }
    ]);

    controller.focusManager.enterScope("root", "sidebar.config");
    controller.focusManager.enterScope("form", "config.form");

    controller.formState().update("name", "beta");

    assert.equal(await controller.handleKey("tab"), true);
    assert.equal(controller.focusManager.currentFocusId(), "save.button");
    assert.equal(await controller.handleKey("shift+tab"), true);
    assert.equal(controller.focusManager.currentFocusId(), "config.form");
    assert.equal(await controller.handleKey("tab"), true);
    assert.equal(controller.focusManager.currentFocusId(), "save.button");
    assert.equal(await controller.handleKey("enter"), true);
    assert.deepEqual(submittedDrafts, [{ name: "beta" }]);
    assert.equal(refreshCount, 1);
    assert.equal(controller.formState().source().name, "beta");
    assert.equal(controller.formState().dirty(), false);

    controller.formState().update("name", "gamma");

    assert.equal(await controller.handleKey("tab"), true);
    assert.equal(controller.focusManager.currentFocusId(), "cancel.button");
    assert.equal(await controller.handleKey("enter"), true);
    assert.equal(controller.focusManager.currentScopeId(), "root");
    assert.equal(controller.focusManager.currentFocusId(), "sidebar.config");
    assert.equal(controller.formState().draft().name, "beta");
    assert.equal(controller.formState().dirty(), false);
});

test("TuiInteractionController blocks invalid and duplicate async submit attempts", async () => {
    const deferred = createDeferred<{ name: string }>();
    let refreshCount = 0;
    let submitCount = 0;
    const controller = new TuiInteractionController({
        form: new TuiFormState(
            { name: "alpha" },
            {
                onRefresh: () => {
                    refreshCount += 1;
                },
                onSubmit: async (draft) => {
                    submitCount += 1;
                    return await deferred.promise.then(() => draft);
                },
                validate: (draft) => (draft.name.length === 0 ? { name: "required" } : {})
            }
        ),
        modal: new TuiModalState()
    });

    controller.focusManager.registerScope({ id: "form" });
    controller.focusManager.setScopeEntries("form", [
        { id: "config.form" },
        { actionId: "form.save", id: "save.button" }
    ]);
    controller.focusManager.enterScope("form", "save.button");

    controller.formState().update("name", "");
    assert.equal(await controller.handleKey("enter"), false);
    assert.deepEqual(controller.formState().validationErrors(), { name: "required" });
    assert.equal(submitCount, 0);

    controller.formState().update("name", "beta");

    const firstSubmit = controller.handleKey("enter");
    const secondSubmit = controller.handleKey("enter");

    deferred.resolve({ name: "beta" });

    assert.equal(await firstSubmit, true);
    assert.equal(await secondSubmit, false);
    assert.equal(submitCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(controller.formState().source().name, "beta");
});

test("TuiInteractionController uses enter for modal confirm, escape for modal close, and surfaces submit errors", async () => {
    let confirmed = 0;
    const controller = new TuiInteractionController({
        form: new TuiFormState(
            { name: "alpha" },
            {
                onSubmit: async () => {
                    throw new Error("server rejected config");
                }
            }
        ),
        modal: new TuiModalState()
    });

    controller.dispatcher.register("modal.confirm", () => {
        confirmed += 1;
        return true;
    });

    controller.focusManager.registerScope({ id: "root" });
    controller.focusManager.registerScope({ id: "form", parentId: "root" });
    controller.focusManager.registerScope({ id: "modal", parentId: "form" });
    controller.focusManager.setScopeEntries("root", [{ actionId: "open.form", id: "sidebar.config" }]);
    controller.focusManager.setScopeEntries("form", [
        { id: "config.form" },
        { actionId: "form.save", id: "save.button" }
    ]);
    controller.focusManager.setScopeEntries("modal", [
        { actionId: "modal.confirm", id: "modal.confirm" },
        { actionId: "modal.close", id: "modal.cancel" }
    ]);

    controller.focusManager.enterScope("root", "sidebar.config");
    controller.focusManager.enterScope("form", "save.button");
    controller.formState().update("name", "beta");

    controller.modal().open({
        cancelLabel: "Cancel",
        confirmActionId: "modal.confirm",
        confirmLabel: "Apply",
        description: "Confirm config apply.",
        title: "Apply changes"
    });
    controller.focusManager.enterScope("modal", "modal.confirm");

    assert.equal(await controller.handleKey("enter"), true);
    assert.equal(confirmed, 1);

    assert.equal(await controller.handleKey("esc"), true);
    assert.equal(controller.modalState().open, false);
    assert.equal(controller.focusManager.currentScopeId(), "form");
    assert.equal(controller.focusManager.currentFocusId(), "save.button");

    assert.equal(await controller.handleKey("enter"), false);
    assert.equal(controller.errorMessage(), "server rejected config");
    assert.equal(await controller.handleKey("ctrl+c"), true);
    assert.equal(controller.quitRequested(), true);
});

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });

    return { promise, resolve };
}
