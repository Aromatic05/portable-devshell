import { fireEvent, render, screen } from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { describe, expect, it, vi } from "vitest";

import {
    selectWebMessageEntries,
    selectWebMessageSessions,
} from "../src/selectors/messages.js";
import type { WebRoute } from "../src/routing/hashRoute.js";
import type { WebState } from "../src/state/WebState.js";
import { Messages } from "../src/views/Messages.js";

const state: WebState = {
    connection: "online",
    operations: {},
    readModel: {
        ...createInitialControlReadModelState(),
        contexts: [{
            createdAt: "2026-09-01T00:00:00Z",
            ctxId: "ctx-old-active",
            expiresAt: "2026-10-01T00:00:00Z",
            instance: "alpha",
            lastAccessedAt: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
            principal: "client-alpha",
            status: "active",
            workspace: "/work/portable-devshell",
        }],
        instances: [{
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
        }],
        instanceState: {
            alpha: {
                approvals: [],
                commentCalls: [],
                contextMessages: [{
                    createdAt: "2026-09-02T10:00:00Z",
                    ctxId: "ctx-old-active",
                    id: "comment-1",
                    instance: "alpha",
                    status: "delivered",
                    text: "Check the route model.",
                }],
                goals: [],
                logs: [],
                reportCalls: [{
                    callId: "report-1",
                    completedAt: "2026-09-02T10:01:00Z",
                    ctxId: "ctx-old-active",
                    input: { message: "Route model is now green." },
                    instance: asInstanceName("alpha"),
                    source: "mcp",
                    startedAt: "2026-09-02T10:00:30Z",
                    status: "completed",
                    toolName: "todo_report",
                }],
                sequence: 1,
                toolCalls: [],
            },
        },
    },
};

const threadRoute: Extract<WebRoute, { page: "messages" }> = {
    page: "messages",
    view: "thread",
    instance: "alpha",
    ctxId: "ctx-old-active",
};

describe("Messages", () => {
    it("keeps only sessions active within the last 30 minutes", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        expect(selectWebMessageSessions(state, now)).toEqual([
            expect.objectContaining({
                ctxId: "ctx-old-active",
                instance: "alpha",
                status: "active",
                title: "portable-devshell",
            }),
        ]);

        expect(selectWebMessageSessions({
            ...state,
            readModel: {
                ...state.readModel,
                contexts: state.readModel.contexts.map((context) => ({
                    ...context,
                    lastAccessedAt: "2026-09-02T09:20:00Z",
                })),
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        contextMessages: [],
                        reportCalls: [],
                    },
                },
            },
        }, now)).toEqual([]);
    });

    it("projects Comments and completed todo_report calls into one chronological conversation", () => {
        expect(selectWebMessageEntries(state, "alpha", "ctx-old-active")).toEqual([
            expect.objectContaining({ kind: "comment", text: "Check the route model." }),
            expect.objectContaining({ kind: "report", text: "Route model is now green." }),
        ]);
    });

    it("renders a read-only conversation and deep-links to Audit", () => {
        render(<Messages navigate={vi.fn()} route={threadRoute} state={state} />);

        expect(screen.getByRole("log", { name: "Conversation history" })).toHaveTextContent("Check the route model.");
        expect(screen.getByRole("log", { name: "Conversation history" })).toHaveTextContent("Route model is now green.");
        expect(screen.queryByRole("textbox", { name: /Comment/i })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open in Audit" })).toHaveAttribute(
            "href",
            "#/audit/context/alpha/ctx-old-active",
        );
    });

    it("uses the two-line drawer trigger and closes it when a conversation is selected", () => {
        const navigate = vi.fn();
        const view = render(<Messages
            navigate={navigate}
            route={{ page: "messages", view: "contexts" }}
            state={state}
        />);

        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
        expect(view.container.querySelector(".messages-sidebar")).toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: /portable-devshell/ }));
        expect(navigate).toHaveBeenCalledWith(threadRoute);
        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
    });
});
