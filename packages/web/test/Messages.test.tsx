import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    conversationPreferences: {
        orderByWorkspace: {},
        titles: {},
        version: 1,
        workspaceOrder: [],
    },
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

function messageStore(overrides: Record<string, unknown> = {}): WebStore {
    return {
        queueContextMessage: vi.fn(async () => true),
        updateConversationPreferences: vi.fn(async () => true),
        ...overrides,
    } as unknown as WebStore;
}

function twoActiveConversationState(): WebState {
    const firstAt = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
    const secondAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    return {
        ...state,
        readModel: {
            ...state.readModel,
            contexts: [{
                ...state.readModel.contexts[0]!,
                createdAt: firstAt,
                ctxId: "ctx-first",
                lastAccessedAt: firstAt,
            }, {
                ...state.readModel.contexts[0]!,
                createdAt: secondAt,
                ctxId: "ctx-second",
                lastAccessedAt: secondAt,
            }],
            instanceState: {
                ...state.readModel.instanceState,
                alpha: {
                    ...state.readModel.instanceState.alpha!,
                    conversationEntries: [{
                        createdAt: firstAt,
                        ctxId: "ctx-first",
                        id: "first-comment",
                        kind: "comment",
                        status: "delivered",
                        text: "Investigate the first regression in Audit.",
                    }, {
                        createdAt: secondAt,
                        ctxId: "ctx-second",
                        id: "second-comment",
                        kind: "comment",
                        status: "delivered",
                        text: "Review the Messages navigation.",
                    }],
                },
            },
        },
    };
}

