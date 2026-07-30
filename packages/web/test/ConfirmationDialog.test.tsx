import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "../src/components/ConfirmationDialog.js";

describe("ConfirmationDialog", () => {
    it("requires an explicit accessible confirmation and disables duplicate submission", () => {
        const cancel = vi.fn();
        const confirm = vi.fn();
        render(<ConfirmationDialog actionLabel="Stop" busy={false} description="Stop demo?" onCancel={cancel} onConfirm={confirm} />);

        expect(screen.getByRole("dialog", { name: "Confirm stop" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(confirm).toHaveBeenCalledOnce();
        expect(cancel).not.toHaveBeenCalled();
    });
});
