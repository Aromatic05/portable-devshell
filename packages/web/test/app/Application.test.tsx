import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type InstanceSnapshot,
    type OperationalOverview,
} from "@portable-devshell/shared";

import type { WebSession } from "../../src/app/session/Session.js";
import type { WebState, WebStore } from "../../src/state/Store.js";
import { App } from "../../src/app/App.js";
import { Application } from "../../src/app/Application.js";
import { WebTestDomains } from "../support/DomainHarness.js";

import {
    pageRoute,
    readHashRoute,
    useHashRoute,
    webRouteHref,
    type WebRoute,
} from "../../src/app/Route.js";

const snapshot: InstanceSnapshot = {
    connectionState: "connected",
    daemonState: "running",
    lastSeq: 1,
    name: asInstanceName("demo"),
    ready: true,
    status: "ready",
};

function operationalOverview(
    overrides: Partial<OperationalOverview> = {},
): OperationalOverview {
    return {
        activity: [],
        alerts: [],
        controller: { pid: 1, uptimeSeconds: 1 },
        counts: {
                        failedCalls24h: 0,
            instancesAttention: 0,
            instancesCritical: 0,
            instancesReady: 1,
            instancesTotal: 1,
            pendingApprovals: 0,
        },
        generatedAt: "2026-09-14T10:00:02Z",
        health: "healthy",
        instances: [],
        ...overrides,
    };
}