describe("Messages", () => {
    afterEach(() => localStorage.clear());

    it("keeps only sessions active within the last 30 minutes", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        expect(selectWebMessageSessions(state, now)).toEqual([
            expect.objectContaining({
                ctxId: "ctx-old-active",
                instance: "alpha",
                status: "active",
                title: "Check the route model.",
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

    it("uses the first Comment as the conversation summary and keeps positions stable as activity changes", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        const multiState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: [{
                    ...state.readModel.contexts[0]!,
                    createdAt: "2026-09-02T09:00:00Z",
                    ctxId: "ctx-first",
                    lastAccessedAt: "2026-09-02T10:04:00Z",
                }, {
                    ...state.readModel.contexts[0]!,
                    createdAt: "2026-09-02T09:30:00Z",
                    ctxId: "ctx-second",
                    lastAccessedAt: "2026-09-02T10:03:00Z",
                }],
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        conversationEntries: [{
                            createdAt: "2026-09-02T09:00:00Z",
                            ctxId: "ctx-first",
                            id: "first-comment",
                            kind: "comment",
                            status: "delivered",
                            text: "Investigate the first regression in Audit.",
                        }, {
                            createdAt: "2026-09-02T10:04:00Z",
                            ctxId: "ctx-first",
                            id: "first-report",
                            kind: "report",
                            text: "A later report must not move this conversation.",
                        }, {
                            createdAt: "2026-09-02T09:30:00Z",
                            ctxId: "ctx-second",
                            id: "second-comment",
                            kind: "comment",
                            status: "delivered",
                            text: "Review the Messages navigation.",
                        }],
                    },
                },
            },
        };

        expect(selectWebMessageSessions(multiState, now).map(({ ctxId, title }) => ({ ctxId, title })))
            .toEqual([
                { ctxId: "ctx-second", title: "Review the Messages navigation." },
                { ctxId: "ctx-first", title: "Investigate the first regression in Audit." },
            ]);
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
            expect(this.download).toBe("Check-the-route-model.-alpha-ctx-old-active.md");
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
                store={messageStore()}
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
            store={messageStore({ queueContextMessage })}
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
        expect(within(composer.closest("form")!).getByRole("status")).toHaveTextContent("Message queued.");
        expect(screen.getByRole("link", { name: "Open in Audit" })).toHaveAttribute(
            "href",
            "#/audit/context/alpha/ctx-old-active",
        );
    });
    it("adds text directives from the composer control menu without structured message metadata", async () => {
        const queueContextMessage = vi.fn(async () => true);
        render(<Messages navigate={vi.fn()} route={threadRoute} state={state} store={messageStore({ queueContextMessage })} />);
        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.click(screen.getByRole("button", { name: "Add message control" }));
        expect(screen.getByRole("menuitem", { name: /^Push/u })).toBeEnabled();
        expect(screen.getByRole("menuitem", { name: /^Stop/u })).toBeEnabled();
        expect(screen.getByRole("menuitem", { name: /^Resume/u })).toBeEnabled();
        fireEvent.click(screen.getByRole("menuitem", { name: /^Push/u }));
        expect(within(composer.closest("form")!).getByText("#push")).toBeVisible();
        fireEvent.change(composer, { target: { value: "Answer before continuing." } });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() => expect(queueContextMessage).toHaveBeenCalledWith("alpha", "ctx-old-active", "#push Answer before continuing."));
    });
    it("can send #stop and #resume as standalone text controls", async () => {
        const queueContextMessage = vi.fn(async () => true);
        render(<Messages navigate={vi.fn()} route={threadRoute} state={state} store={messageStore({ queueContextMessage })} />);
        const form = screen.getByRole("textbox", { name: "Comment" }).closest("form")!;
        fireEvent.click(screen.getByRole("button", { name: "Add message control" }));
        fireEvent.click(screen.getByRole("menuitem", { name: /^Stop/u }));
        fireEvent.submit(form);
        await waitFor(() => expect(queueContextMessage).toHaveBeenLastCalledWith("alpha", "ctx-old-active", "#stop"));
        fireEvent.click(screen.getByRole("button", { name: "Add message control" }));
        fireEvent.click(screen.getByRole("menuitem", { name: /^Resume/u }));
        fireEvent.submit(form);
        await waitFor(() => expect(queueContextMessage).toHaveBeenLastCalledWith("alpha", "ctx-old-active", "#resume"));
    });

    it("shows a send failure next to the composer and preserves the draft", async () => {
        const failedState = { ...state, error: "Control connection was lost." };
        const queueContextMessage = vi.fn(async () => false);
        const store = messageStore({
            get state() { return failedState; },
            queueContextMessage,
        });
        render(<Messages
            navigate={vi.fn()}
            route={threadRoute}
            state={failedState}
            store={store}
        />);

        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.change(composer, { target: { value: "Keep this draft." } });
        fireEvent.submit(composer.closest("form")!);

        const error = await within(composer.closest("form")!).findByRole("alert");
        expect(error).toHaveTextContent("Control connection was lost.");
        expect(composer).toHaveValue("Keep this draft.");
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
                store={messageStore()}
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
                store={messageStore()}
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
            store={messageStore({ queueContextMessage })}
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
            store={messageStore({ queueContextMessage })}
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
            store={messageStore()}
        />);

        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
        expect(view.container.querySelector(".messages-sidebar")).toHaveClass("open");
        fireEvent.click(screen.getByRole("button", { name: /Check the route model/u }));
        expect(navigate).toHaveBeenCalledWith(threadRoute);
        expect(view.container.querySelector(".messages-sidebar")).not.toHaveClass("open");
    });

    it("renames a conversation through server preferences and restores it in a new browser", async () => {
        localStorage.clear();
        const nextState = twoActiveConversationState();
        const updateConversationPreferences = vi.fn(async () => true);
        const first = render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore({ updateConversationPreferences })}
        />);

        fireEvent.click(screen.getByRole("button", { name: "Rename ctx-second" }));
        fireEvent.change(screen.getByLabelText("Conversation title"), { target: { value: "Messages navigation review" } });
        fireEvent.click(screen.getByRole("button", { name: "Save title" }));
        await waitFor(() => expect(updateConversationPreferences).toHaveBeenCalledWith({
            titles: { "alpha\u0000ctx-second": "Messages navigation review" },
        }));

        first.unmount();
        const secondBrowserState: WebState = {
            ...nextState,
            conversationPreferences: {
                ...nextState.conversationPreferences!,
                titles: { "alpha\u0000ctx-second": "Messages navigation review" },
            },
        };
        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={secondBrowserState}
            store={messageStore()}
        />);
        expect(screen.getByRole("button", { name: /Messages navigation review/u })).toBeInTheDocument();
        expect(localStorage.getItem("portable-devshell:web:conversation-preferences:v1")).toBeNull();
    });

    it("persists manual ordering through server preferences instead of browser storage", async () => {
        localStorage.clear();
        const nextState = twoActiveConversationState();
        const updateConversationPreferences = vi.fn(async () => true);
        const first = render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore({ updateConversationPreferences })}
        />);
        const list = screen.getByRole("navigation", { name: "Conversations" });
        const rows = list.querySelectorAll<HTMLElement>(".conversation-row");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("Review the Messages navigation.");
        expect(rows[1]).toHaveTextContent("Investigate the first regression in Audit.");

        fireEvent.dragStart(rows[1]!);
        fireEvent.dragOver(rows[0]!);
        fireEvent.drop(rows[0]!);
        await waitFor(() => expect(updateConversationPreferences).toHaveBeenCalledWith({
            orderByWorkspace: {
                "/work/portable-devshell": ["alpha\u0000ctx-first", "alpha\u0000ctx-second"],
            },
        }));

        first.unmount();
        const secondBrowserState: WebState = {
            ...nextState,
            conversationPreferences: {
                ...nextState.conversationPreferences!,
                orderByWorkspace: {
                    "/work/portable-devshell": ["alpha\u0000ctx-first", "alpha\u0000ctx-second"],
                },
                workspaceOrder: ["/work/portable-devshell"],
            },
        };
        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={secondBrowserState}
            store={messageStore()}
        />);
        expect(screen.getByRole("navigation", { name: "Conversations" })
            .querySelectorAll<HTMLElement>(".conversation-row")[0])
            .toHaveTextContent("Investigate the first regression in Audit.");
        expect(localStorage.getItem("portable-devshell:web:conversation-preferences:v1")).toBeNull();
    });

    it("migrates legacy browser preferences once and deletes them only after server persistence succeeds", async () => {
        const nextState = twoActiveConversationState();
        localStorage.setItem("portable-devshell:web:conversation-preferences:v1", JSON.stringify({
            orderByWorkspace: {
                "/work/portable-devshell": ["alpha\u0000ctx-first", "alpha\u0000ctx-second"],
            },
            titles: { "alpha\u0000ctx-second": "Legacy title" },
            workspaceOrder: ["/work/portable-devshell"],
        }));
        const updateConversationPreferences = vi.fn(async () => true);

        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore({ updateConversationPreferences })}
        />);

        await waitFor(() => expect(updateConversationPreferences).toHaveBeenCalledWith({
            ifMissing: true,
            orderByWorkspace: {
                "/work/portable-devshell": ["alpha\u0000ctx-first", "alpha\u0000ctx-second"],
            },
            titles: { "alpha\u0000ctx-second": "Legacy title" },
            workspaceOrder: ["/work/portable-devshell"],
        }));
        await waitFor(() => expect(localStorage.getItem("portable-devshell:web:conversation-preferences:v1")).toBeNull());
    });

    it("retains legacy browser preferences when server migration fails", async () => {
        const nextState = twoActiveConversationState();
        const legacy = JSON.stringify({
            titles: { "alpha\u0000ctx-second": "Legacy title" },
        });
        localStorage.setItem("portable-devshell:web:conversation-preferences:v1", legacy);
        const updateConversationPreferences = vi.fn(async () => false);

        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore({ updateConversationPreferences })}
        />);

        await waitFor(() => expect(updateConversationPreferences).toHaveBeenCalledWith(expect.objectContaining({
            ifMissing: true,
            titles: { "alpha\u0000ctx-second": "Legacy title" },
        })));
        expect(localStorage.getItem("portable-devshell:web:conversation-preferences:v1")).toBe(legacy);
    });

    it("discovers new server ordering entries without pruning unloaded workspaces or overwriting existing order", async () => {
        const nextState = twoActiveConversationState();
        const serverState: WebState = {
            ...nextState,
            conversationPreferences: {
                orderByWorkspace: {
                    "/work/portable-devshell": ["alpha\u0000ctx-first"],
                    "/work/hidden": ["beta\u0000ctx-hidden"],
                },
                titles: {},
                version: 1,
                workspaceOrder: ["/work/hidden", "/work/portable-devshell"],
            },
        };
        const updateConversationPreferences = vi.fn(async () => true);

        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={serverState}
            store={messageStore({ updateConversationPreferences })}
        />);

        await waitFor(() => expect(updateConversationPreferences).toHaveBeenCalledWith({
            ifMissing: true,
            orderByWorkspace: {
                "/work/portable-devshell": ["alpha\u0000ctx-second", "alpha\u0000ctx-first"],
            },
        }));
        expect(updateConversationPreferences).not.toHaveBeenCalledWith(expect.objectContaining({
            workspaceOrder: ["/work/portable-devshell"],
        }));
    });

    it("offers keyboard and touch-friendly move controls in addition to drag ordering", () => {
        const nextState = twoActiveConversationState();
        render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore()}
        />);

        const list = screen.getByRole("navigation", { name: "Conversations" });
        fireEvent.click(screen.getByRole("button", { name: "Move ctx-first up" }));
        expect(list.querySelectorAll<HTMLElement>(".conversation-row")[0])
            .toHaveTextContent("Investigate the first regression in Audit.");
    });

    it("keeps an idle Current conversation in place until the user archives idle conversations", () => {
        const nextState = twoActiveConversationState();
        const view = render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={nextState}
            store={messageStore()}
        />);
        expect(screen.getByRole("button", { name: /Investigate the first regression/u })).toBeInTheDocument();

        const idleAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
        const idleState: WebState = {
            ...nextState,
            readModel: {
                ...nextState.readModel,
                contexts: nextState.readModel.contexts.map((context) => ({
                    ...context,
                    lastAccessedAt: idleAt,
                })),
                instanceState: {
                    ...nextState.readModel.instanceState,
                    alpha: {
                        ...nextState.readModel.instanceState.alpha!,
                        conversationEntries: nextState.readModel.instanceState.alpha!.conversationEntries.map((entry) => ({
                            ...entry,
                            createdAt: idleAt,
                        })),
                    },
                },
            },
        };
        view.rerender(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={idleState}
            store={messageStore()}
        />);

        expect(screen.getByRole("button", { name: /Investigate the first regression/u })).toHaveTextContent("idle");
        fireEvent.click(screen.getByRole("button", { name: "Archive idle" }));
        expect(screen.queryByRole("button", { name: /Investigate the first regression/u })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "History" }));
        fireEvent.click(screen.getByRole("button", { name: /portable-devshell/u }));
        expect(screen.getByRole("button", { name: /Investigate the first regression/u })).toBeInTheDocument();
    });

    it("closes the message control menu with Escape", () => {
        render(<Messages navigate={vi.fn()} route={threadRoute} state={state} store={messageStore()} />);
        fireEvent.click(screen.getByRole("button", { name: "Add message control" }));
        expect(screen.getByRole("menu", { name: "Message controls" })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("menu", { name: "Message controls" })).not.toBeInTheDocument();
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
            store={messageStore()}
        />);

        const active = screen.getByRole("button", { name: "Current" });
        const history = screen.getByRole("button", { name: "History" });
        expect(active.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(history.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(active).toHaveAttribute("aria-pressed", "true");
        expect(history).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: /Check the route model/u })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Historical conversation/u })).not.toBeInTheDocument();

        fireEvent.click(history);

        expect(active).toHaveAttribute("aria-pressed", "false");
        expect(history).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByRole("button", { name: /Check the route model/u })).not.toBeInTheDocument();
        const groupToggle = screen.getByRole("button", { name: /Other/u });
        fireEvent.click(groupToggle);
        expect(screen.getByRole("button", { name: /Historical conversation/u })).toBeInTheDocument();
    });

    it("groups history conversations by workspace and lets each workspace collapse", () => {
        const groupedState: WebState = {
            ...state,
            readModel: {
                ...state.readModel,
                contexts: [
                    ...state.readModel.contexts,
                    {
                        createdAt: "2026-09-01T08:00:00Z",
                        ctxId: "ctx-project-new",
                        expiresAt: "2026-09-01T09:00:00Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-09-01T08:20:00Z",
                        principal: "client-alpha",
                        status: "expired",
                        workspace: "/work/portable-devshell",
                    },
                    {
                        createdAt: "2026-09-01T07:00:00Z",
                        ctxId: "ctx-project-old",
                        expiresAt: "2026-09-01T08:00:00Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-09-01T07:20:00Z",
                        principal: "client-alpha",
                        status: "expired",
                        workspace: "/work/portable-devshell",
                    },
                    {
                        createdAt: "2026-08-31T08:00:00Z",
                        ctxId: "ctx-efilinux",
                        expiresAt: "2026-08-31T09:00:00Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-08-31T08:20:00Z",
                        principal: "client-alpha",
                        status: "expired",
                        workspace: "/work/efilinux",
                    },
                ],
            },
        };
        const view = render(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={groupedState}
            store={messageStore()}
        />);

        fireEvent.click(screen.getByRole("button", { name: "History" }));

        const conversationList = screen.getByRole("navigation", { name: "Conversations" });
        const groups = within(conversationList).getAllByRole("group");
        expect(groups.map((group) => group.getAttribute("aria-label")))
            .toEqual(["portable-devshell", "efilinux"]);
        const portableToggle = within(groups[0]!).getByRole("button", { name: /portable-devshell/u });
        expect(portableToggle).toHaveAttribute("aria-expanded", "false");
        expect(within(groups[0]!).queryByText("ctx-project-new")).not.toBeInTheDocument();
        fireEvent.click(portableToggle);
        expect(portableToggle).toHaveAttribute("aria-expanded", "true");
        expect(within(groups[0]!).getAllByText(/portable-devshell · ctx-projec/u)).toHaveLength(2);

        view.rerender(<Messages
            navigate={vi.fn()}
            route={{ page: "messages", view: "contexts" }}
            state={{
                ...groupedState,
                readModel: {
                    ...groupedState.readModel,
                    contexts: [{
                        createdAt: "2026-09-02T08:00:00Z",
                        ctxId: "ctx-efilinux-newer",
                        expiresAt: "2026-09-02T09:00:00Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-09-02T08:20:00Z",
                        principal: "client-alpha",
                        status: "expired",
                        workspace: "/work/efilinux",
                    }, ...groupedState.readModel.contexts],
                },
            }}
            store={messageStore()}
        />);
        const stableGroups = within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("group");
        expect(stableGroups.map((group) => group.getAttribute("aria-label")))
            .toEqual(["portable-devshell", "efilinux"]);
    });
});
