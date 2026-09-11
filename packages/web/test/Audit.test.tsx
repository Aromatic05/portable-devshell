import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { describe, expect, it, vi } from "vitest";

import type { WebRoute } from "../src/routing/hashRoute.js";
import type { WebState, WebStore } from "../src/state/WebStore.js";
import { Audit } from "../src/views/Audit.js";

const recentContextAccess = new Date(Date.now() - 5 * 60 * 1_000).toISOString();

const alphaCall = {
    callId: "call-alpha",
    completedAt: "2026-07-31T09:00:01Z",
    ctxId: "ctx-alpha",
    explanation: "The previous run returned a non-zero exit code.",
    input: { command: "false" },
    inputSummary: '{"command":"false"}',
    instance: asInstanceName("alpha"),
    output: { exitCode: 1, stderr: "failed", stdout: "" },
    purpose: "Confirm the failing command",
    source: "mcp" as const,
    startedAt: "2026-07-31T09:00:00Z",
    status: "failed" as const,
    toolName: "bash_run",
    workspace: "/projects/alpha",
};

const betaCall = {
    callId: "call-beta",
    completedAt: "2026-07-31T09:10:01Z",
    ctxId: "ctx-beta",
    inputSummary: '{"path":"README.md"}',
    instance: asInstanceName("beta"),
    source: "mcp" as const,
    startedAt: "2026-07-31T09:10:00Z",
    status: "completed" as const,
    toolName: "file_read",
    workspace: "/projects/beta",
};

const state: WebState = {
    connection: "online",
    operations: {},
    readModel: {
        ...createInitialControlReadModelState(),
        contexts: [{
            createdAt: "2026-07-01T00:00:00Z",
            ctxId: "ctx-alpha",
            expiresAt: "2026-12-01T00:00:00Z",
            instance: "alpha",
            lastAccessedAt: recentContextAccess,
            principal: "client-alpha",
            status: "active",
            workspace: "/workspace/alpha",
        }, {
            createdAt: "2026-07-31T08:00:00Z",
            ctxId: "ctx-beta",
            expiresAt: "2026-12-01T00:00:00Z",
            instance: "beta",
            lastAccessedAt: recentContextAccess,
            principal: "client-beta",
            status: "active",
            workspace: "/workspace/beta",
        }],
        instances: [
            {
                mcpEnabled: true,
                name: "alpha",
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("alpha"),
                    ready: true,
                    status: "ready",
                },
            },
            {
                mcpEnabled: true,
                name: "beta",
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("beta"),
                    ready: true,
                    status: "ready",
                },
            },
        ],
        instanceState: {
            alpha: {
                approvals: [],
                commentCalls: [{
                    callId: "call-comment-old",
                    completedAt: "2026-07-30T09:00:01Z",
                    ctxId: "ctx-alpha",
                    input: { command: "pwd" },
                    inputSummary: '{"command":"pwd"}',
                    instance: asInstanceName("alpha"),
                    output: { comment: ["Review the previous failure."], exitCode: 0, stderr: "", stdout: "/workspace\n" },
                    source: "mcp",
                    startedAt: "2026-07-30T09:00:00Z",
                    status: "completed",
                    toolName: "bash_run",
                }],
                contextMessages: [{
                    createdAt: "2026-07-31T09:05:00Z",
                    ctxId: "ctx-alpha",
                    id: "message-1",
                    instance: "alpha",
                    status: "pending",
                    text: "Check the failing command.",
                }],
                goals: [],
                logs: [],
                reportCalls: [],
                sequence: 1,
                toolCalls: [alphaCall],
            },
            beta: {
                approvals: [],
                commentCalls: [],
                contextMessages: [],
                goals: [],
                logs: [],
                reportCalls: [],
                sequence: 1,
                toolCalls: [betaCall],
            },
        },
    },
};

const allRoute: Extract<WebRoute, { page: "audit" }> = {
    page: "audit",
    view: "timeline",
    scope: { kind: "all" },
};
const alphaContextRoute: Extract<WebRoute, { page: "audit" }> = {
    page: "audit",
    view: "timeline",
    scope: { kind: "context", instance: "alpha", ctxId: "ctx-alpha" },
};