function setServerStatus(
    domains: WebTestDomains,
    status: "connecting" | "offline" | "online",
): void {
    Object.assign(domains.server, {
        state: { ...domains.server.state, status },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.title = "";
});

describe("authenticated application shell", () => {
    it("renders discovered Extension pages inside the Web shell instead of navigating to a standalone application", async () => {
        const domains = new WebTestDomains();
        const pageSnapshot = {
            tables: [
                {
                    columns: [
                        { id: "endpoint", label: "Endpoint" },
                        { id: "state", label: "State" },
                    ],
                    id: "endpoints",
                    rows: [
                        {
                            actions: [{ id: "disable", label: "Disable" }],
                            cells: {
                                endpoint: { text: "cloudflare-mcp" },
                                state: { text: "running", tone: "success" as const },
                            },
                            id: "cloudflare-mcp",
                        },
                    ],
                    title: "Endpoints",
                },
            ],
        };
        domains.extension.patch({
            webPages: [
                { extensionId: "access", id: "access", title: "Access" },
            ],
        });
        const readWebPage = vi.fn(async () => pageSnapshot);
        const webAction = vi.fn(async () => pageSnapshot);
        Object.assign(domains.extension, { readWebPage, webAction });
        const session = fakeSession({
            authMode: "none",
            check: false,
            establish: true,
        });

        render(<App createDomains={() => domains.domains} session={session} />);

        fireEvent.click(
            await screen.findByRole("button", {
                name: "Switch page, current Overview",
            }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "Access" }));

        expect(window.location.hash).toBe("#/extensions/access");
        expect(await screen.findByText("cloudflare-mcp")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Disable" }));
        await waitFor(() =>
            expect(webAction).toHaveBeenCalledWith(
                "access",
                "disable",
                "cloudflare-mcp",
            ),
        );
        expect(readWebPage).toHaveBeenCalledWith("access");
        window.location.hash = "";
    });

    it("renders discovered Extension applications as Web-domain navigation without invoking them", async () => {
        const domains = new WebTestDomains();
        domains.extension.patch({
            webApplications: [
                { extensionId: "agent", id: "agent", title: "Agent" },
            ],
        });
        const readWebPage = vi.fn(async () => ({ tables: [] }));
        Object.assign(domains.extension, { readWebPage });
        const session = fakeSession({
            authMode: "none",
            check: false,
            establish: true,
        });

        render(<App createDomains={() => domains.domains} session={session} />);

        fireEvent.click(
            await screen.findByRole("button", {
                name: "Switch page, current Overview",
            }),
        );
        const link = await screen.findByRole("link", { name: "Agent" });
        expect(link).toHaveAttribute("href", "./extensions/agent/");
        expect(readWebPage).not.toHaveBeenCalled();
        const trigger = screen.getByRole("button", {
            name: "Switch page, current Overview",
        });
        fireEvent.keyDown(document, { key: "Escape" });
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("keeps the default browser session stable across React renders", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal("fetch", request);
        const domains = new WebTestDomains();
        const createDomains = vi.fn(() => domains.domains);

        render(<App createDomains={createDomains} />);

        expect(
            await screen.findByRole("heading", { name: "Overview" }),
        ).toBeInTheDocument();
        await waitFor(() => expect(createDomains).toHaveBeenCalledOnce());
        expect(request).toHaveBeenCalledOnce();
    });

    it("boots auth=none anonymously before creating domains", async () => {
        const session = fakeSession({
            authMode: "none",
            check: false,
            establish: true,
        });
        const domains = new WebTestDomains();
        const createDomains = vi.fn(() => domains.domains);

        render(<App createDomains={createDomains} session={session} />);

        expect(
            await screen.findByRole("heading", { name: "Overview" }),
        ).toBeInTheDocument();
        expect(session.establish).toHaveBeenCalledWith();
        expect(createDomains).toHaveBeenCalledOnce();
    });

    it("shows token login without submitting an empty bearer token", async () => {
        const session = fakeSession({ authMode: "token", check: false });
        const domains = new WebTestDomains();
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
        expect(session.establish).not.toHaveBeenCalled();
    });

    it("preserves the entered token when sign-in is rejected", async () => {
        const session = fakeSession({
            authMode: "token",
            check: false,
            establish: false,
        });
        const domains = new WebTestDomains();
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        const token = await screen.findByLabelText("Access token");
        fireEvent.change(token, { target: { value: "secret-token" } });
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Sign-in was not accepted.",
        );
        expect(token).toHaveValue("secret-token");
    });

    it("toggles access token visibility without losing the entered token", async () => {
        const session = fakeSession({ authMode: "token", check: false });
        const domains = new WebTestDomains();
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        const token = await screen.findByLabelText("Access token");
        fireEvent.change(token, { target: { value: "secret-token" } });
        expect(token).toHaveAttribute("type", "password");
        expect(token).toHaveAttribute("autocomplete", "current-password");

        const show = screen.getByRole("button", {
            name: "Show access token",
        });
        expect(show).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(show);
        expect(token).toHaveAttribute("type", "text");
        expect(token).toHaveValue("secret-token");

        const hide = screen.getByRole("button", {
            name: "Hide access token",
        });
        expect(hide).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(hide);
        expect(token).toHaveAttribute("type", "password");
        expect(token).toHaveValue("secret-token");
    });

    it("redirects to the OAuth start endpoint when auth=oauth2", async () => {
        const session = fakeSession({
            authMode: "oauth2",
            check: false,
            establish: false,
        });
        const domains = new WebTestDomains();
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        await waitFor(() => expect(session.startOAuth).toHaveBeenCalledOnce());
        expect(session.establish).not.toHaveBeenCalled();
        expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    });

    it("keeps a submitted token in component state only and logs out", async () => {
        const session = fakeSession({ check: false, establish: false });
        const domains = new WebTestDomains();
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        const token = await screen.findByLabelText("Access token");
        fireEvent.change(token, { target: { value: "secret-token" } });
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        await waitFor(() =>
            expect(session.establish).toHaveBeenLastCalledWith("secret-token"),
        );
        expect(window.localStorage.getItem("token")).toBeNull();
        expect(window.sessionStorage.getItem("token")).toBeNull();

        session.establish.mockResolvedValueOnce(true);
        fireEvent.change(screen.getByLabelText("Access token"), {
            target: { value: "secret-token" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(
            await screen.findByRole("button", { name: "Log out" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Log out" }));
        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
        await waitFor(() => expect(session.logout).toHaveBeenCalledOnce());
    });

    it("returns to login when reconnect finds an expired session", async () => {
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        setServerStatus(domains, "offline");
        const close = vi.spyOn(domains.domains, "close");

        render(
            <App createDomains={() => domains.domains} session={session} />,
        );
        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockResolvedValue(false);
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        await waitFor(() =>
            expect(session.check.mock.calls.length).toBeGreaterThanOrEqual(2),
        );

        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
        expect(close).toHaveBeenCalledOnce();
        expect(session.check.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("reuses OAuth sign-in when reconnect finds an expired OAuth session", async () => {
        const session = fakeSession({ authMode: "oauth2", check: true });
        const domains = new WebTestDomains();
        setServerStatus(domains, "offline");
        const close = vi.spyOn(domains.domains, "close");
        render(<App createDomains={() => domains.domains} session={session} />);
        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockResolvedValue(false);
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        await waitFor(() => expect(session.startOAuth).toHaveBeenCalledOnce());
        expect(session.authMode).toHaveBeenCalledOnce();
        expect(session.establish).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
        expect(close).toHaveBeenCalledOnce();
    });

    it("makes reconnect single-flight while checking the session", async () => {
        let releaseCheck!: (available: boolean) => void;
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        setServerStatus(domains, "offline");
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockImplementation(
            async () =>
                await new Promise<boolean>((resolve) => {
                    releaseCheck = resolve;
                }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        expect(
            screen.getByRole("button", { name: "Reconnecting…" }),
        ).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Reconnecting…" }));
        releaseCheck(true);

        await waitFor(() => expect(session.check).toHaveBeenCalledTimes(2));
    });

    it("ignores a superseded bootstrap after the session changes", async () => {
        let resolveFirstCheck!: (available: boolean) => void;
        const first: WebSession = {
            authMode: async () => "token",
            check: async () =>
                await new Promise<boolean>((resolve) => {
                    resolveFirstCheck = resolve;
                }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const second = fakeSession({ check: false, establish: false });
        const domains = new WebTestDomains();
        const createDomains = vi.fn(() => domains.domains);
        const view = render(
            <App createDomains={createDomains} session={first} />,
        );

        view.rerender(<App createDomains={createDomains} session={second} />);
        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
        resolveFirstCheck(true);
        await Promise.resolve();

        expect(createDomains).not.toHaveBeenCalled();
    });

    it("does not recreate domains after an unmounted bootstrap resolves", async () => {
        let resolveCheck!: (available: boolean) => void;
        const session: WebSession = {
            authMode: async () => "token",
            check: async () =>
                await new Promise<boolean>((resolve) => {
                    resolveCheck = resolve;
                }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const domains = new WebTestDomains();
        const createDomains = vi.fn(() => domains.domains);
        const view = render(
            <App createDomains={createDomains} session={session} />,
        );

        view.unmount();
        resolveCheck(true);
        await Promise.resolve();

        expect(createDomains).not.toHaveBeenCalled();
    });

    it("makes logout single-flight while the session revocation is pending", async () => {
        let releaseLogout!: () => void;
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        session.logout.mockImplementation(
            async () =>
                await new Promise<void>((resolve) => {
                    releaseLogout = resolve;
                }),
        );
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        const logout = await screen.findByRole("button", { name: "Log out" });
        fireEvent.click(logout);
        expect(
            screen.getByRole("button", { name: "Logging out…" }),
        ).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Logging out…" }));
        releaseLogout();

        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
        expect(session.logout).toHaveBeenCalledOnce();
    });

    it("disables runtime actions while logout is pending", async () => {
        let releaseLogout!: () => void;
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        session.logout.mockImplementation(
            async () =>
                await new Promise<void>((resolve) => {
                    releaseLogout = resolve;
                }),
        );
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Switch page, current Overview",
            }),
        );
        fireEvent.click(
            within(screen.getByLabelText("Pages")).getByRole("button", {
                name: /Instances/,
            }),
        );
        fireEvent.click(await screen.findByText("demo"));
        const stop = await screen.findByRole("button", { name: "Stop" });
        expect(stop).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Log out" }));

        expect(stop).toBeDisabled();
        releaseLogout();
        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
    });

    it("shows a failed logout without leaving the application", async () => {
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        session.logout.mockRejectedValue(
            new Error("Session revocation failed"),
        );
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

        expect(
            await screen.findByText("Session revocation failed"),
        ).toHaveAttribute("role", "alert");
        expect(
            screen.getByRole("button", { name: "Log out" }),
        ).toBeInTheDocument();
    });

    it("shows a session verification error when reconnect checking fails", async () => {
        const session = fakeSession({ check: true });
        const domains = new WebTestDomains();
        setServerStatus(domains, "offline");
        render(
            <App createDomains={() => domains.domains} session={session} />,
        );

        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockRejectedValue(new Error("Session unavailable"));
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

        expect(await screen.findByRole("alert")).toBeInTheDocument();
        session.check.mockResolvedValue(true);
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

        await waitFor(() =>
            expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
        );
    });

    it("clears the ready store before bootstrapping a replacement session", async () => {
        let resolveCheck!: (available: boolean) => void;
        const domains = new WebTestDomains();
        const close = vi.spyOn(domains.domains, "close");
        const initial = fakeSession({ check: true });
        const replacement: WebSession = {
            authMode: async () => "token",
            check: async () =>
                await new Promise<boolean>((resolve) => {
                    resolveCheck = resolve;
                }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const createDomains = vi.fn(() => domains.domains);
        const view = render(
            <App createDomains={createDomains} session={initial} />,
        );

        await screen.findByRole("button", { name: "Log out" });
        view.rerender(
            <App createDomains={createDomains} session={replacement} />,
        );

        expect(close).toHaveBeenCalledOnce();
        resolveCheck(false);
        expect(
            await screen.findByRole("button", { name: "Sign in" }),
        ).toBeInTheDocument();
    });

    it("exposes direct primary navigation while retaining the responsive Page Switcher", async () => {
        window.location.hash = "#/overview";
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });

        expect(document.querySelector(".app > aside")).toBeNull();
        const primary = screen.getByRole("navigation", {
            name: "Primary navigation",
        });
        expect(
            within(primary).queryByRole("button", { name: "Config" }),
        ).not.toBeInTheDocument();
        expect(
            within(primary).queryByRole("button", { name: "Connections" }),
        ).not.toBeInTheDocument();
        expect(
            within(primary).queryByRole("button", { name: "Approvals" }),
        ).not.toBeInTheDocument();
        fireEvent.click(
            within(primary).getByRole("button", { name: "Instances" }),
        );
        expect(window.location.hash).toBe("#/instances");
        expect(
            await screen.findByRole("heading", { name: "Instances" }),
        ).toBeInTheDocument();

        fireEvent.click(await screen.findByText("demo"));
        const instanceSections = screen.getByRole("navigation", {
            name: "Instance sections",
        });
        expect(
            within(instanceSections).getByRole("link", { name: "Config" }),
        ).toHaveAttribute("href", "#/instances/demo?view=config");
        expect(
            within(instanceSections).getByRole("link", { name: "Connections" }),
        ).toHaveAttribute("href", "#/instances/demo?view=connections");

        window.location.hash = "#/overview";
        await screen.findByRole("heading", { name: "Overview" });
        fireEvent.click(
            screen.getByRole("button", {
                name: "Switch page, current Overview",
            }),
        );
        const menu = screen.getByLabelText("Pages");
        fireEvent.click(
            within(menu).getByRole("button", { name: /Instances/ }),
        );
        expect(window.location.hash).toBe("#/instances");
        fireEvent.click(await screen.findByText("demo"));
        expect(
            await screen.findByRole("heading", { name: "demo", level: 3 }),
        ).toBeInTheDocument();
    });

    it("uses Overview summary links as bookmarkable navigation", async () => {
        window.location.hash = "#/overview";
        const domains = new WebTestDomains();
        domains.setOverview(operationalOverview());
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );

        const activity = await screen.findByRole("link", {
            name: "Recent tool calls",
        });
        expect(activity).toHaveAttribute("href", "#/audit");
        fireEvent.click(activity);
        expect(
            await screen.findByRole("heading", { name: "Audit" }),
        ).toBeInTheDocument();
        expect(window.location.hash).toBe("#/audit");
    });

    it("links each Overview activity directly to its Tool Call", async () => {
        const domains = new WebTestDomains();
        domains.setOverview(
            operationalOverview({
                activity: [
                    {
                        callId: "call-direct",
                        completedAt: "2026-09-14T10:00:01Z",
                        instance: asInstanceName("demo"),
                        source: "cli",
                        startedAt: "2026-09-14T10:00:00Z",
                        status: "completed",
                        toolName: "file_read",
                    },
                ],
            }),
        );
        window.location.hash = "#/overview";
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );

        const activity = await screen.findByRole("link", {
            name: /demo.*file_read.*completed/u,
        });
        expect(activity).toHaveAttribute(
            "href",
            "#/audit/instance/demo/call/call-direct",
        );
    });

    it("lets the user dismiss stale global errors", async () => {
        const domains = new WebTestDomains();
        Object.assign(domains.domains, {
            load: vi.fn(async () => {
                throw new Error("Control offline");
            }),
        });
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Control offline",
        );
        fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
        await waitFor(() =>
            expect(
                screen.queryByText("Control offline"),
            ).not.toBeInTheDocument(),
        );
    });
});

describe("application chrome", () => {
    it("sets the document title from the active route and message context", async () => {
        window.location.hash = "#/overview";
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });
        expect(document.title).toBe("Overview — portable-devshell");

        window.location.hash = "#/instances";
        fireEvent(window, new HashChangeEvent("hashchange"));
        await screen.findByRole("heading", { name: "Instances" });
        expect(document.title).toBe("Instances — portable-devshell");

        window.location.hash = "#/instances/demo";
        fireEvent(window, new HashChangeEvent("hashchange"));
        await screen.findByRole("heading", { name: "demo", level: 3 });
        expect(document.title).toBe("Instances · demo — portable-devshell");

        window.location.hash = "#/messages";
        fireEvent(window, new HashChangeEvent("hashchange"));
        await screen.findByRole("heading", { level: 3, name: "Messages" });
        expect(document.title).toBe("Messages — portable-devshell");

        window.location.hash = "#/messages/demo/ctx-a";
        fireEvent(window, new HashChangeEvent("hashchange"));
        await screen.findByRole("heading", { name: "ctx-a" });
        expect(document.title).toBe("Messages · demo — portable-devshell");
    });

    it("badges Instances with the count needing attention", async () => {
        const domains = new WebTestDomains();
        domains.setOverview(
            operationalOverview({
                counts: {
                                        failedCalls24h: 0,
                    instancesAttention: 2,
                    instancesCritical: 1,
                    instancesReady: 0,
                    instancesTotal: 3,
                    pendingApprovals: 0,
                },
                health: "attention",
            }),
        );
        window.location.hash = "#/overview";
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });

        const primary = screen.getByRole("navigation", {
            name: "Primary navigation",
        });
        await waitFor(() =>
            expect(
                within(primary).getByRole("button", { name: /Instances/ }),
            ).toHaveTextContent("3"),
        );
    });

    it("hides the Instances badge when nothing needs attention", async () => {
        window.location.hash = "#/overview";
        const domains = new WebTestDomains();
        render(
            <App
                createDomains={() => domains.domains}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });

        const primary = screen.getByRole("navigation", {
            name: "Primary navigation",
        });
        const instances = within(primary).getByRole("button", {
            name: "Instances",
        });
        expect(within(instances).queryByText(/\d/u)).not.toBeInTheDocument();
    });
});

describe("application notice feedback", () => {
    it("auto-dismisses a success notice after five seconds", () => {
        vi.useFakeTimers();
        window.location.hash = "#/overview";
        const { emit, store } = fakeApplicationStore();
        render(
            <Application
                onLogout={async () => undefined}
                onReconnect={async () => undefined}
                store={store}
            />,
        );

        act(() => emit({ notice: "Configuration saved." }));
        expect(screen.getByText("Configuration saved.")).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(4_999);
        });
        expect(screen.getByText("Configuration saved.")).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(
            screen.queryByText("Configuration saved."),
        ).not.toBeInTheDocument();
    });

    it("restarts the auto-dismiss timer when the notice text changes", () => {
        vi.useFakeTimers();
        window.location.hash = "#/overview";
        const { emit, store } = fakeApplicationStore();
        render(
            <Application
                onLogout={async () => undefined}
                onReconnect={async () => undefined}
                store={store}
            />,
        );

        act(() => emit({ notice: "First notice." }));
        act(() => {
            vi.advanceTimersByTime(4_000);
        });
        act(() => emit({ notice: "Second notice." }));
        act(() => {
            vi.advanceTimersByTime(4_000);
        });
        expect(screen.getByText("Second notice.")).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(1_000);
        });
        expect(screen.queryByText("Second notice.")).not.toBeInTheDocument();
    });
});

function fakeApplicationStore(): {
    emit(patch: Partial<WebState>): void;
    store: WebStore;
} {
    const domains = new WebTestDomains();
    let state: WebState = { operations: {} };
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) listener();
    };
    const store = {
        domains: domains.domains,
        get state() {
            return state;
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setOverviewActive() {},
        dismissFeedback(kind: "error" | "notice") {
            state =
                kind === "error"
                    ? { ...state, error: undefined }
                    : { ...state, notice: undefined };
            notify();
        },
        refreshAudit: async () => undefined,
        refreshMessages: async () => undefined,
    } as unknown as WebStore;
    return {
        emit: (patch) => {
            state = { ...state, ...patch };
            notify();
        },
        store,
    };
}

