import assert from "node:assert/strict";
import test from "node:test";

import { TuiFormState, TuiInteractionController, TuiModalState } from "../../dist/index.js";

test("Tui interaction controller cycles focus and skips hidden entries", async () => {
    const controller = createController({
        initialValue: { workspace: "/tmp/ws" },
        onSubmit: async (draft) => draft
    });

    controller.focusManager.registerScope({ id: "main" });
    controller.focusManager.setScopeEntries("main", [
        { id: "sidebar.tab.instances" },
        { id: "instance.list" },
        { id: "status.panel", visible: false },
        { id: "logs.panel" },
        { id: "tool.audit.box" },
        { id: "approval.inbox.item" }
    ]);
    controller.focusManager.focusFirstVisible("main");

    assert.equal(controller.focusManager.currentFocusId(), "sidebar.tab.instances");

    await controller.handleKey("tab");
    assert.equal(controller.focusManager.currentFocusId(), "instance.list");

    await controller.handleKey("down");
    assert.equal(controller.focusManager.currentFocusId(), "logs.panel");

    await controller.handleKey("shift+tab");
    assert.equal(controller.focusManager.currentFocusId(), "instance.list");

    await controller.handleKey("up");
    assert.equal(controller.focusManager.currentFocusId(), "sidebar.tab.instances");
});

test("Tui interaction controller drives save, cancel, validation, and refresh through focused actions", async () => {
    const submitted: Array<{ workspace: string }> = [];
    let refreshCount = 0;
    const controller = createController({
        initialValue: { workspace: "/tmp/ws" },
        onRefresh: async () => {
            refreshCount += 1;
        },
        onSubmit: async (draft) => {
            submitted.push({ ...draft });
            return draft;
        },
        validate: (draft) => (draft.workspace.length === 0 ? { workspace: "workspace is required" } : {})
    });

    controller.focusManager.registerScope({ id: "main" });
    controller.focusManager.registerScope({ id: "config-form", parentId: "main" });
    controller.focusManager.setScopeEntries("main", [{ id: "config.form" }]);
    controller.focusManager.setScopeEntries("config-form", [
        { id: "config.form", actionId: "form.edit" },
        { id: "save.button", actionId: "form.save" },
        { id: "cancel.button", actionId: "form.cancel" }
    ]);
    controller.dispatcher.register("form.edit", () => {
        controller.formState().beginEdit();
        return true;
    });

    controller.focusManager.enterScope("config-form", "config.form");
    await controller.handleKey("enter");

    controller.formState().update("workspace", "");
    controller.focusManager.focus("config-form", "save.button");
    assert.equal(await controller.handleKey("enter"), false);
    assert.deepEqual(submitted, []);
    assert.equal(controller.formState().source().workspace, "/tmp/ws");
    assert.equal(controller.formState().validationErrors().workspace, "workspace is required");

    controller.formState().update("workspace", "/tmp/next");
    assert.equal(controller.formState().dirty(), true);
    assert.equal(controller.formState().canSave(), true);

    assert.equal(await controller.handleKey("enter"), true);
    assert.deepEqual(submitted, [{ workspace: "/tmp/next" }]);
    assert.equal(refreshCount, 1);
    assert.equal(controller.formState().source().workspace, "/tmp/next");
    assert.equal(controller.formState().dirty(), false);

    controller.formState().beginEdit();
    controller.formState().update("workspace", "/tmp/draft");
    controller.focusManager.focus("config-form", "cancel.button");
    assert.equal(await controller.handleKey("enter"), true);
    assert.equal(controller.focusManager.currentScopeId(), "main");
    assert.equal(controller.formState().source().workspace, "/tmp/next");
    assert.equal(controller.formState().draft().workspace, "/tmp/next");
    assert.equal(controller.formState().dirty(), false);
});

