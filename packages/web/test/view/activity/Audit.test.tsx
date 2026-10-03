import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import {
    asInstanceName,
    type ToolCallRecord,
} from "@portable-devshell/shared";
import { describe, expect, it, vi } from "vitest";

import type { WebRoute } from "../../../src/app/Route.js";
import { WebStore } from "../../../src/state/Store.js";
import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import {
    WebTestDomains,
    withWebDomains,
} from "../../support/DomainHarness.js";

import {
    emptyToolCallFilters,
    filterToolCalls,
    formatToolValue,
    resolveToolCallOutput,
    selectToolCalls,
    toolCallResult,
} from "../../../src/view/page/activity/audit/tool/Model.js";

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

function baseContexts() {
    return [
        {
            createdAt: "2026-07-01T00:00:00Z",
            ctxId: "ctx-alpha",
            environments: [
                { instance: "alpha", workspace: "/workspace/alpha" },
            ],
            expiresAt: "2026-12-01T00:00:00Z",
            lastAccessedAt: recentContextAccess,
            principal: "client-alpha",
            status: "active" as const,
        },
        {
            createdAt: "2026-07-31T08:00:00Z",
            ctxId: "ctx-beta",
            environments: [],
            expiresAt: "2026-12-01T00:00:00Z",
            lastAccessedAt: recentContextAccess,
            principal: "client-beta",
            status: "active" as const,
        },
    ];
}

function readySnapshot(name: string) {
    return {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 1,
        name: asInstanceName(name),
        ready: true,
        status: "ready",
    };
}

function baseInstances() {
    return [
        { mcpEnabled: true, name: "alpha", snapshot: readySnapshot("alpha") },
        { mcpEnabled: true, name: "beta", snapshot: readySnapshot("beta") },
    ];
}

interface RenderAuditOptions {
    approvals?: Record<string, readonly unknown[]>;
    configure?: (store: WebStore, domains: WebTestDomains) => void;
    configureDomains?: (domains: WebTestDomains) => void;
    contexts?: readonly unknown[];
    error?: string;
    instances?: readonly unknown[];
    logs?: Record<string, readonly unknown[]>;
    navigate?: ReturnType<typeof vi.fn>;
    operations?: Record<string, "pending">;
    route?: Extract<WebRoute, { page: "audit" }>;
    toolCalls?: Record<string, readonly unknown[]>;
}

function renderAudit({
    route = allRoute,
    navigate = vi.fn(),
    contexts,
    instances,
    toolCalls,
    approvals,
    logs,
    operations,
    error,
    configure,
    configureDomains,
}: RenderAuditOptions = {}) {
    const domains = new WebTestDomains();
    domains.setContexts(contexts ?? baseContexts());
    domains.setInstances(instances ?? baseInstances());
    const callSets = toolCalls ?? { alpha: [alphaCall], beta: [betaCall] };
    for (const [instance, calls] of Object.entries(callSets))
        domains.setToolCalls(instance, calls);
    for (const [instance, requests] of Object.entries(approvals ?? {}))
        domains.setApprovals(instance, requests);
    for (const [instance, entries] of Object.entries(logs ?? {}))
        domains.setRuntime(instance, { logs: entries });
    configureDomains?.(domains);
    const store = new WebStore(domains.domains);
    if (operations !== undefined || error !== undefined) {
        vi.spyOn(store, "state", "get").mockReturnValue({
            ...(error === undefined ? {} : { error }),
            operations: operations ?? {},
        });
    }
    configure?.(store, domains);
    return {
        domains,
        navigate,
        store,
        ...render(
            withWebDomains(
                domains,
                <Audit navigate={navigate} route={route} store={store} />,
            ),
        ),
    };
}