function fakeSession(result: {
    authMode?: "none" | "oauth2" | "token";
    check: boolean;
    establish?: boolean;
}): WebSession & {
    authMode: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    establish: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    startOAuth: ReturnType<typeof vi.fn>;
} {
    return {
        authMode: vi.fn(async () => result.authMode ?? "token"),
        check: vi.fn(async () => result.check),
        establish: vi.fn(async () => result.establish ?? false),
        logout: vi.fn(async () => undefined),
        startOAuth: vi.fn(() => undefined),
    };
}

function RouteProbe() {
    const [route, navigate] = useHashRoute();
    return (
        <>
            <output>{webRouteHref(route)}</output>
            <button onClick={() => navigate(pageRoute("goals"))}>Goals</button>
        </>
    );
}

describe("hash routing", () => {
    it("round-trips instance selections, Messages, and Audit hierarchy through bookmarkable URLs", () => {
        const routes: WebRoute[] = [
            { page: "instances", instance: "dev/main" },
            { page: "instances", instance: "dev/main", view: "config" },
            { page: "instances", instance: "dev/main", view: "connections" },
            { page: "messages", view: "contexts" },
            {
                page: "messages",
                view: "thread",
                instance: "dev/main",
                ctxId: "ctx alpha",
            },
            { page: "audit", view: "timeline", scope: { kind: "all" } },
            {
                page: "audit",
                view: "timeline",
                scope: { kind: "instance", instance: "dev/main" },
            },
            {
                page: "audit",
                view: "timeline",
                scope: {
                    kind: "context",
                    instance: "dev/main",
                    ctxId: "ctx alpha",
                },
            },
            {
                page: "audit",
                view: "call",
                instance: "dev/main",
                ctxId: "ctx alpha",
                callId: "call/1",
            },
            {
                page: "audit",
                view: "call",
                instance: "dev/main",
                callId: "call/2",
            },
        ];

        for (const route of routes)
            expect(readHashRoute(webRouteHref(route))).toEqual(route);
    });

    it("rejects retired browser aliases while retaining canonical Audit and Instance routes", () => {
        for (const alias of [
            "#/activity",
            "#/approvals",
            "#/config/dev%2Fmain",
            "#/connections/dev%2Fmain",
        ]) {
            expect(readHashRoute(alias)).toEqual(pageRoute("overview"));
        }
        expect(readHashRoute("#/audit")).toEqual(pageRoute("audit"));
        expect(readHashRoute("#/instances/dev%2Fmain?view=config")).toEqual({
            page: "instances",
            instance: "dev/main",
            view: "config",
        });
        expect(readHashRoute("#/instances/dev%2Fmain?view=connections")).toEqual({
            page: "instances",
            instance: "dev/main",
            view: "connections",
        });
    });

    it("keeps a bookmarkable route and responds to back and forward hash changes", () => {
        window.location.hash = "#/instances";
        render(<RouteProbe />);
        expect(screen.getByText("#/instances")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Goals" }));
        expect(window.location.hash).toBe("#/goals");
        expect(screen.getByText("#/goals")).toBeInTheDocument();

        window.location.hash = "#/audit/context/demo/ctx-a";
        fireEvent(window, new HashChangeEvent("hashchange"));
        expect(
            screen.getByText("#/audit/context/demo/ctx-a"),
        ).toBeInTheDocument();
        window.location.hash = "#/messages/demo/ctx-a";
        fireEvent(window, new PopStateEvent("popstate"));
        expect(screen.getByText("#/messages/demo/ctx-a")).toBeInTheDocument();
    });
});