function renderAudit({
    route = allRoute,
    state: nextState = state,
    store = {},
    navigate = vi.fn(),
}: {
    route?: Extract<WebRoute, { page: "audit" }>;
    state?: WebState;
    store?: Partial<WebStore>;
    navigate?: ReturnType<typeof vi.fn>;
} = {}) {
    return {
        navigate,
        ...render(<Audit
            navigate={navigate}
            route={route}
            state={nextState}
            store={store as WebStore}
        />),
    };
}

describe("Audit", () => {
    it("uses route Scope as navigation state and defaults Context filtering to active in the last 30 minutes", () => {
        const { navigate } = renderAudit();

        const scope = screen.getByLabelText("Scope");
        expect(within(scope).getByRole("option", { name: /ctx-alpha.*active/u })).toBeInTheDocument();
        expect(scope.querySelector('optgroup[label="Workspace · alpha"]')).not.toBeNull();
        expect(scope.querySelector('optgroup[label="Workspace · beta"]')).not.toBeNull();
        expect(scope.querySelector('optgroup[label="Instances"]')).not.toBeNull();
        expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
        expect(within(screen.getByRole("group", { name: "Active filters" }))
            .getByRole("button", { name: "Context: Active · last 30 min ×" }))
            .toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        expect(screen.getByLabelText("Context status")).toHaveValue("active");
        fireEvent.change(scope, { target: { value: "#/audit/context/alpha/ctx-alpha" } });
        expect(navigate).toHaveBeenCalledWith({
            page: "audit",
            view: "timeline",
            scope: { kind: "context", instance: "alpha", ctxId: "ctx-alpha" },
        });
    });

    it("searches grouped Audit scopes without dropping the current selection", () => {
        renderAudit();

        const scope = screen.getByLabelText("Scope");
        fireEvent.change(screen.getByRole("searchbox", { name: "Search scopes" }), {
            target: { value: "beta" },
        });

        expect(within(scope).getByRole("option", { name: "All instances" })).toBeInTheDocument();
        expect(within(scope).getByRole("option", { name: /ctx-beta/u })).toBeInTheDocument();
        expect(within(scope).queryByRole("option", { name: /ctx-alpha/u })).not.toBeInTheDocument();
    });

    it("clears the visible default Context window like any other filter", () => {
        renderAudit();

        fireEvent.click(within(screen.getByRole("group", { name: "Active filters" }))
            .getByRole("button", { name: "Context: Active · last 30 min ×" }));

        expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Active filters" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Filters" }));
        expect(screen.getByLabelText("Context status")).toHaveValue("all");
    });

    it("filters stale active Contexts and their tool calls outside the 30 minute window", () => {
        const staleState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: state.readModel.contexts.map((context) =>
                    context.ctxId === "ctx-alpha"
                        ? {
                              ...context,
                              lastAccessedAt: new Date(Date.now() - 31 * 60 * 1_000).toISOString(),
                          }
                        : context
                ),
            },
        };
        const view = renderAudit({ state: staleState });

        expect(screen.queryByRole("option", { name: /ctx-alpha/u })).not.toBeInTheDocument();
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(1);
        expect(screen.queryByText("bash_run", { selector: "strong" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        fireEvent.change(screen.getByLabelText("Context status"), { target: { value: "all" } });

        expect(screen.getByRole("option", { name: /ctx-alpha/u })).toBeInTheDocument();
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(2);
    });

    it("separates Search, quick result filters, and collapsed advanced filters", () => {
        const view = renderAudit();

        expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "file_read" } });
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(1);

        fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "" } });
        fireEvent.click(within(screen.getByRole("group", { name: "Result" })).getByRole("button", { name: "Failures" }));
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(1);
        expect(screen.getByText("bash_run", { selector: "strong" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "projects/alpha" } });
        expect(screen.getByRole("group", { name: "Active filters" })).toHaveTextContent("Workspace: projects/alpha");
    });

    it("scopes tool calls without exposing a Comment composer in Audit", () => {
        const view = renderAudit({ route: alphaContextRoute });

        expect(screen.getByRole("heading", { name: "Context controls" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Queue Comment" })).not.toBeInTheDocument();
        expect(screen.queryByText("Check the failing command.")).not.toBeInTheDocument();
        expect(screen.queryByText("Review the previous failure.")).not.toBeInTheDocument();
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(1);
        expect(screen.queryByText("file_read", { selector: "strong" })).not.toBeInTheDocument();
    });

    it("retains Context lifecycle controls with pending renewal and disable confirmation", async () => {
        const disableContext = vi.fn(async () => true);
        const renewContext = vi.fn(async () => true);
        renderAudit({
            route: alphaContextRoute,
            state: { ...state, operations: { "context-renew:ctx-alpha": "pending" } },
            store: { disableContext, renewContext },
        });

        expect(screen.getByRole("button", { name: "Renewing…" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Disable Context" }));
        const dialog = screen.getByRole("dialog", { name: "Confirm disable" });
        expect(within(dialog).getByText(/\/workspace\/alpha/u)).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
        await waitFor(() => expect(disableContext).toHaveBeenCalledWith("ctx-alpha"));
    });

    it("keeps batch Context management separate from Audit scope", async () => {
        const disableContexts = vi.fn(async () => true);
        renderAudit({
            state: {
                ...state,
                readModel: {
                    ...state.readModel,
                    contexts: state.readModel.contexts.map((context) =>
                        context.ctxId === "ctx-alpha"
                            ? {
                                  ...context,
                                  lastAccessedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
                              }
                            : context
                    ),
                },
            },
            store: { disableContexts },
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage Contexts" }));

        const dialog = screen.getByRole("dialog", { name: "Disable inactive Contexts" });
        expect(within(dialog).getByText("ctx-alpha")).toBeInTheDocument();
        fireEvent.change(within(dialog).getByLabelText("Inactive for"), { target: { value: "20" } });
        fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select ctx-alpha" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Review disable" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Disable 1 Context" }));
        await waitFor(() => expect(disableContexts).toHaveBeenCalledWith(["ctx-alpha"]));
    });

    it("opens a call deep link directly instead of requiring a second disclosure action", () => {
        renderAudit({
            route: {
                page: "audit",
                view: "call",
                instance: "alpha",
                ctxId: "ctx-alpha",
                callId: "call-alpha",
            },
        });

        expect(screen.getByText("Confirm the failing command")).toBeInTheDocument();
        expect(screen.getByText("The previous run returned a non-zero exit code.")).toBeInTheDocument();
        expect(screen.queryByText("file_read", { selector: "strong" })).not.toBeInTheDocument();
    });

    it("refreshes the Audit surface without resetting query state", async () => {
        const refreshAudit = vi.fn(async () => undefined);
        renderAudit({ store: { refreshAudit } });
        fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "bash_run" } });
        fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

        await waitFor(() => expect(refreshAudit).toHaveBeenCalledOnce());
        expect(screen.getByLabelText("Search audit")).toHaveValue("bash_run");
    });

    it("loads large Tool Call detail only after disclosure", () => {
        const token = "large-output-token";
        const largeState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        toolCalls: [{ ...alphaCall, callId: "large-call", output: `${token}${"x".repeat(200_000)}` }],
                    },
                },
            },
        };
        renderAudit({ state: largeState });

        expect(screen.queryByText(new RegExp(token))).not.toBeInTheDocument();
        fireEvent.click(screen.getByText("bash_run", { selector: "strong" }));
        expect(screen.getByText(new RegExp(token))).toBeInTheDocument();
    });

    it("paginates matching calls", () => {
        const manyState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        toolCalls: Array.from({ length: 150 }, (_, index) => ({
                            ...alphaCall,
                            callId: `call-${index}`,
                            startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
                        })),
                    },
                    beta: {
                        ...state.readModel.instanceState.beta!,
                        toolCalls: [],
                    },
                },
            },
        };
        const view = renderAudit({ state: manyState });

        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(20);
        const pagination = screen.getByRole("navigation", { name: "Tool calls pagination" });
        expect(pagination).toHaveTextContent("Page 1 of 8");
        fireEvent.click(within(pagination).getByRole("button", { name: "Next page" }));
        expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(20);
        expect(pagination).toHaveTextContent("Page 2 of 8");
    });

    it("keeps one Context addressable on every attached instance", () => {
        const multiState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: state.readModel.contexts.map((context) => context.ctxId === "ctx-alpha"
                    ? {
                        ...context,
                        environments: [
                            { instance: "alpha", workspace: "/workspace/alpha" },
                            { instance: "beta", workspace: "/workspace/remote" },
                        ],
                    }
                    : context),
            },
        };
        renderAudit({ state: multiState });

        const scope = screen.getByLabelText("Scope");
        expect(within(scope).getByRole("option", { name: /ctx-alpha · alpha/u })).toBeInTheDocument();
        expect(within(scope).getByRole("option", { name: /ctx-alpha · beta/u })).toBeInTheDocument();
    });
});
