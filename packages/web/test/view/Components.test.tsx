import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "../../src/view/component/Confirm.js";

describe("ConfirmationDialog", () => {
    it("defaults explicitly destructive actions to Cancel and closes with Escape", () => {
        const cancel = vi.fn();
        render(
            <ConfirmationDialog
                actionLabel="Revoke"
                busy={false}
                description="Revoke demo?"
                onCancel={cancel}
                onConfirm={vi.fn()}
                variant="destructive"
            />,
        );

        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("traps keyboard focus and allows an explicit confirmation", () => {
        const confirm = vi.fn();
        render(
            <ConfirmationDialog
                actionLabel="Deny"
                busy={false}
                description="Deny demo?"
                onCancel={vi.fn()}
                onConfirm={confirm}
                variant="destructive"
            />,
        );
        const dialog = screen.getByRole("dialog", { name: "Confirm deny" });
        const cancel = screen.getByRole("button", { name: "Cancel" });
        const deny = screen.getByRole("button", { name: "Deny" });

        cancel.focus();
        fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
        expect(deny).toHaveFocus();
        fireEvent.keyDown(dialog, { key: "Tab" });
        expect(cancel).toHaveFocus();
        fireEvent.click(deny);
        expect(confirm).toHaveBeenCalledOnce();
    });

    it("treats permanent deletion as destructive and keeps Cancel available when confirmation is disabled", () => {
        const cancel = vi.fn();
        const confirm = vi.fn();
        render(
            <ConfirmationDialog
                actionLabel="Delete"
                busy={false}
                description="Delete project?"
                disabled
                onCancel={cancel}
                onConfirm={confirm}
                variant="destructive"
            />,
        );

        const cancelButton = screen.getByRole("button", { name: "Cancel" });
        const deleteButton = screen.getByRole("button", { name: "Delete" });
        expect(cancelButton).toHaveFocus();
        expect(cancelButton).toBeEnabled();
        expect(deleteButton).toHaveAttribute("aria-disabled", "true");
        expect(deleteButton).toBeEnabled();
        fireEvent.click(deleteButton);
        expect(confirm).not.toHaveBeenCalled();
        fireEvent.click(cancelButton);
        expect(cancel).toHaveBeenCalledOnce();
    });
});

it("keeps both controls focusable while busy and blocks Escape and activation", () => {
    const cancel = vi.fn();
    const confirm = vi.fn();
    const view = render(
        <>
            <ConfirmationDialog
                actionLabel="Stop"
                busy={false}
                description="Stop demo?"
                onCancel={cancel}
                onConfirm={confirm}
                variant="destructive"
            />
            <button>Background action</button>
        </>,
    );
    view.rerender(
        <>
            <ConfirmationDialog
                actionLabel="Stop"
                busy
                description="Stop demo?"
                onCancel={cancel}
                onConfirm={confirm}
                variant="destructive"
            />
            <button>Background action</button>
        </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const confirmButton = screen.getByRole("button", { name: "Stopping…" });

    expect(cancelButton).toHaveFocus();
    expect(cancelButton).toHaveAttribute("aria-disabled", "true");
    expect(cancelButton).toBeEnabled();
    expect(confirmButton).toHaveAttribute("aria-disabled", "true");
    expect(confirmButton).toHaveAttribute("aria-busy", "true");
    expect(confirmButton).toBeEnabled();

    confirmButton.focus();
    expect(confirmButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(cancelButton);
    fireEvent.click(confirmButton);
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
});

it.each([
    ["Stop", "Stopping…"],
    ["Delete", "Deleting…"],
    ["Disable", "Disabling…"],
    ["Enable", "Enabling…"],
    ["Restart", "Restarting…"],
    ["Revoke", "Revoking…"],
    ["Rotate", "Rotating…"],
    ["Approve", "Approving…"],
    ["Deny", "Denying…"],
])("renders the mapped busy label for %s", (actionLabel, busyLabel) => {
    render(
        <ConfirmationDialog
            actionLabel={actionLabel}
            busy
            description={`${actionLabel} demo?`}
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            variant="destructive"
        />,
    );

    const action = screen.getByRole("button", { name: busyLabel });
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAttribute("aria-busy", "true");
});

it("falls back to the action label for unknown actions", () => {
    render(
        <ConfirmationDialog
            actionLabel="Cancel transfer"
            busy
            description="Cancel transfer?"
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            variant="destructive"
        />,
    );

    expect(
        screen.getByRole("button", { name: "Cancel transfer…" }),
    ).toBeInTheDocument();
});

it("uses an explicit busy label for multi-word actions", () => {
    render(
        <ConfirmationDialog
            actionLabel="Cancel transfer"
            busy
            busyLabel="Cancelling transfer…"
            description="Cancel transfer?"
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            variant="destructive"
        />,
    );

    const action = screen.getByRole("button", {
        name: "Cancelling transfer…",
    });
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAttribute("aria-busy", "true");
});
