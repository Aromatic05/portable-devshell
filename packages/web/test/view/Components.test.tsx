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
        render(
            <ConfirmationDialog
                actionLabel="Delete"
                busy={false}
                description="Delete project?"
                disabled
                onCancel={cancel}
                onConfirm={vi.fn()}
                variant="destructive"
            />,
        );

        const cancelButton = screen.getByRole("button", { name: "Cancel" });
        expect(cancelButton).toHaveFocus();
        expect(cancelButton).toBeEnabled();
        expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
        fireEvent.click(cancelButton);
        expect(cancel).toHaveBeenCalledOnce();
    });
});

it("keeps focus inside the dialog while an operation is busy", () => {
    const view = render(
        <>
            <ConfirmationDialog
                actionLabel="Stop"
                busy={false}
                description="Stop demo?"
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
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
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
                variant="destructive"
            />
            <button>Background action</button>
        </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });

    expect(dialog).toHaveFocus();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
    expect(
        screen.getByRole("button", { name: "Background action" }),
    ).not.toHaveFocus();
});

it("renders a grammatical busy label for Disable", () => {
    render(
        <ConfirmationDialog
            actionLabel="Disable"
            busy
            description="Disable Context?"
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            variant="destructive"
        />,
    );

    expect(screen.getByRole("button", { name: "Disabling…" })).toBeDisabled();
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
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
});
