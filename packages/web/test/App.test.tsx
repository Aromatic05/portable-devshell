import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type InstanceSnapshot,
} from "@portable-devshell/shared/browser";

import type { WebClients, WebRuntimeStream } from "../src/client/WebClients.js";
import type { WebSession } from "../src/session/WebSession.js";
import { App } from "../src/views/App.js";

const snapshot: InstanceSnapshot = {
    connectionState: "connected",
    daemonState: "running",
    lastSeq: 1,
    name: asInstanceName("demo"),
    ready: true,
    status: "ready",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("authenticated application shell", () => {
    it("keeps the default browser session stable across React renders", async () => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(null, { status: 204 }),
        );
        vi.stubGlobal("fetch", request);
        const createClients = vi.fn(fakeClients);

        render(<App createClients={createClients} />);

        expect(
            await screen.findByRole("heading", { name: "Overview" }),
        ).toBeInTheDocument();
        await waitFor(() => expect(createClients).toHaveBeenCalledOnce());
        expect(request).toHaveBeenCalledOnce();
    });

    it("boots auth=none anonymously before creating clients", async () => {
        const session = fakeSession({ authMode: "none", check: false, establish: true });
        const createClients = vi.fn(fakeClients);

        render(<App createClients={createClients} session={session} />);

        expect(
            await screen.findByRole("heading", { name: "Overview" }),
        ).toBeInTheDocument();
        expect(session.establish).toHaveBeenCalledWith();
        expect(createClients).toHaveBeenCalledOnce();
    });

    it("shows token login without submitting an empty bearer token", async () => {
        const session = fakeSession({ authMode: "token", check: false });
        render(<App createClients={fakeClients} session={session} />);

        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
        expect(session.establish).not.toHaveBeenCalled();
    });

    it("redirects to the OAuth start endpoint when auth=oauth2", async () => {
        const session = fakeSession({ authMode: "oauth2", check: false, establish: false });
        render(<App createClients={fakeClients} session={session} />);

        await waitFor(() => expect(session.startOAuth).toHaveBeenCalledOnce());
        expect(session.establish).not.toHaveBeenCalled();
        expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    });

    it("keeps a submitted token in component state only and logs out", async () => {
        const session = fakeSession({ check: false, establish: false });
        render(<App createClients={fakeClients} session={session} />);

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
        const clients = fakeClients();
        const close = vi.fn();
        clients.close = close;
        clients.service.hello = vi.fn()
            .mockRejectedValueOnce(new Error("Control offline"))
            .mockResolvedValue({ capabilities: ["request", "stream", "streamResume"], protocolVersion: 1 });
        const createClients = vi.fn(() => clients);

        render(<App createClients={createClients} session={session} />);
        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockResolvedValue(false);
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        await waitFor(() => expect(session.check.mock.calls.length).toBeGreaterThanOrEqual(2));

        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
        expect(close).toHaveBeenCalledOnce();
        expect(session.check.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("makes reconnect single-flight while checking the session", async () => {
        let releaseCheck!: (available: boolean) => void;
        const session = fakeSession({ check: true });
        const clients = fakeClients();
        clients.service.hello = vi.fn()
            .mockRejectedValueOnce(new Error("Control offline"))
            .mockResolvedValue({ capabilities: ["request", "stream", "streamResume"], protocolVersion: 1 });
        render(<App createClients={() => clients} session={session} />);

        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockImplementation(async () => await new Promise<boolean>((resolve) => { releaseCheck = resolve; }));
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        expect(screen.getByRole("button", { name: "Reconnecting…" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Reconnecting…" }));
        releaseCheck(true);

        await waitFor(() => expect(session.check).toHaveBeenCalledTimes(2));
    });

    it("ignores a superseded bootstrap after the session changes", async () => {
        let resolveFirstCheck!: (available: boolean) => void;
        const first: WebSession = {
            authMode: async () => "token",
            check: async () => await new Promise<boolean>((resolve) => { resolveFirstCheck = resolve; }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const second = fakeSession({ check: false, establish: false });
        const createClients = vi.fn(fakeClients);
        const view = render(<App createClients={createClients} session={first} />);

        view.rerender(<App createClients={createClients} session={second} />);
        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
        resolveFirstCheck(true);
        await Promise.resolve();

        expect(createClients).not.toHaveBeenCalled();
    });

    it("does not recreate clients after an unmounted bootstrap resolves", async () => {
        let resolveCheck!: (available: boolean) => void;
        const session: WebSession = {
            authMode: async () => "token",
            check: async () => await new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const createClients = vi.fn(fakeClients);
        const view = render(<App createClients={createClients} session={session} />);

        view.unmount();
        resolveCheck(true);
        await Promise.resolve();

        expect(createClients).not.toHaveBeenCalled();
    });

    it("makes logout single-flight while the session revocation is pending", async () => {
        let releaseLogout!: () => void;
        const session = fakeSession({ check: true });
        session.logout.mockImplementation(async () => await new Promise<void>((resolve) => { releaseLogout = resolve; }));
        render(<App createClients={fakeClients} session={session} />);

        const logout = await screen.findByRole("button", { name: "Log out" });
        fireEvent.click(logout);
        expect(screen.getByRole("button", { name: "Logging out…" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Logging out…" }));
        releaseLogout();

        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
        expect(session.logout).toHaveBeenCalledOnce();
    });

    it("disables runtime actions while logout is pending", async () => {
        let releaseLogout!: () => void;
        const session = fakeSession({ check: true });
        session.logout.mockImplementation(async () => await new Promise<void>((resolve) => {
            releaseLogout = resolve;
        }));
        render(<App createClients={fakeClients} session={session} />);
        const instances = await screen.findAllByRole("button", { name: /Instances/ });
        fireEvent.click(instances[0]!);
        fireEvent.click(await screen.findByText("demo"));
        const stop = await screen.findByRole("button", { name: "Stop" });
        expect(stop).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Log out" }));

        expect(stop).toBeDisabled();
        releaseLogout();
        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });

    it("shows a failed logout without leaving the application", async () => {
        const session = fakeSession({ check: true });
        session.logout.mockRejectedValue(new Error("Session revocation failed"));
        render(<App createClients={fakeClients} session={session} />);

        fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

        expect(await screen.findByText("Session revocation failed")).toHaveAttribute("role", "alert");
        expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    it("shows a session verification error when reconnect checking fails", async () => {
        const session = fakeSession({ check: true });
        const clients = fakeClients();
        clients.service.hello = vi.fn()
            .mockRejectedValueOnce(new Error("Control offline"))
            .mockResolvedValue({ capabilities: ["request", "stream", "streamResume"], protocolVersion: 1 });
        render(<App createClients={() => clients} session={session} />);

        await screen.findByRole("button", { name: "Reconnect" });
        session.check.mockRejectedValue(new Error("Session unavailable"));
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

        expect(await screen.findByRole("alert")).toBeInTheDocument();
        session.check.mockResolvedValue(true);
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("clears the ready store before bootstrapping a replacement session", async () => {
        let resolveCheck!: (available: boolean) => void;
        const initialClients = fakeClients();
        const close = vi.fn();
        initialClients.close = close;
        const initial = fakeSession({ check: true });
        const replacement: WebSession = {
            authMode: async () => "token",
            check: async () => await new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
            establish: async () => false,
            logout: async () => undefined,
            startOAuth: () => undefined,
        };
        const createClients = vi.fn(() => initialClients);
        const view = render(<App createClients={createClients} session={initial} />);

        await screen.findByRole("button", { name: "Log out" });
        view.rerender(<App createClients={createClients} session={replacement} />);

        expect(close).toHaveBeenCalledOnce();
        resolveCheck(false);
        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });

    it("supports mobile bottom and desktop navigation", async () => {
        window.location.hash = "#/overview";
        render(
            <App
                createClients={fakeClients}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });

        const instances = screen.getAllByRole("button", { name: /Instances/ });
        expect(instances).toHaveLength(2);
        fireEvent.click(instances[0]!);
        fireEvent.click(await screen.findByText("demo"));
        expect(await screen.findByRole("heading", { name: "demo", level: 3 })).toBeInTheDocument();
    });

    it("uses Overview summary links as bookmarkable navigation", async () => {
        window.location.hash = "#/overview";
        render(<App createClients={fakeClients} session={fakeSession({ check: true })} />);

        const activity = await screen.findByRole("link", { name: "Recent tool calls" });
        expect(activity).toHaveAttribute("href", "#/activity");
        fireEvent.click(activity);
        expect(await screen.findByRole("heading", { name: "Tool Calls" })).toBeInTheDocument();
        expect(window.location.hash).toBe("#/activity");
    });
});

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

function fakeClients(): WebClients {
    const stream = {
        close() {},
        next: async () => await new Promise<never>(() => undefined),
    } as unknown as WebRuntimeStream;
    return {
        close() {},
        onTransportClose: () => () => undefined,
        reconnect: async () => undefined,
        artifact: {} as WebClients["artifact"],
        config: {} as WebClients["config"],
        reverse: {} as WebClients["reverse"],
        terminal: {} as WebClients["terminal"],
        service: {
            hello: async () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            }),
            ping: async () => ({ pong: true }),
            restart: async () => ({ accepted: true }),
            status: async () => ({ instanceCount: 1, ok: true }),
        },
        instance: {
            list: async () => [{ mcpEnabled: true, name: "demo", snapshot }],
        } as WebClients["instance"],
        overview: {
            get: async () => ({ activity: [], alerts: [], controller: { pid: 1, uptimeSeconds: 1 }, counts: { activeTodos: 0, failedCalls24h: 0, instancesAttention: 0, instancesCritical: 0, instancesReady: 1, instancesTotal: 1, pendingApprovals: 0 }, generatedAt: "2026-07-31T00:00:00Z", health: "healthy", instances: [], todos: [] }),
        },
        runtime: {
            snapshot: async () => ({ lastSeq: 1, snapshot }),
            refresh: async () => ({ lastSeq: 1, snapshot }),
            readLogs: async () => [],
            start: async () => snapshot,
            stop: async () => snapshot,
            subscribe: async () => stream,
        },
        tool: {
            listCalls: async () => [],
            listApprovals: async () => [],
            getApproval: async () => {
                throw new Error("Not used.");
            },
            decideApproval: async () => {
                throw new Error("Not used.");
            },
        },
        contextMessage: {
            list: async () => [],
            queue: async (_instance, input) => ({
                createdAt: "2026-07-31T00:00:00Z",
                id: "message",
                instance: "demo",
                status: "pending",
                ...input,
            }),
        },
        todo: {
            get: async () => ({
                lastSeq: 1,
                todo: { items: [], revision: 1, summary: { completed: 0, total: 0 } },
            }),
        },
        mcp: {
            status: async () => ({ authMode: "none", oauthReady: false, running: true }),
            listApprovals: async () => [],
            decideApproval: async () => {
                throw new Error("Not used.");
            },
        },
    };
}
