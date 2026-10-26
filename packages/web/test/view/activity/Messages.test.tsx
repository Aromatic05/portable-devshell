import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { asInstanceName } from "@portable-devshell/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    selectWebMessageEntries,
    selectWebMessageHistorySessions,
    selectWebMessageSessions,
} from "../../../src/view/page/activity/messages/Model.js";
import type { WebRoute } from "../../../src/app/Route.js";
import type { WebState } from "../../../src/state/Model.js";
import { WebStore } from "../../../src/state/Store.js";
import { buildMessageMarkdown } from "../../../src/view/page/activity/messages/Export.js";
import { formatMessageDate } from "../../../src/view/page/activity/messages/message/History.js";
import { Messages } from "../../../src/view/page/activity/messages/Page.js";

import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";

import { deferred } from "../../support/BetaMatrixHarness.js";

const activeLastAccessedAt = new Date(
    Date.now() - 5 * 60 * 1_000,
).toISOString();

const baseInstances = [
    {
        enabled: true,
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
];

const baseMessageEntries = [
    {
        createdAt: "2026-09-02T10:00:00Z",
        ctxId: "ctx-old-active",
        id: "comment-1",
        kind: "comment" as const,
        status: "delivered" as const,
        text: "Check the route model.",
    },
    {
        callId: "report-1",
        createdAt: "2026-09-02T10:01:00Z",
        ctxId: "ctx-old-active",
        id: "report-1",
        kind: "report" as const,
        text: "Route model is now green.",
    },
];

const baseMessages = [
    {
        createdAt: "2026-09-02T10:00:00Z",
        ctxId: "ctx-old-active",
        id: "comment-1",
        instance: "alpha",
        status: "delivered" as const,
        text: "Check the route model.",
    },
];

/** Local WebStore state; the domain data lives in the WebTestDomains sources. */
const state: WebState = {
    operations: {},
};

function alphaContext(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        createdAt: "2026-09-01T00:00:00Z",
        ctxId: "ctx-old-active",
        environments: [
            {
                instance: "alpha",
                workspace: "/work/portable-devshell",
            },
        ],
        expiresAt: "2026-10-01T00:00:00Z",
        lastAccessedAt: activeLastAccessedAt,
        principal: "client-alpha",
        status: "active",
        ...overrides,
    };
}

function alphaDomains(): WebTestDomains {
    const domains = new WebTestDomains();
    domains.setInstances(baseInstances);
    domains.setContexts([alphaContext()]);
    domains.setMessageHistory("alpha", baseMessageEntries);
    domains.setMessages("alpha", baseMessages);
    return domains;
}

function twoActiveDomains(): WebTestDomains {
    const domains = new WebTestDomains();
    const firstAt = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
    const secondAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    domains.setInstances(baseInstances);
    domains.setContexts([
        alphaContext({
            createdAt: firstAt,
            ctxId: "ctx-first",
            lastAccessedAt: firstAt,
        }),
        alphaContext({
            createdAt: secondAt,
            ctxId: "ctx-second",
            lastAccessedAt: secondAt,
        }),
    ]);
    domains.setMessageHistory("alpha", [
        {
            createdAt: firstAt,
            ctxId: "ctx-first",
            id: "first-comment",
            kind: "comment",
            status: "delivered",
            text: "Investigate the first regression in Audit.",
        },
        {
            createdAt: secondAt,
            ctxId: "ctx-second",
            id: "second-comment",
            kind: "comment",
            status: "delivered",
            text: "Review the Messages navigation.",
        },
    ]);
    return domains;
}

function projection(domains: WebTestDomains) {
    return {
        contexts: domains.context.state.contexts,
        message: domains.messageHistory.state,
        instances: domains.instances.state.instances,
        messages: domains.messages.state,
    };
}

function webStore(domains: WebTestDomains): WebStore {
    return new WebStore(domains.domains);
}

function messageStore(overrides: Record<string, unknown> = {}): WebStore {
    return {
        queueContextMessage: vi.fn(async () => true),
        refreshMessages: vi.fn(async () => undefined),
        state,
        subscribe: vi.fn(() => () => undefined),
        updateMessagePreferences: vi.fn(async () => true),
        ...overrides,
    } as unknown as WebStore;
}

function messagesElement(
    domains: WebTestDomains,
    route: Extract<WebRoute, { page: "messages" }>,
    store: WebStore,
    navigate: (route: WebRoute) => void = vi.fn(),
): ReactElement {
    return withWebDomains(
        domains,
        <Messages navigate={navigate} route={route} store={store} />,
    ) as ReactElement;
}

async function renderMessages(
    domains: WebTestDomains,
    route: Extract<WebRoute, { page: "messages" }>,
    store: WebStore,
    navigate: (route: WebRoute) => void = vi.fn(),
) {
    const view = render(messagesElement(domains, route, store, navigate));
    await act(async () => undefined);
    return view;
}

