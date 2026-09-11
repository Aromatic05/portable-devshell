import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { describe, expect, it, vi } from "vitest";

import {
    selectWebMessageEntries,
    selectWebMessageHistorySessions,
    selectWebMessageSessions,
} from "../src/selectors/messages.js";
import type { WebRoute } from "../src/routing/hashRoute.js";
import type { WebState } from "../src/state/WebState.js";
import type { WebStore } from "../src/state/WebStore.js";
import { buildConversationMarkdown, Messages } from "../src/views/Messages.js";

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

    it("partitions loaded conversations into active and history sessions", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        const mixedState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: state.readModel.contexts.map((context) => ({
                    ...context,
                    lastAccessedAt: "2026-09-02T10:00:00Z",
                })),
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        conversationEntries: [
                            ...state.readModel.instanceState.alpha!.conversationEntries,
                            {
                                createdAt: "2026-09-02T09:00:00Z",
                                ctxId: "ctx-history",
                                id: "comment-history",
                                kind: "comment",
                                status: "delivered",
                                text: "Older conversation.",
                            },
                        ],
                    },
                },
            },
        };

        expect(selectWebMessageSessions(mixedState, now).map((session) => session.ctxId))
            .toEqual(["ctx-old-active"]);
        expect(selectWebMessageHistorySessions(mixedState, now).map((session) => session.ctxId))
            .toEqual(["ctx-history"]);
    });

    it("projects canonical Conversation entries into one chronological conversation", () => {
        expect(selectWebMessageEntries(state, "alpha", "ctx-old-active")).toEqual([
            expect.objectContaining({ kind: "comment", text: "Check the route model." }),
            expect.objectContaining({ kind: "report", text: "Route model is now green." }),
        ]);
    });

    it("exports the current conversation as readable Markdown", () => {
        expect(buildConversationMarkdown({
            ctxId: "ctx-old-active",
            entries: selectWebMessageEntries(state, "alpha", "ctx-old-active"),
            instance: "alpha",
            title: "portable-devshell",
        })).toBe([
            "# portable-devshell",
            "",
            "- Instance: `alpha`",
            "- Context: `ctx-old-active`",
            "",
            "## You",
            "",
            "_2026-09-02T10:00:00Z_",
            "",
            "Check the route model.",
            "",
            "## Agent",
            "",
            "_2026-09-02T10:01:00Z_",
            "",
            "Route model is now green.",
            "",
        ].join("\n"));
    });

    it("downloads the current conversation from the composer", () => {
        const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
        const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
        const createObjectURL = vi.fn(() => "blob:conversation");
        const revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
            expect(this.download).toBe("portable-devshell-alpha-ctx-old-active.md");
            expect(this.href).toBe("blob:conversation");
        });
        Object.defineProperty(URL, "createObjectURL", {
            configurable: true,
            value: createObjectURL,
        });
        Object.defineProperty(URL, "revokeObjectURL", {
            configurable: true,
            value: revokeObjectURL,
        });

        try {
            render(<Messages
                navigate={vi.fn()}
                route={threadRoute}
                state={state}
                store={{ queueContextMessage: vi.fn(async () => true) } as WebStore}
            />);

            fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));

            expect(createObjectURL).toHaveBeenCalledTimes(1);
            expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
            expect(revokeObjectURL).toHaveBeenCalledWith("blob:conversation");
            expect(click).toHaveBeenCalledTimes(1);
        } finally {
            click.mockRestore();
            if (createObjectURLDescriptor === undefined) {
                Reflect.deleteProperty(URL, "createObjectURL");
            } else {
                Object.defineProperty(URL, "createObjectURL", createObjectURLDescriptor);
            }
            if (revokeObjectURLDescriptor === undefined) {
                Reflect.deleteProperty(URL, "revokeObjectURL");
            } else {
                Object.defineProperty(URL, "revokeObjectURL", revokeObjectURLDescriptor);
            }
        }
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
        expect(screen.getByRole("button", { name: "Export Markdown" })).toBeEnabled();
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

    it("switches the sidebar between active and history conversations", () => {
        const historyState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        conversationEntries: [
                            ...state.readModel.instanceState.alpha!.conversationEntries,
                            {
                                createdAt: "2026-09-01T08:00:00Z",
                                ctxId: "ctx-history",
                                id: "comment-history",
                                kind: "comment",
                                status: "delivered",
                                text: "Historical conversation.",
                            },
                        ],
                    },
                },
            },
        };
        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={historyState}
            store={{ queueContextMessage: vi.fn(async () => true) } as WebStore}
        />);

        const active = screen.getByRole("button", { name: "Active" });
        const history = screen.getByRole("button", { name: "History" });
        expect(active.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(history.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(active).toHaveAttribute("aria-pressed", "true");
        expect(history).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: /portable-devshell/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /ctx-history/ })).not.toBeInTheDocument();

        fireEvent.click(history);

        expect(active).toHaveAttribute("aria-pressed", "false");
        expect(history).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByRole("button", { name: /portable-devshell/ })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /ctx-history/ })).toBeInTheDocument();
    });
});