describe("Audit", () => {
    it("keeps pending approval actions on the matching Tool Call card", async () => {
        const decideTool = vi.fn(async () => true);
        renderAudit({
            approvals: {
                alpha: [
                    {
                        approvalId: "approval-alpha",
                        callId: "call-alpha",
                        createdAt: "2026-07-31T08:59:59Z",
                        expiresAt: "2026-07-31T09:10:00Z",
                        inputSummary: '{"command":"false"}',
                        instance: asInstanceName("alpha"),
                        reason: "needs review",
                        riskLevel: "high",
                        source: "mcp",
                        status: "pending",
                        toolName: "bash_run",
                        workspace: "/projects/alpha",
                    },
                ],
            },
            configure: (store) => {
                vi.spyOn(store, "decideTool").mockImplementation(decideTool);
            },
        });

        fireEvent.click(screen.getByRole("button", { name: "Approve" }));
        const dialog = screen.getByRole("dialog", { name: "Confirm approve" });
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Approve" }),
        );

        await waitFor(() =>
            expect(decideTool).toHaveBeenCalledWith(
                "alpha",
                "approval-alpha",
                "approve",
            ),
        );
    });

    it("uses route Scope as navigation state and defaults Context filtering to active in the last 30 minutes", () => {
        const { navigate } = renderAudit();

        const scope = screen.getByLabelText("Scope");
        expect(
            within(scope).getByRole("option", { name: /ctx-alpha.*active/u }),
        ).toBeInTheDocument();
        expect(
            scope.querySelector('optgroup[label="Workspace · alpha"]'),
        ).not.toBeNull();
        expect(
            scope.querySelector('optgroup[label="Workspace · beta"]'),
        ).not.toBeNull();
        expect(
            scope.querySelector('optgroup[label="Instances"]'),
        ).not.toBeNull();
        expect(
            screen.getByRole("button", { name: "Filters (1)" }),
        ).toBeInTheDocument();
        expect(
            within(
                screen.getByRole("group", { name: "Active filters" }),
            ).getByRole("button", { name: "Context: Active · last 30 min ×" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        expect(screen.getByLabelText("Context status")).toHaveValue("active");
        fireEvent.change(scope, {
            target: { value: "#/audit/context/alpha/ctx-alpha" },
        });
        expect(navigate).toHaveBeenCalledWith({
            page: "audit",
            view: "timeline",
            scope: { kind: "context", instance: "alpha", ctxId: "ctx-alpha" },
        });
    });

    it("searches grouped Audit scopes without dropping the current selection", () => {
        renderAudit();

        const scope = screen.getByLabelText("Scope");
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search scopes" }),
            {
                target: { value: "beta" },
            },
        );

        expect(
            within(scope).getByRole("option", { name: "All instances" }),
        ).toBeInTheDocument();
        expect(
            within(scope).getByRole("option", { name: /ctx-beta/u }),
        ).toBeInTheDocument();
        expect(
            within(scope).queryByRole("option", { name: /ctx-alpha/u }),
        ).not.toBeInTheDocument();
    });

    it("clears the visible default Context window like any other filter", () => {
        renderAudit();

        fireEvent.click(
            within(
                screen.getByRole("group", { name: "Active filters" }),
            ).getByRole("button", { name: "Context: Active · last 30 min ×" }),
        );

        expect(
            screen.getByRole("button", { name: "Filters" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("group", { name: "Active filters" }),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Filters" }));
        expect(screen.getByLabelText("Context status")).toHaveValue("all");
    });

    it("filters stale active Contexts and their tool calls outside the 30 minute window", () => {
        const staleContexts = baseContexts().map((context) =>
            context.ctxId === "ctx-alpha"
                ? {
                      ...context,
                      lastAccessedAt: new Date(
                          Date.now() - 31 * 60 * 1_000,
                      ).toISOString(),
                  }
                : context,
        );
        const view = renderAudit({ contexts: staleContexts });

        expect(
            screen.queryByRole("option", { name: /ctx-alpha/u }),
        ).not.toBeInTheDocument();
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(1);
        expect(
            screen.queryByText("bash_run", { selector: "strong" }),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        fireEvent.change(screen.getByLabelText("Context status"), {
            target: { value: "all" },
        });

        expect(
            screen.getByRole("option", { name: /ctx-alpha/u }),
        ).toBeInTheDocument();
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(2);
    });

    it("ages the default active Context window while the Audit page stays open", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
            const almostStale = new Date(
                Date.now() - 29 * 60 * 1_000 - 50_000,
            ).toISOString();
            const timedContexts = baseContexts().map((context) =>
                context.ctxId === "ctx-alpha"
                    ? { ...context, lastAccessedAt: almostStale }
                    : context,
            );
            renderAudit({ contexts: timedContexts });
            expect(
                screen.getByRole("option", { name: /ctx-alpha.*active/u }),
            ).toBeInTheDocument();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(20_000);
            });

            expect(
                screen.queryByRole("option", { name: /ctx-alpha.*active/u }),
            ).not.toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it("separates Search, quick result filters, and collapsed advanced filters", () => {
        const view = renderAudit();

        expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Search audit"), {
            target: { value: "file_read" },
        });
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(1);

        fireEvent.change(screen.getByLabelText("Search audit"), {
            target: { value: "" },
        });
        fireEvent.click(
            within(screen.getByRole("group", { name: "Result" })).getByRole(
                "button",
                { name: "Failures" },
            ),
        );
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(1);
        expect(
            screen.getByText("bash_run", { selector: "strong" }),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
        fireEvent.change(screen.getByLabelText("Workspace"), {
            target: { value: "projects/alpha" },
        });
        expect(
            screen.getByRole("group", { name: "Active filters" }),
        ).toHaveTextContent("Workspace: projects/alpha");
    });

    it("restores direct Context ID filtering without changing Audit scope or hiding stale Contexts", () => {
        const staleContexts = baseContexts().map((context) =>
            context.ctxId === "ctx-beta"
                ? {
                      ...context,
                      lastAccessedAt: "2026-07-31T09:00:00Z",
                      status: "expired" as const,
                  }
                : context,
        );
        const { navigate, container } = renderAudit({
            contexts: staleContexts,
        });

        expect(
            screen.queryByText("file_read", { selector: "strong" }),
        ).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Context ID"), {
            target: { value: "ctx-beta" },
        });

        expect(container.querySelectorAll(".activity-feed > li")).toHaveLength(
            1,
        );
        expect(
            screen.getByText("file_read", { selector: "strong" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("bash_run", { selector: "strong" }),
        ).not.toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("treats Context ID as an exact identifier rather than a substring search", () => {
        const { container } = renderAudit();

        fireEvent.change(screen.getByLabelText("Context ID"), {
            target: { value: "ctx-" },
        });

        expect(container.querySelectorAll(".activity-feed > li")).toHaveLength(
            0,
        );
        fireEvent.change(screen.getByLabelText("Context ID"), {
            target: { value: "ctx-alpha" },
        });
        expect(container.querySelectorAll(".activity-feed > li")).toHaveLength(
            1,
        );
        expect(
            screen.getByText("bash_run", { selector: "strong" }),
        ).toBeInTheDocument();
    });

    it("scopes tool calls without exposing a Comment composer in Audit", () => {
        const view = renderAudit({ route: alphaContextRoute });

        expect(
            screen.getByRole("heading", { name: "Context controls" }),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Queue Comment" }),
        ).not.toBeInTheDocument();
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(1);
        expect(
            screen.queryByText("file_read", { selector: "strong" }),
        ).not.toBeInTheDocument();
    });

    it("retains Context lifecycle controls with pending renewal and disable confirmation", async () => {
        const disableContext = vi.fn(async () => true);
        const renewContext = vi.fn(async () => true);
        renderAudit({
            operations: { "context-renew:ctx-alpha": "pending" },
            route: alphaContextRoute,
            configure: (store) => {
                vi.spyOn(store, "disableContext").mockImplementation(
                    disableContext,
                );
                vi.spyOn(store, "renewContext").mockImplementation(
                    renewContext,
                );
            },
        });

        expect(
            screen.getByRole("button", { name: "Renewing…" }),
        ).toBeDisabled();
        fireEvent.click(
            screen.getByRole("button", { name: "Disable Context" }),
        );
        const dialog = screen.getByRole("dialog", { name: "Confirm disable" });
        expect(
            within(dialog).getByText(/\/workspace\/alpha/u),
        ).toBeInTheDocument();
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Disable" }),
        );
        await waitFor(() =>
            expect(disableContext).toHaveBeenCalledWith("ctx-alpha"),
        );
    });

    it("keeps Context disable confirmation open and reports a failed operation in place", async () => {
        renderAudit({
            error: "Context disable failed.",
            route: alphaContextRoute,
            configure: (store) => {
                vi.spyOn(store, "disableContext").mockResolvedValue(false);
                vi.spyOn(store, "renewContext").mockResolvedValue(true);
            },
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Disable Context" }),
        );
        fireEvent.click(
            within(
                screen.getByRole("dialog", { name: "Confirm disable" }),
            ).getByRole("button", { name: "Disable" }),
        );

        const dialog = await screen.findByRole("dialog", {
            name: "Confirm disable",
        });
        expect(within(dialog).getByRole("alert")).toHaveTextContent(
            "Context disable failed.",
        );
    });

    it("shows Tool Call detail loading failures inside the expanded record", async () => {
        renderAudit({
            configure: (store) => {
                vi.spyOn(store, "readToolCallDetail").mockRejectedValue(
                    new Error("Tool Call detail unavailable."),
                );
                vi.spyOn(store, "refreshToolCall").mockResolvedValue(undefined);
            },
        });

        fireEvent.click(
            screen
                .getByText("file_read", { selector: "strong" })
                .closest("summary")!,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Tool Call detail unavailable.",
        );
    });

    it("renders persisted artifact_viewImage content from its Audit imageRef", async () => {
        const png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        const blake3 = "b".repeat(64);
        const readArtifactImage = vi.fn(async () => ({
            blake3,
            bytes: 68,
            content: png,
            encoding: "base64" as const,
            imageRef: `${blake3}.png`,
            mediaType: "image/png" as const,
        }));
        renderAudit({
            configureDomains: (domains) => {
                domains.artifactTransport.readImage = readArtifactImage;
            },
            route: alphaContextRoute,
            toolCalls: {
                alpha: [
                    {
                        callId: "call-image",
                        completedAt: "2026-07-31T09:20:01Z",
                        ctxId: "ctx-alpha",
                        input: { path: "./preview.png" },
                        inputSummary: '{"path":"./preview.png"}',
                        instance: asInstanceName("alpha"),
                        output: {
                            blake3,
                            bytes: 68,
                            imageRef: `${blake3}.png`,
                            mediaType: "image/png",
                            name: "preview.png",
                            source: {
                                instance: "alpha",
                                path: "./preview.png",
                                type: "file",
                                workspace: "/projects/alpha",
                            },
                        },
                        source: "mcp",
                        startedAt: "2026-07-31T09:20:00Z",
                        status: "completed",
                        toolName: "artifact_viewImage",
                        workspace: "/projects/alpha",
                    },
                ],
            },
        });

        fireEvent.click(
            screen
                .getByText("artifact_viewImage", { selector: "strong" })
                .closest("summary")!,
        );

        const image = await screen.findByRole("img", { name: "preview.png" });
        expect(readArtifactImage).toHaveBeenCalledWith(`${blake3}.png`);
        expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`);
    });

    it("keeps batch Context management separate from Audit scope", async () => {
        const disableContexts = vi.fn(async () => true);
        const contexts = baseContexts().map((context) => ({
            ...context,
            ...(context.ctxId === "ctx-alpha"
                ? {
                      environments: [
                          {
                              instance: "alpha",
                              workspace: "/workspace/alpha",
                          },
                          {
                              instance: "beta",
                              workspace: "/workspace/beta",
                          },
                      ],
                  }
                : {}),
            lastAccessedAt: new Date(
                Date.now() - 2 * 60 * 60 * 1_000,
            ).toISOString(),
        }));
        renderAudit({
            contexts,
            configure: (store) => {
                vi.spyOn(store, "disableContexts").mockImplementation(
                    disableContexts,
                );
            },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Disable inactive Contexts…" }),
        );

        const dialog = screen.getByRole("dialog", {
            name: "Disable inactive Contexts",
        });
        expect(within(dialog).getByText("ctx-alpha")).toBeInTheDocument();
        expect(
            within(dialog).getByRole("row", { name: /ctx-alpha/u }),
        ).toHaveTextContent("alpha, beta");
        expect(
            within(dialog).getByText("No attached environments"),
        ).toBeInTheDocument();
        fireEvent.change(within(dialog).getByLabelText("Inactive for"), {
            target: { value: "20" },
        });
        fireEvent.click(
            within(dialog).getByRole("checkbox", { name: "Select ctx-alpha" }),
        );
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Review disable" }),
        );
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Disable 1 Context" }),
        );
        await waitFor(() =>
            expect(disableContexts).toHaveBeenCalledWith(["ctx-alpha"]),
        );
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

        expect(
            screen.getByText("Confirm the failing command"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("The previous run returned a non-zero exit code."),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("file_read", { selector: "strong" }),
        ).not.toBeInTheDocument();
    });

    it("refreshes the Audit surface without resetting query state", async () => {
        const refreshAudit = vi.fn(async () => undefined);
        renderAudit({
            configure: (store) => {
                vi.spyOn(store, "refreshAudit").mockImplementation(refreshAudit);
            },
        });
        fireEvent.change(screen.getByLabelText("Search audit"), {
            target: { value: "bash_run" },
        });
        refreshAudit.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

        await waitFor(() => expect(refreshAudit).toHaveBeenCalledOnce());
        expect(screen.getByLabelText("Search audit")).toHaveValue("bash_run");
    });

    it("loads large Tool Call detail only after disclosure", () => {
        const token = "large-output-token";
        renderAudit({
            toolCalls: {
                alpha: [
                    {
                        ...alphaCall,
                        callId: "large-call",
                        output: `${token}${"x".repeat(200_000)}`,
                    },
                ],
                beta: [],
            },
        });

        expect(screen.queryByText(new RegExp(token))).not.toBeInTheDocument();
        fireEvent.click(screen.getByText("bash_run", { selector: "strong" }));
        expect(screen.getByText(new RegExp(token))).toBeInTheDocument();
    });

    it("paginates matching calls", () => {
        const view = renderAudit({
            toolCalls: {
                alpha: Array.from({ length: 150 }, (_, index) => ({
                    ...alphaCall,
                    callId: `call-${index}`,
                    startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
                })),
                beta: [],
            },
        });

        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(20);
        const pagination = screen.getByRole("navigation", {
            name: "Tool calls pagination",
        });
        expect(pagination).toHaveTextContent("Page 1 of 8");
        fireEvent.click(
            within(pagination).getByRole("button", { name: "Next page" }),
        );
        expect(
            view.container.querySelectorAll(".activity-feed > li"),
        ).toHaveLength(20);
        expect(pagination).toHaveTextContent("Page 2 of 8");
    });

    it("keeps one Context addressable on every attached instance", () => {
        const contexts = baseContexts().map((context) =>
            context.ctxId === "ctx-alpha"
                ? {
                      ...context,
                      environments: [
                          {
                              instance: "alpha",
                              workspace: "/workspace/alpha",
                          },
                          {
                              instance: "beta",
                              workspace: "/workspace/remote",
                          },
                      ],
                  }
                : context,
        );
        renderAudit({ contexts });

        const scope = screen.getByLabelText("Scope");
        expect(
            within(scope).getByRole("option", { name: /ctx-alpha · alpha/u }),
        ).toBeInTheDocument();
        expect(
            within(scope).getByRole("option", { name: /ctx-alpha · beta/u }),
        ).toBeInTheDocument();
    });

    it("uses the selected instance environment for Context controls", () => {
        const contexts = baseContexts().map((context) =>
            context.ctxId === "ctx-alpha"
                ? {
                      ...context,
                      environments: [
                          {
                              instance: "alpha",
                              workspace: "/workspace/alpha",
                          },
                          {
                              instance: "beta",
                              workspace: "/workspace/beta",
                          },
                      ],
                  }
                : context,
        );
        renderAudit({
            contexts,
            route: {
                page: "audit",
                view: "timeline",
                scope: {
                    kind: "context",
                    instance: "beta",
                    ctxId: "ctx-alpha",
                },
            },
        });

        const controls = screen.getByRole("region", {
            name: "Context controls",
        });
        expect(controls).toHaveTextContent("/workspace/beta");
        expect(controls).not.toHaveTextContent("/workspace/alpha");
    });
});

const calls: ToolCallRecord[] = [
    {
        callId: "call-old",
        completedAt: "2026-07-31T08:30:01Z",
        ctxId: "ctx-alpha",
        inputSummary: '{"path":"README.md"}',
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-07-31T08:30:00Z",
        status: "completed",
        toolName: "file_read",
        workspace: "/projects/docs",
    },
    {
        callId: "call-failed",
        completedAt: "2026-07-31T09:30:01Z",
        ctxId: "ctx-alpha",
        error: "command failed",
        inputSummary: '{"command":"false"}',
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-07-31T09:30:00Z",
        status: "failed",
        toolName: "bash_run",
        workspace: "/projects/alpha",
    },
    {
        callId: "call-queued",
        inputSummary: "{}",
        instance: asInstanceName("beta"),
        source: "tui",
        startedAt: "2026-07-31T09:45:00Z",
        status: "queued",
        toolName: "artifact_transfer",
        workspace: "/projects/beta",
    },
];

describe("tool call audit query", () => {
    it("applies text, workspace, result, tool, and time filters together", () => {
        expect(
            filterToolCalls(
                calls,
                {
                    ctxId: "ctx-alpha",
                    period: "1h",
                    query: "command failed",
                    result: "failure",
                    tool: "bash_run",
                    workspace: "projects/alpha",
                },
                Date.parse("2026-07-31T10:00:00Z"),
            ),
        ).toEqual([calls[1]]);
    });

    it("filters tool calls directly by Context ID", () => {
        expect(
            filterToolCalls(calls, {
                ...emptyToolCallFilters,
                ctxId: "ctx-alpha",
            }),
        ).toEqual([calls[1], calls[0]]);
        expect(
            filterToolCalls(calls, {
                ...emptyToolCallFilters,
                ctxId: "ctx-missing",
            }),
        ).toEqual([]);
    });

    it("formats complete structured input and restores output from linked logs", () => {
        expect(
            formatToolValue({
                command: "printf ok",
                options: { timeoutMs: 1000 },
            }),
        ).toBe("\n  command: printf ok\n  options:\n    timeoutMs: 1000");
        expect(
            resolveToolCallOutput(calls[0]!, [
                {
                    at: "2026-07-31T08:30:01Z",
                    callId: "call-old",
                    instanceName: "alpha",
                    message: "hello",
                    seq: 1,
                    stream: "stdout",
                },
            ]),
        ).toEqual({ stdout: "hello" });
    });

    it("classifies tool call statuses for quick result filters", () => {
        expect(toolCallResult(calls[0]!)).toBe("success");
        expect(toolCallResult(calls[1]!)).toBe("failure");
        expect(toolCallResult(calls[2]!)).toBe("pending");
    });
});

describe("bounded Tool Call presentation", () => {
    it("searches actual structured input and output", () => {
        const call = {
            ...calls[0]!,
            callId: "structured-search",
            input: { command: "unique-input-token" },
            output: { stdout: "unique-output-token" },
        };
        expect(
            filterToolCalls([call], {
                ...emptyToolCallFilters,
                query: "unique-input-token",
            }),
        ).toEqual([call]);
        expect(
            filterToolCalls([call], {
                ...emptyToolCallFilters,
                query: "unique-output-token",
            }),
        ).toEqual([call]);
    });

    it("bounds deeply nested and oversized values", () => {
        let nested: unknown = "leaf";
        for (let index = 0; index < 15_000; index += 1) nested = { nested };
        const deep = formatToolValue(nested as never);
        const large = formatToolValue("x".repeat(2_000_000));

        expect(deep).toContain("truncated");
        expect(large.length).toBeLessThanOrEqual(210_000);
        expect(large).toContain("truncated");
    });
});

it("uses a global traversal budget for wide nested values", () => {
    let reads = 0;
    const inner = new Proxy(new Array(1_000).fill("value"), {
        get(target, property, receiver) {
            if (typeof property === "string" && /^\d+$/u.test(property))
                reads += 1;
            return Reflect.get(target, property, receiver);
        },
    });
    const root = new Array(1_000).fill(inner);

    const formatted = formatToolValue(root as never);

    expect(formatted).toContain("truncated");
    expect(reads).toBeLessThan(2_000);
});

it("reports the full match count separately from the display limit", () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
        ...calls[0]!,
        callId: `call-${index}`,
        startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const { items, total } = selectToolCalls(many, emptyToolCallFilters);

    expect(items).toHaveLength(100);
    expect(total).toBe(150);
});

it("returns the requested page of matching calls", () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
        ...calls[0]!,
        callId: `call-${index}`,
        startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const { items, total } = selectToolCalls(
        many,
        emptyToolCallFilters,
        Date.now(),
        100,
    );

    expect(items).toHaveLength(50);
    expect(total).toBe(150);
});
