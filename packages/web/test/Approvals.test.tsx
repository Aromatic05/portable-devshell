import { fireEvent, render, screen, within } from "@testing-library/react";
import { asInstanceName, createInitialControlReadModelState } from "@portable-devshell/shared/browser";
import { expect, it } from "vitest";

import { Approvals } from "../src/views/Approvals.js";
import type { WebStore } from "../src/state/WebStore.js";

it("shows the workspace authority for a pending tool approval", () => {
    const readModel = createInitialControlReadModelState();
    readModel.instances = [{ mcpEnabled: true, name: "alpha" }];
    readModel.instanceState.alpha = {
        approvals: [{
            approvalId: "approval-1",
            callId: "call-1",
            createdAt: "2026-08-12T00:00:00.000Z",
            expiresAt: "2026-08-12T00:10:00.000Z",
            inputSummary: '{"command":"rm -rf build"}',
            instance: asInstanceName("alpha"),
            reason: "needs review",
            riskLevel: "high",
            source: "mcp",
            status: "pending",
            toolName: "bash_run",
            workspace: "/projects/alpha",
        }],
        commentCalls: [],
        contextMessages: [],
        logs: [],
        sequence: 0,
        toolCalls: [],
    };
    const store = {
        state: { connection: "online", operations: {}, readModel },
    } as unknown as WebStore;

    render(<Approvals store={store} />);

    expect(screen.getByText(/Workspace: \/projects\/alpha/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm approve" });
    expect(within(dialog).getByText(/bash_run/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/alpha/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/\/projects\/alpha/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/risk high/u)).toBeInTheDocument();
});

it("summarizes the OAuth client, scopes, resources, and redirects before approval", () => {
    const readModel = createInitialControlReadModelState();
    readModel.oauthApprovals = [{
        approvalId: "oauth-1",
        clientId: "chatgpt-client",
        clientName: "ChatGPT",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-12T00:10:00.000Z",
        kind: "registration",
        redirectUris: ["https://chatgpt.com/callback"],
        requestedResources: ["https://devshell.example/alpha/mcp"],
        requestedScopes: ["mcp"],
        status: "pending",
    }];
    const store = {
        state: { connection: "online", operations: {}, readModel },
    } as unknown as WebStore;

    render(<Approvals store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm approve" });
    expect(within(dialog).getByText(/ChatGPT/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/registration/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/mcp/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/devshell\.example\/alpha\/mcp/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/chatgpt\.com\/callback/u)).toBeInTheDocument();
});
