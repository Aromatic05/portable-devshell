import { fireEvent, render, screen } from "@testing-library/react";
import { asInstanceName } from "@portable-devshell/shared/browser";
import { expect, it } from "vitest";

import { Activity } from "../src/views/Activity.js";
import type { WebState } from "../src/state/WebStore.js";

const state: WebState = {
    activity: [
        { at: "2026-07-31T09:00:00Z", instanceName: asInstanceName("alpha"), seq: 1, type: "toolCall.completed" },
        { at: "2026-07-31T09:10:00Z", instanceName: asInstanceName("beta"), seq: 2, type: "toolCall.failed" },
    ], approvals: {}, connection: "online", instances: [], logs: {}, oauthApprovals: [], operations: {}, partialFailures: {}, todos: {},
};

it("clears interactive filters back to the full diagnostic activity feed", () => {
    render(<Activity state={state} />);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "beta" } });
    expect(screen.getByText("1 of 2 activity records match active filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("2 of 2 activity records.")).toBeInTheDocument();
});