const threadRoute: Extract<WebRoute, { page: "messages" }> = {
    page: "messages",
    view: "thread",
    instance: "alpha",
    ctxId: "ctx-old-active",
};

describe("Messages", () => {
    afterEach(() => {
        localStorage.clear();
        vi.useRealTimers();
    });

    it("reads Context history instead of the bounded Instance preview and offers older pages", async () => {
        const domains = alphaDomains();
        domains.setMessageHistory("alpha", [{
            createdAt: "2026-09-02T11:00:00Z", ctxId: "ctx-unrelated",
            id: "recent", kind: "comment", status: "delivered", text: "Other Context preview",
        }]);
        const scoped = [{
            createdAt: "2026-09-02T09:00:00Z", ctxId: "ctx-old-active",
            id: "older", kind: "comment", status: "delivered", text: "Scoped old Comment",
        }];
        const loadContext = vi.spyOn(domains.messageHistory, "loadContext")
            .mockImplementation(async (instance, ctxId) => {
                domains.messageHistory.patch({ context: {
                    instance, ctxId, entries: scoped, historyBefore: "older",
                    historyExhausted: false, loading: false,
                } });
            });
        const loadOlder = vi.spyOn(domains.messageHistory, "loadOlderContext").mockResolvedValue(0);
        await renderMessages(domains, threadRoute, webStore(domains));
        expect(loadContext).toHaveBeenCalledWith("alpha", "ctx-old-active");
        expect(screen.getByText("Scoped old Comment")).toBeInTheDocument();
        expect(screen.queryByText("Other Context preview")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Load older Comments and Reports" }));
        await waitFor(() => expect(loadOlder).toHaveBeenCalledWith("alpha", "ctx-old-active"));
    });

    it("keeps only sessions active within the last 30 minutes", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        const domains = alphaDomains();
        expect(selectWebMessageSessions(projection(domains), now)).toEqual([
            expect.objectContaining({
                ctxId: "ctx-old-active",
                instance: "alpha",
                status: "active",
                title: "Check the route model.",
            }),
        ]);

        domains.setContexts([
            alphaContext({ lastAccessedAt: "2026-09-02T09:20:00Z" }),
        ]);
        domains.setMessageHistory("alpha", []);
        domains.setMessages("alpha", []);
        expect(selectWebMessageSessions(projection(domains), now)).toEqual([]);
    });

    it("partitions loaded messages into active and history sessions", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        const domains = alphaDomains();
        domains.setContexts([
            alphaContext({ lastAccessedAt: "2026-09-02T10:00:00Z" }),
        ]);
        domains.setMessageHistory("alpha", [
            ...baseMessageEntries,
            {
                createdAt: "2026-09-02T09:00:00Z",
                ctxId: "ctx-history",
                id: "comment-history",
                kind: "comment",
                status: "delivered",
                text: "Older message.",
            },
        ]);

        expect(
            selectWebMessageSessions(projection(domains), now).map(
                (session) => session.ctxId,
            ),
        ).toEqual(["ctx-old-active"]);
        expect(
            selectWebMessageHistorySessions(projection(domains), now).map(
                (session) => session.ctxId,
            ),
        ).toEqual(["ctx-history"]);
    });

    it("uses the first Comment as the message summary and keeps positions stable as activity changes", () => {
        const now = Date.parse("2026-09-02T10:05:00Z");
        const domains = alphaDomains();
        domains.setContexts([
            alphaContext({
                createdAt: "2026-09-02T09:00:00Z",
                ctxId: "ctx-first",
                lastAccessedAt: "2026-09-02T10:04:00Z",
            }),
            alphaContext({
                createdAt: "2026-09-02T09:30:00Z",
                ctxId: "ctx-second",
                lastAccessedAt: "2026-09-02T10:03:00Z",
            }),
        ]);
        domains.setMessages("alpha", []);
        domains.setMessageHistory("alpha", [
            {
                createdAt: "2026-09-02T09:00:00Z",
                ctxId: "ctx-first",
                id: "first-comment",
                kind: "comment",
                status: "delivered",
                text: "Investigate the first regression in Audit.",
            },
            {
                createdAt: "2026-09-02T10:04:00Z",
                ctxId: "ctx-first",
                id: "first-report",
                kind: "report",
                text: "A later report must not move this message.",
            },
            {
                createdAt: "2026-09-02T09:30:00Z",
                ctxId: "ctx-second",
                id: "second-comment",
                kind: "comment",
                status: "delivered",
                text: "Review the Messages navigation.",
            },
        ]);

        expect(
            selectWebMessageSessions(projection(domains), now).map(
                ({ ctxId, title }) => ({ ctxId, title }),
            ),
        ).toEqual([
            { ctxId: "ctx-second", title: "Review the Messages navigation." },
            {
                ctxId: "ctx-first",
                title: "Investigate the first regression in Audit.",
            },
        ]);
    });

    it("projects canonical Message entries into one chronological message", () => {
        const domains = alphaDomains();
        expect(
            selectWebMessageEntries(
                projection(domains),
                "alpha",
                "ctx-old-active",
            ),
        ).toEqual([
            expect.objectContaining({
                kind: "comment",
                text: "Check the route model.",
            }),
            expect.objectContaining({
                kind: "report",
                text: "Route model is now green.",
            }),
        ]);
    });

    it("exports the current message as readable Markdown", () => {
        const domains = alphaDomains();
        expect(
            buildMessageMarkdown({
                ctxId: "ctx-old-active",
                entries: selectWebMessageEntries(
                    projection(domains),
                    "alpha",
                    "ctx-old-active",
                ),
                instance: "alpha",
                title: "portable-devshell",
            }),
        ).toBe(
            [
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
            ].join("\n"),
        );
    });

    it("downloads the current message from the composer", async () => {
        const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(
            URL,
            "createObjectURL",
        );
        const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(
            URL,
            "revokeObjectURL",
        );
        const createObjectURL = vi.fn(() => "blob:message");
        const revokeObjectURL = vi.fn();
        const click = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function () {
                expect(this.download).toBe(
                    "Check-the-route-model.-alpha-ctx-old-active.md",
                );
                expect(this.href).toBe("blob:message");
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
            const domains = alphaDomains();
            await renderMessages(domains, threadRoute, webStore(domains));

            fireEvent.click(
                screen.getByRole("button", { name: "Export Markdown" }),
            );

            expect(createObjectURL).toHaveBeenCalledTimes(1);
            expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
            expect(revokeObjectURL).toHaveBeenCalledWith("blob:message");
            expect(click).toHaveBeenCalledTimes(1);
        } finally {
            click.mockRestore();
            if (createObjectURLDescriptor === undefined) {
                Reflect.deleteProperty(URL, "createObjectURL");
            } else {
                Object.defineProperty(
                    URL,
                    "createObjectURL",
                    createObjectURLDescriptor,
                );
            }
            if (revokeObjectURLDescriptor === undefined) {
                Reflect.deleteProperty(URL, "revokeObjectURL");
            } else {
                Object.defineProperty(
                    URL,
                    "revokeObjectURL",
                    revokeObjectURLDescriptor,
                );
            }
        }
    });

    it("renders message history, a floating Comment composer, and deep-links to Audit", async () => {
        const domains = alphaDomains();
        const queueContextMessage = vi.spyOn(domains.messages, "queue");
        await renderMessages(domains, threadRoute, webStore(domains));

        expect(
            screen.getByRole("log", { name: "Message history" }),
        ).toHaveTextContent("Check the route model.");
        expect(
            screen.getByRole("log", { name: "Message history" }),
        ).toHaveTextContent("Route model is now green.");
        const composer = screen.getByRole("textbox", { name: "Comment" });
        expect(composer.closest("form")).toHaveClass("messages-composer");
        expect(
            screen.getByRole("button", { name: "Export Markdown" }),
        ).toBeEnabled();
        fireEvent.click(
            screen.getByRole("button", { name: "Open messages" }),
        );
        expect(document.querySelector(".messages-sidebar")).toHaveClass("open");
        fireEvent.focus(composer);
        expect(document.querySelector(".messages-sidebar")).not.toHaveClass(
            "open",
        );
        fireEvent.change(composer, {
            target: { value: "Continue from Messages." },
        });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenCalledWith(
                "alpha",
                "ctx-old-active",
                "Continue from Messages.",
            ),
        );
        expect(
            within(composer.closest("form")!).getByRole("status"),
        ).toHaveTextContent("Message queued.");
        expect(
            screen.getByRole("link", { name: "Open in Audit" }),
        ).toHaveAttribute("href", "#/audit/context/alpha/ctx-old-active");
    });
    it("adds text directives from the composer control menu without structured message metadata", async () => {
        const domains = alphaDomains();
        const queueContextMessage = vi.spyOn(domains.messages, "queue");
        await renderMessages(domains, threadRoute, webStore(domains));
        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.click(
            screen.getByRole("button", { name: "Add message control" }),
        );
        expect(screen.getByRole("button", { name: /^Push/u })).toBeEnabled();
        expect(screen.getByRole("button", { name: /^Stop/u })).toBeEnabled();
        expect(screen.getByRole("button", { name: /^Resume/u })).toBeEnabled();
        fireEvent.click(screen.getByRole("button", { name: /^Push/u }));
        expect(
            within(composer.closest("form")!).getByText("#push"),
        ).toBeVisible();
        fireEvent.change(composer, {
            target: { value: "Answer before continuing." },
        });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenCalledWith(
                "alpha",
                "ctx-old-active",
                "#push Answer before continuing.",
            ),
        );
    });
    it("can send #stop and #resume as standalone text controls", async () => {
        const domains = alphaDomains();
        const queueContextMessage = vi.spyOn(domains.messages, "queue");
        await renderMessages(domains, threadRoute, webStore(domains));
        const form = screen
            .getByRole("textbox", { name: "Comment" })
            .closest("form")!;
        fireEvent.click(
            screen.getByRole("button", { name: "Add message control" }),
        );
        fireEvent.click(screen.getByRole("button", { name: /^Stop/u }));
        fireEvent.submit(form);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenLastCalledWith(
                "alpha",
                "ctx-old-active",
                "#stop",
            ),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Add message control" }),
        );
        fireEvent.click(screen.getByRole("button", { name: /^Resume/u }));
        fireEvent.submit(form);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenLastCalledWith(
                "alpha",
                "ctx-old-active",
                "#resume",
            ),
        );
    });

    it("preserves a newer draft and control while the previous message is being queued", async () => {
        const domains = alphaDomains();
        const request = deferred<Awaited<ReturnType<typeof domains.messages.queue>>>();
        const queueContextMessage = vi.spyOn(domains.messages, "queue").mockImplementation(() => request.promise);
        await renderMessages(domains, threadRoute, webStore(domains));
        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.change(composer, { target: { value: "Message A" } });
        fireEvent.submit(composer.closest("form")!);
        expect(queueContextMessage).toHaveBeenCalledWith("alpha", "ctx-old-active", "Message A");
        expect(composer).toBeEnabled();
        expect(screen.getByRole("button", { name: "Send Comment" })).toBeDisabled();
        fireEvent.change(composer, { target: { value: "Draft B" } });
        fireEvent.click(screen.getByRole("button", { name: "Add message control" }));
        fireEvent.click(screen.getByRole("button", { name: /StopStop model/u }));
        await act(async () => request.resolve({ ...baseMessages[0]!, text: "Message A" }));
        expect(composer).toHaveValue("Draft B");
        expect(screen.getByText("#stop")).toBeInTheDocument();
    });

    it("shows history load failure without claiming the thread is empty", async () => {
        const domains = alphaDomains();
        domains.setMessageHistory("alpha", []);
        domains.messageHistory.patch({ failures: { alpha: new Error("History unavailable") } });
        await renderMessages(domains, threadRoute, messageStore());
        expect(within(screen.getByRole("log")).getByRole("alert")).toHaveTextContent("History unavailable");
        expect(screen.queryByText("No Comments or Reports yet.")).not.toBeInTheDocument();
    });

    it("shows a send failure next to the composer and preserves the draft", async () => {
        const failedState = { ...state, error: "Control connection was lost." };
        const queueContextMessage = vi.fn(async () => false);
        const store = messageStore({ queueContextMessage, state: failedState });
        const domains = alphaDomains();
        await renderMessages(domains, threadRoute, store);

        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.change(composer, { target: { value: "Keep this draft." } });
        fireEvent.submit(composer.closest("form")!);

        const error = await within(composer.closest("form")!).findByRole(
            "alert",
        );
        expect(error).toHaveTextContent("Control connection was lost.");
        expect(composer).toHaveValue("Keep this draft.");
    });

    it("scrolls to the newest message whenever a message is entered or switched", async () => {
        const scrollIntoView = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        try {
            const domains = alphaDomains();
            const store = webStore(domains);
            const view = await renderMessages(domains, threadRoute, store);
            await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
            const initialCalls = scrollIntoView.mock.calls.length;

            view.rerender(
                messagesElement(
                    domains,
                    {
                        page: "messages",
                        view: "thread",
                        instance: "alpha",
                        ctxId: "ctx-second",
                    },
                    store,
                ),
            );
            await act(async () => undefined);
            await waitFor(() =>
                expect(scrollIntoView.mock.calls.length).toBeGreaterThan(
                    initialCalls,
                ),
            );
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
        const domains = alphaDomains();
        domains.setContexts([]);
        const queueContextMessage = vi.spyOn(domains.messages, "queue");
        await renderMessages(domains, threadRoute, webStore(domains));

        const composer = screen.getByRole("textbox", { name: "Comment" });
        expect(composer).not.toBeDisabled();
        fireEvent.change(composer, { target: { value: "Still writable." } });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenCalledWith(
                "alpha",
                "ctx-old-active",
                "Still writable.",
            ),
        );
    });

    it("keeps the floating composer writable for a disabled Context", async () => {
        const domains = alphaDomains();
        domains.setContexts([alphaContext({ status: "disabled" })]);
        const queueContextMessage = vi.spyOn(domains.messages, "queue");
        await renderMessages(domains, threadRoute, webStore(domains));

        const composer = screen.getByRole("textbox", { name: "Comment" });
        fireEvent.change(composer, {
            target: { value: "Message after disable." },
        });
        fireEvent.submit(composer.closest("form")!);
        await waitFor(() =>
            expect(queueContextMessage).toHaveBeenCalledWith(
                "alpha",
                "ctx-old-active",
                "Message after disable.",
            ),
        );
    });

    it("uses the two-line drawer trigger, closes it on selection, and restores focus", async () => {
        const navigate = vi.fn();
        const domains = alphaDomains();
        const view = await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
            navigate,
        );

        expect(
            view.container.querySelector(".messages-sidebar"),
        ).not.toHaveClass("open");
        const trigger = screen.getByRole("button", {
            name: "Open messages",
        });
        fireEvent.click(trigger);
        expect(view.container.querySelector(".messages-sidebar")).toHaveClass(
            "open",
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Check the route model/u }),
        );
        expect(navigate).toHaveBeenCalledWith(threadRoute);
        expect(
            view.container.querySelector(".messages-sidebar"),
        ).not.toHaveClass("open");
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("renames a message through server preferences and restores it in a new browser", async () => {
        localStorage.clear();
        const domains = twoActiveDomains();
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );
        const first = await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        fireEvent.doubleClick(
            screen.getByRole("button", {
                name: /Review the Messages navigation/u,
            }),
        );
        fireEvent.change(screen.getByLabelText("Message title"), {
            target: { value: "Messages navigation review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save title" }));
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                titles: {
                    "alpha\u0000ctx-second": "Messages navigation review",
                },
            }),
        );

        first.unmount();
        domains.messagePreferences.patch({
            preferences: {
                ...domains.messagePreferences.state.preferences,
                titles: {
                    "alpha\u0000ctx-second": "Messages navigation review",
                },
            },
        });
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );
        expect(
            screen.getByRole("button", { name: /Messages navigation review/u }),
        ).toBeInTheDocument();
        expect(
            localStorage.getItem(
                "portable-devshell:web:conversation-preferences:v1",
            ),
        ).toBeNull();
    });

    it("persists manual ordering through server preferences instead of browser storage", async () => {
        localStorage.clear();
        const domains = twoActiveDomains();
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );
        const first = await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );
        const list = screen.getByRole("navigation", { name: "Messages" });
        const rows = list.querySelectorAll<HTMLElement>(".message-row");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("Review the Messages navigation.");
        expect(rows[1]).toHaveTextContent(
            "Investigate the first regression in Audit.",
        );
        expect(
            screen.queryByRole("button", { name: /Move .* up/u }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Move .* down/u }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Rename ctx-/u }),
        ).not.toBeInTheDocument();

        const handles = list.querySelectorAll<HTMLElement>(
            ".message-drag-handle",
        );
        const originalElementFromPoint = document.elementFromPoint;
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: vi.fn(() => rows[0]!),
        });
        fireEvent.pointerDown(handles[1]!, { button: 0, pointerId: 7 });
        fireEvent.pointerUp(handles[1]!, {
            clientX: 10,
            clientY: 10,
            pointerId: 7,
        });
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: originalElementFromPoint,
        });
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                orderByWorkspace: {
                    "/work/portable-devshell": [
                        "alpha\u0000ctx-first",
                        "alpha\u0000ctx-second",
                    ],
                },
            }),
        );
        expect(
            list.querySelectorAll<HTMLElement>(".message-row")[0],
        ).toHaveTextContent("Investigate the first regression in Audit.");

        first.unmount();
        domains.messagePreferences.patch({
            preferences: {
                ...domains.messagePreferences.state.preferences,
                orderByWorkspace: {
                    "/work/portable-devshell": [
                        "alpha\u0000ctx-first",
                        "alpha\u0000ctx-second",
                    ],
                },
                workspaceOrder: ["/work/portable-devshell"],
            },
        });
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );
        expect(
            screen
                .getByRole("navigation", { name: "Messages" })
                .querySelectorAll<HTMLElement>(".message-row")[0],
        ).toHaveTextContent("Investigate the first regression in Audit.");
        expect(
            localStorage.getItem(
                "portable-devshell:web:conversation-preferences:v1",
            ),
        ).toBeNull();
    });

    it("soft-hides messages and whole projects and restores them from Hidden", async () => {
        const domains = twoActiveDomains();
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );
        const navigate = vi.fn();
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
            navigate,
        );

        const reviewRow = screen
            .getByRole("button", { name: /Review the Messages navigation/u })
            .closest(".message-row")!;
        fireEvent.click(
            within(reviewRow).getByRole("button", {
                name: "Hide message",
            }),
        );
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                hiddenContexts: { "ctx-second": true },
            }),
        );
        expect(
            screen.queryByRole("button", {
                name: /Review the Messages navigation/u,
            }),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
        expect(
            screen.getByRole("button", {
                name: /Review the Messages navigation/u,
            }),
        ).toBeInTheDocument();
        const hiddenReviewRow = screen
            .getByRole("button", { name: /Review the Messages navigation/u })
            .closest(".message-row")!;
        fireEvent.click(
            within(hiddenReviewRow).getByRole("button", {
                name: "Restore message",
            }),
        );
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenLastCalledWith({
                hiddenContexts: { "ctx-second": null },
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Current" }));
        fireEvent.click(
            within(
                screen.getByRole("group", { name: "portable-devshell" }),
            ).getByRole("button", { name: "Hide project" }),
        );
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenLastCalledWith({
                hiddenContexts: {
                    "ctx-first": true,
                    "ctx-second": true,
                },
            }),
        );
        expect(
            screen.queryByRole("button", {
                name: /Investigate the first regression/u,
            }),
        ).not.toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("uses server titles and ordering rather than retired browser preferences", async () => {
        const domains = twoActiveDomains();
        domains.messagePreferences.patch({
            preferences: {
                ...domains.messagePreferences.state.preferences,
                titles: { "alpha\u0000ctx-second": "Server title" },
            },
        });
        const stale = JSON.stringify({
            titles: { "alpha\u0000ctx-second": "Legacy title" },
            workspaceOrder: ["/work/retired"],
        });
        const key = "portable-devshell:web:conversation-preferences:v1";
        localStorage.setItem(key, stale);
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );

        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        expect(screen.getByRole("button", { name: /Server title/u })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Legacy title/u })).not.toBeInTheDocument();
        await waitFor(() =>
            expect(domains.messagePreferences.state.preferences.workspaceOrder).toContain(
                "/work/portable-devshell",
            ),
        );
        expect(updateMessagePreferences).not.toHaveBeenCalledWith(
            expect.objectContaining({
                titles: { "alpha\u0000ctx-second": "Legacy title" },
            }),
        );
        expect(localStorage.getItem(key)).toBe(stale);
    });

    it("ignores retired browser hidden-context preferences instead of importing them to the server", async () => {
        const domains = twoActiveDomains();
        const stale = JSON.stringify({
            hiddenContexts: { "ctx-first": true, "ctx-second": true },
            titles: { "alpha\u0000ctx-second": "Legacy title" },
        });
        const key = "portable-devshell:web:conversation-preferences:v1";
        localStorage.setItem(key, stale);
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );

        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        expect(
            screen.getByRole("button", { name: /Investigate the first regression/u }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Review the Messages navigation/u }),
        ).toBeInTheDocument();
        expect(updateMessagePreferences).not.toHaveBeenCalledWith(
            expect.objectContaining({
                hiddenContexts: { "ctx-first": true, "ctx-second": true },
            }),
        );
        expect(localStorage.getItem(key)).toBe(stale);
    });

    it("discovers new server ordering entries without pruning unloaded workspaces or overwriting existing order", async () => {
        const domains = twoActiveDomains();
        domains.messagePreferences.patch({
            preferences: {
                hiddenContexts: {},
                orderByWorkspace: {
                    "/work/portable-devshell": ["alpha\u0000ctx-first"],
                    "/work/hidden": ["beta\u0000ctx-hidden"],
                },
                titles: {},
                version: 1,
                workspaceOrder: ["/work/hidden", "/work/portable-devshell"],
            },
        });
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );

        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                ifMissing: true,
                orderByWorkspace: {
                    "/work/portable-devshell": [
                        "alpha\u0000ctx-second",
                        "alpha\u0000ctx-first",
                    ],
                },
            }),
        );
        expect(updateMessagePreferences).not.toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceOrder: ["/work/portable-devshell"],
            }),
        );
    });

    it("keeps an idle Current message in place until the user archives idle messages", async () => {
        const domains = twoActiveDomains();
        const store = webStore(domains);
        const view = await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            store,
        );
        expect(
            screen.getByRole("button", {
                name: /Investigate the first regression/u,
            }),
        ).toBeInTheDocument();

        const idleAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
        domains.setContexts(
            domains.context.state.contexts.map((context) => ({
                ...context,
                lastAccessedAt: idleAt,
            })),
        );
        domains.setMessageHistory(
            "alpha",
            domains.messageHistory.state.instances.alpha.entries.map((entry) => ({
                ...entry,
                createdAt: idleAt,
            })),
        );
        view.rerender(
            messagesElement(
                domains,
                { page: "messages", view: "contexts" },
                store,
            ),
        );
        await act(async () => undefined);

        expect(
            screen.getByRole("button", {
                name: /Investigate the first regression/u,
            }),
        ).toHaveTextContent("idle");
        fireEvent.click(
            screen.getByRole("button", { name: "Clear idle from Current" }),
        );
        expect(
            screen.queryByRole("button", {
                name: /Investigate the first regression/u,
            }),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "History" }));
        fireEvent.click(
            screen.getByRole("button", { name: /portable-devshell/u }),
        );
        expect(
            screen.getByRole("button", {
                name: /Investigate the first regression/u,
            }),
        ).toBeInTheDocument();
    });

    it("refreshes Context activity and ages Current messages every 20 seconds", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
        const domains = twoActiveDomains();
        const almostIdleAt = new Date(
            Date.now() - 30 * 60 * 1_000 + 10_000,
        ).toISOString();
        domains.setContexts(
            domains.context.state.contexts.map((context) =>
                context.ctxId === "ctx-first"
                    ? {
                          ...context,
                          createdAt: almostIdleAt,
                          lastAccessedAt: almostIdleAt,
                      }
                    : context,
            ),
        );
        domains.setMessageHistory(
            "alpha",
            domains.messageHistory.state.instances.alpha.entries.map((entry) =>
                entry.ctxId === "ctx-first"
                    ? { ...entry, createdAt: almostIdleAt }
                    : entry,
            ),
        );
        const store = webStore(domains);
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            store,
        );
        const contextRefresh = vi.spyOn(domains.context, "refresh");
        const message = screen.getByRole("button", {
            name: /Investigate the first regression/u,
        });
        expect(message).toHaveTextContent("active");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(contextRefresh).toHaveBeenCalledOnce();
        expect(message).toHaveTextContent("idle");
    });

    it("closes the message control disclosure with Escape and restores focus", async () => {
        const domains = alphaDomains();
        await renderMessages(domains, threadRoute, webStore(domains));
        const trigger = screen.getByRole("button", {
            name: "Add message control",
        });
        fireEvent.click(trigger);
        expect(screen.getByLabelText("Message controls")).toBeInTheDocument();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(
            screen.queryByLabelText("Message controls"),
        ).not.toBeInTheDocument();
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("switches the sidebar between active and history messages", async () => {
        const domains = alphaDomains();
        domains.setMessageHistory("alpha", [
            ...baseMessageEntries,
            {
                createdAt: "2026-09-01T08:00:00Z",
                ctxId: "ctx-history",
                id: "comment-history",
                kind: "comment",
                status: "delivered",
                text: "Historical message.",
            },
        ]);
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        const active = screen.getByRole("button", { name: "Current" });
        const history = screen.getByRole("button", { name: "History" });
        expect(active.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(history.closest(".messages-sidebar-heading")).not.toBeNull();
        expect(active).toHaveAttribute("aria-pressed", "true");
        expect(history).toHaveAttribute("aria-pressed", "false");
        expect(
            screen.getByRole("button", { name: /Check the route model/u }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Historical message/u }),
        ).not.toBeInTheDocument();

        fireEvent.click(history);

        expect(active).toHaveAttribute("aria-pressed", "false");
        expect(history).toHaveAttribute("aria-pressed", "true");
        expect(
            screen.queryByRole("button", { name: /Check the route model/u }),
        ).not.toBeInTheDocument();
        const groupToggle = screen.getByRole("button", { name: /alpha/u });
        fireEvent.click(groupToggle);
        expect(
            screen.getByRole("button", { name: /Historical message/u }),
        ).toBeInTheDocument();
    });

    it("groups history messages by workspace and lets each workspace collapse", async () => {
        const domains = alphaDomains();
        domains.setContexts([
            alphaContext(),
            {
                createdAt: "2026-09-01T08:00:00Z",
                ctxId: "ctx-project-new",
                environments: [
                    {
                        instance: "alpha",
                        workspace: "/work/portable-devshell",
                    },
                ],
                expiresAt: "2026-09-01T09:00:00Z",
                lastAccessedAt: "2026-09-01T08:20:00Z",
                principal: "client-alpha",
                status: "expired",
            },
            {
                createdAt: "2026-09-01T07:00:00Z",
                ctxId: "ctx-project-old",
                environments: [
                    {
                        instance: "alpha",
                        workspace: "/work/portable-devshell",
                    },
                ],
                expiresAt: "2026-09-01T08:00:00Z",
                lastAccessedAt: "2026-09-01T07:20:00Z",
                principal: "client-alpha",
                status: "expired",
            },
            {
                createdAt: "2026-08-31T08:00:00Z",
                ctxId: "ctx-efilinux",
                environments: [
                    {
                        instance: "alpha",
                        workspace: "/work/efilinux",
                    },
                ],
                expiresAt: "2026-08-31T09:00:00Z",
                lastAccessedAt: "2026-08-31T08:20:00Z",
                principal: "client-alpha",
                status: "expired",
            },
        ]);
        const view = await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        fireEvent.click(screen.getByRole("button", { name: "History" }));

        const messageList = screen.getByRole("navigation", {
            name: "Messages",
        });
        const groups = within(messageList).getAllByRole("group");
        expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(
            ["portable-devshell", "efilinux"],
        );
        const portableToggle = within(groups[0]!).getByRole("button", {
            name: /portable-devshell/u,
        });
        expect(portableToggle).toHaveAttribute("aria-expanded", "false");
        expect(
            within(groups[0]!).queryByText("ctx-project-new"),
        ).not.toBeInTheDocument();
        fireEvent.click(portableToggle);
        expect(portableToggle).toHaveAttribute("aria-expanded", "true");
        expect(
            within(groups[0]!).getAllByText(/portable-devshell · ctx-projec/u),
        ).toHaveLength(2);

        domains.setContexts([
            {
                createdAt: "2026-09-02T08:00:00Z",
                ctxId: "ctx-efilinux-newer",
                environments: [
                    {
                        instance: "alpha",
                        workspace: "/work/efilinux",
                    },
                ],
                expiresAt: "2026-09-02T09:00:00Z",
                lastAccessedAt: "2026-09-02T08:20:00Z",
                principal: "client-alpha",
                status: "expired",
            },
            ...domains.context.state.contexts,
        ]);
        view.rerender(
            messagesElement(
                domains,
                { page: "messages", view: "contexts" },
                webStore(domains),
            ),
        );
        await act(async () => undefined);
        const stableGroups = within(
            screen.getByRole("navigation", { name: "Messages" }),
        ).getAllByRole("group");
        expect(
            stableGroups.map((group) => group.getAttribute("aria-label")),
        ).toEqual(["portable-devshell", "efilinux"]);
    });

    it("renames a message from the row action menu", async () => {
        const domains = twoActiveDomains();
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );

        const reviewRow = screen
            .getByRole("button", { name: /Review the Messages navigation/u })
            .closest(".message-row")!;
        fireEvent.click(
            within(reviewRow).getByRole("button", {
                name: "Message actions",
            }),
        );
        fireEvent.click(
            within(reviewRow).getByRole("button", { name: "Rename" }),
        );
        expect(
            screen.queryByLabelText(/^Actions for Review/u),
        ).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Message title"), {
            target: { value: "Renamed from the menu" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save title" }));
        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                titles: { "alpha\u0000ctx-second": "Renamed from the menu" },
            }),
        );
    });

    it("closes the message action menu with Escape and keeps the sidebar open", async () => {
        const domains = twoActiveDomains();
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Open messages" }),
        );
        const reviewRow = screen
            .getByRole("button", { name: /Review the Messages navigation/u })
            .closest(".message-row")!;
        const trigger = within(reviewRow).getByRole("button", {
            name: "Message actions",
        });
        fireEvent.click(trigger);
        expect(
            screen.getByLabelText(/^Actions for Review/u),
        ).toBeInTheDocument();

        fireEvent.keyDown(document, { key: "Escape" });

        expect(
            screen.queryByLabelText(/^Actions for Review/u),
        ).not.toBeInTheDocument();
        expect(document.querySelector(".messages-sidebar")).toHaveClass("open");
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("reorders messages from the row action menu and disables boundary moves", async () => {
        const domains = twoActiveDomains();
        const updateMessagePreferences = vi.spyOn(
            domains.messagePreferences,
            "update",
        );
        await renderMessages(
            domains,
            { page: "messages", view: "contexts" },
            webStore(domains),
        );
        const list = screen.getByRole("navigation", { name: "Messages" });
        const rows = list.querySelectorAll<HTMLElement>(".message-row");
        expect(rows[0]).toHaveTextContent("Review the Messages navigation.");

        fireEvent.click(
            within(rows[0]!).getByRole("button", {
                name: "Message actions",
            }),
        );
        expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Move down" })).toBeEnabled();
        fireEvent.keyDown(document, { key: "Escape" });

        fireEvent.click(
            within(rows[1]!).getByRole("button", {
                name: "Message actions",
            }),
        );
        expect(screen.getByRole("button", { name: "Move up" })).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Move down" }),
        ).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Move up" }));

        await waitFor(() =>
            expect(updateMessagePreferences).toHaveBeenCalledWith({
                orderByWorkspace: {
                    "/work/portable-devshell": [
                        "alpha\u0000ctx-first",
                        "alpha\u0000ctx-second",
                    ],
                },
            }),
        );
        expect(
            list.querySelectorAll<HTMLElement>(".message-row")[0],
        ).toHaveTextContent("Investigate the first regression in Audit.");
    });

    it("shows a draft length hint only near the maximum length", async () => {
        const domains = alphaDomains();
        await renderMessages(domains, threadRoute, webStore(domains));
        const composer = screen.getByRole("textbox", { name: "Comment" });
        const form = composer.closest("form")!;
        expect(
            within(form).queryByText(/\d+ \/ 20000/u),
        ).not.toBeInTheDocument();

        fireEvent.change(composer, { target: { value: "a".repeat(18_000) } });
        expect(
            within(form).queryByText(/\d+ \/ 20000/u),
        ).not.toBeInTheDocument();

        fireEvent.change(composer, { target: { value: "a".repeat(18_001) } });
        expect(within(form).getByText("18001 / 20000")).toBeInTheDocument();
    });

    it("formats message timestamps compactly relative to the current date", () => {
        const now = new Date(2026, 8, 27, 12, 0, 0);
        expect(formatMessageDate("not-a-date", now)).toBe("not-a-date");
        expect(
            formatMessageDate(new Date(2026, 8, 27, 9, 30).toISOString(), now),
        ).not.toMatch(/\d{4}/u);
        expect(
            formatMessageDate(new Date(2026, 2, 2, 9, 30).toISOString(), now),
        ).not.toMatch(/\d{4}/u);
        expect(
            formatMessageDate(new Date(2025, 8, 27, 9, 30).toISOString(), now),
        ).toMatch(/2025/u);
    });
});
