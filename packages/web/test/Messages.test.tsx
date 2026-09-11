import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import type { WebStore } from "../src/state/WebStore.js";
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
                conversationEntries: [
                    {
                        createdAt: "2026-09-02T10:00:00Z",
                        ctxId: "ctx-old-active",
                        id: "comment-1",
                        kind: "comment",
                        status: "delivered",
                        text: "Check the route model.",
                    },
                    {
                        callId: "report-1",
                        createdAt: "2026-09-02T10:01:00Z",
                        ctxId: "ctx-old-active",
                        id: "report-1",
                        kind: "report",
                        text: "Route model is now green.",
                    },
                ],
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
                        conversationEntries: [],
                        contextMessages: [],
                        reportCalls: [],
                    },
                },
            },
        }, now)).toEqual([]);
    });

    it("projects canonical Conversation entries into one chronological conversation", () => {
        expect(selectWebMessageEntries(state, "alpha", "ctx-old-active")).toEqual([
            expect.objectContaining({ kind: "comment", text: "Check the route model." }),
            expect.objectContaining({ kind: "report", text: "Route model is now green." }),
        ]);
    });

    it("renders conversation history, a floating Comment composer, and deep-links to Audit", async () => {
        const queueContextMessage = vi.fn(async () => true);
        render(<Messages
            navigate={vi.fn()}
            route={threadRoute}
            state={state}
            store={{ queueContextMessage } as WebStore}
        />);

        expect(screen.getByRole("log", { name: "Conversation history" })).toHaveTextContent("Check the route model.");
        expect(screen.getByRole("log", { name: "Conversation history" })).toHaveTextContent("Route model is now green.");
        const composer = screen.getByRole("textbox", { name: "Comment" });
        expect(composer.closest("form")).toHaveClass("messages-composer");
        fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
        expect(document.querySelector(".messages-sidebar")).toHaveClass("open");
        fireEvent.focus(composer);
        expect(document.querySelector(".messages-sidebar")).not.toHaveClass("open");
        fireEvent.change(composer, { target: { value: "Continue from Messages." } });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() => expect(queueContextMessage).toHaveBeenCalledWith(
            "alpha",
            "ctx-old-active",
            "Continue from Messages.",
        ));
        expect(screen.getByRole("link", { name: "Open in Audit" })).toHaveAttribute(
            "href",
            "#/audit/context/alpha/ctx-old-active",
        );
    });

    it("scrolls to the newest message whenever a conversation is entered or switched", async () => {
        const scrollIntoView = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        try {
            const view = render(<Messages
                navigate={vi.fn()}
                route={threadRoute}
                state={state}
                store={{ queueContextMessage: vi.fn(async () => true) } as WebStore}
            />);
            await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
            const initialCalls = scrollIntoView.mock.calls.length;

            view.rerender(<Messages
                navigate={vi.fn()}
                route={{
                    page: "messages",
                    view: "thread",
                    instance: "alpha",
                    ctxId: "ctx-second",
                }}
                state={state}
                store={{ queueContextMessage: vi.fn(async () => true) } as WebStore}
            />);
            await waitFor(() => expect(scrollIntoView.mock.calls.length).toBeGreaterThan(initialCalls));
        } finally {
            if (original === undefined) {
                Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            } else {
                Object.defineProperty(Element.prototype, "scrollIntoView", {
                    configurable: true,
                    value: original,
                });
            }
        }
    });

    it("keeps the floating composer writable when the Context registry record is absent", async () => {
        const queueContextMessage = vi.fn(async () => true);
        const historyOnlyState: WebState = {
            ...state,
            readModel: { ...state.readModel, contexts: [] },
        };
        render(<Messages
            navigate={vi.fn()}
            route={threadRoute}
            state={historyOnlyState}
            store={{ queueContextMessage } as WebStore}
        />);

        const composer = screen.getByRole("textbox", { name: "Comment" });
        expect(composer).not.toBeDisabled();
        fireEvent.change(composer, { target: { value: "Still writable." } });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() => expect(queueContextMessage).toHaveBeenCalledWith(
            "alpha",
            "ctx-old-active",
            "Still writable.",
        ));
    });

    it("keeps the floating composer writable for a disabled Context", async () => {
        const queueContextMessage = vi.fn(async () => true);
        const disabledState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: state.readModel.contexts.map((context) => ({
                    ...context,
                    status: "disabled" as const,
                })),
            },
        };
        render(<Messages
            navigate={vi.fn()}
            route={threadRoute}
            state={disabledState}
            store={{ queueContextMessage } as WebStore}
        />);

        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.change(composer, { target: { value: "Message after disable." } });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() => expect(queueContextMessage).toHaveBeenCalledWith(
            "alpha",
            "ctx-old-active",
            "Message after disable.",
        ));
    });

    it("uses the two-line drawer trigger and closes it when a conversation is selected", () => {
        const navigate = vi.fn();
        const view = render(<Messages
            navigate={navigate}
            route={{ page: "messages", view: "contexts" }}
            state={state}
            store={{ queueContextMessage: vi.fn(async () => true) } as WebStore}
        />);

        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
        expect(view.container.querySelector(".messages-sidebar")).toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: /portable-devshell/ }));
        expect(navigate).toHaveBeenCalledWith(threadRoute);
        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
    });
});