test("Tui interaction controller closes modal or exits edit mode on esc", async () => {
    const controller = createController({
        initialValue: { workspace: "/tmp/ws" },
        onSubmit: async (draft) => draft
    });

    controller.focusManager.registerScope({ id: "main" });
    controller.focusManager.registerScope({ id: "config-form", parentId: "main" });
    controller.focusManager.registerScope({ id: "modal", parentId: "config-form" });
    controller.focusManager.setScopeEntries("main", [{ id: "sidebar.tab.instances" }]);
    controller.focusManager.setScopeEntries("config-form", [
        { id: "config.form" },
        { id: "save.button", actionId: "form.save" },
        { id: "cancel.button", actionId: "form.cancel" }
    ]);
    controller.focusManager.setScopeEntries("modal", [
        { id: "modal.confirm", actionId: "modal.confirm" },
        { id: "modal.cancel", actionId: "modal.close" }
    ]);
    let confirmed = false;
    controller.dispatcher.register("modal.confirm", () => {
        confirmed = true;
        return controller.dispatcher.dispatch("modal.close");
    });

    controller.focusManager.enterScope("config-form", "config.form");
    controller.formState().beginEdit();
    controller.formState().update("workspace", "/tmp/draft");

    assert.equal(await controller.handleKey("esc"), true);
    assert.equal(controller.focusManager.currentScopeId(), "main");
    assert.equal(controller.formState().draft().workspace, "/tmp/ws");
    assert.equal(controller.formState().dirty(), false);

    controller.focusManager.enterScope("config-form", "config.form");
    controller.modal().open({
        cancelLabel: "Cancel",
        confirmActionId: "modal.confirm",
        confirmLabel: "Confirm",
        description: "Delete instance?",
        title: "Confirm"
    });
    controller.focusManager.enterScope("modal", "modal.confirm");

    assert.equal(await controller.handleKey("enter"), true);
    assert.equal(confirmed, true);
    assert.equal(controller.modalState().open, false);
    assert.equal(controller.focusManager.currentScopeId(), "config-form");

    controller.modal().open({
        cancelLabel: "Cancel",
        confirmActionId: "modal.confirm",
        confirmLabel: "Confirm",
        description: "Delete instance?",
        title: "Confirm"
    });
    controller.focusManager.enterScope("modal", "modal.cancel");
    assert.equal(await controller.handleKey("esc"), true);
    assert.equal(controller.modalState().open, false);
    assert.equal(controller.focusManager.currentScopeId(), "config-form");
});

test("Tui interaction controller prevents duplicate async submit while a save is running", async () => {
    let resolveSubmit: ((value: { workspace: string }) => void) | undefined;
    let submitCount = 0;
    const controller = createController({
        initialValue: { workspace: "/tmp/ws" },
        onSubmit: async (draft) => {
            submitCount += 1;
            return await new Promise<{ workspace: string }>((resolve) => {
                resolveSubmit = resolve;
            }).then(() => draft);
        }
    });

    controller.focusManager.registerScope({ id: "config-form" });
    controller.focusManager.setScopeEntries("config-form", [{ id: "save.button", actionId: "form.save" }]);
    controller.focusManager.enterScope("config-form", "save.button");
    controller.formState().beginEdit();
    controller.formState().update("workspace", "/tmp/next");

    const firstSubmit = controller.handleKey("enter");
    const secondSubmit = controller.handleKey("enter");

    await Promise.resolve();
    assert.equal(submitCount, 1);
    assert.equal(controller.formState().isSubmitting(), true);

    resolveSubmit?.({ workspace: "/tmp/next" });
    assert.equal(await firstSubmit, true);
    assert.equal(await secondSubmit, false);
    assert.equal(controller.formState().isSubmitting(), false);
    assert.equal(controller.formState().source().workspace, "/tmp/next");
});

function createController(options: {
    initialValue: { workspace: string };
    onRefresh?: () => Promise<void> | void;
    onSubmit: (draft: { workspace: string }) => Promise<{ workspace: string }> | { workspace: string };
    validate?: (draft: { workspace: string }) => Record<string, string>;
}) {
    return new TuiInteractionController({
        form: new TuiFormState(options.initialValue, {
            onRefresh: options.onRefresh,
            onSubmit: options.onSubmit,
            validate: options.validate
        }),
        modal: new TuiModalState()
    });
}
