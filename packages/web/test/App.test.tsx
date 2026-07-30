import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
        vi.unstubAllGlobals();
    });

    it("boots auth=none anonymously before creating clients", async () => {
        const session = fakeSession({ check: false, establish: true });
        const createClients = vi.fn(fakeClients);

        render(<App createClients={createClients} session={session} />);

        expect(
            await screen.findByRole("heading", { name: "Overview" }),
        ).toBeInTheDocument();
        expect(session.establish).toHaveBeenCalledWith();
        expect(createClients).toHaveBeenCalledOnce();
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

    it("supports mobile bottom and desktop navigation", async () => {
        render(
            <App
                createClients={fakeClients}
                session={fakeSession({ check: true })}
            />,
        );
        await screen.findByRole("heading", { name: "Overview" });

        const instances = screen.getAllByRole("button", { name: "Instances" });
        expect(instances).toHaveLength(2);
        fireEvent.click(instances[0]!);
        fireEvent.click(await screen.findByText("demo"));
        expect(
            await screen.findByText("Back to instances"),
        ).toBeInTheDocument();
    });
});

function fakeSession(result: {
    check: boolean;
    establish?: boolean;
}): WebSession & {
    check: ReturnType<typeof vi.fn>;
    establish: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
} {
    return {
        check: vi.fn(async () => result.check),
        establish: vi.fn(async () => result.establish ?? false),
        logout: vi.fn(async () => undefined),
    };
}

function fakeClients(): WebClients {
    const stream = {
        close() {},
        next: async () => await new Promise<never>(() => undefined),
    } as unknown as WebRuntimeStream;
    return {
        close() {},
        reconnect: async () => undefined,
        service: {
            hello: async () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            }),
            status: async () => ({ instanceCount: 1, ok: true }),
        },
        instance: {
            list: async () => [{ mcpEnabled: true, name: "demo", snapshot }],
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
            listApprovals: async () => [],
            getApproval: async () => {
                throw new Error("Not used.");
            },
            decideApproval: async () => {
                throw new Error("Not used.");
            },
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
