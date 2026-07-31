import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "../src/components/ConfirmationDialog.js";

describe("ConfirmationDialog", () => {
    it("defaults destructive actions to Cancel and closes with Escape", () => {
        const cancel = vi.fn();
        render(<ConfirmationDialog actionLabel="Stop" busy={false} description="Stop demo?" onCancel={cancel} onConfirm={vi.fn()} />);

        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("traps keyboard focus and allows an explicit confirmation", () => {
        const confirm = vi.fn();
        render(<ConfirmationDialog actionLabel="Deny" busy={false} description="Deny demo?" onCancel={vi.fn()} onConfirm={confirm} />);
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
});
