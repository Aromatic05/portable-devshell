import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asInstanceName, type ConfigView } from "@portable-devshell/shared";

import { Connections } from "../../../src/view/page/Connections.js";
import { WebStore } from "../../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";

function setup({
    config = connectionView(),
    instances = [reverseInstance()],
}: {
    config?: unknown;
    instances?: readonly unknown[];
} = {}) {
    const domains = new WebTestDomains();
    domains.setConfig(config);
    domains.setInstances(instances);
    domains.setMcp({
        approvals: [
            {
                approvalId: "oauth-1",
                clientId: "client-1",
                clientName: "Example Client",
                createdAt: "2026-09-16T00:00:00.000Z",
                expiresAt: "2026-09-16T01:00:00.000Z",
                kind: "authorization",
                redirectUris: ["https://client.example.test/callback"],
                requestedResources: ["mcp"],
                requestedScopes: ["mcp"],
                status: "pending",
            },
        ],
        status: {
            authMode: "oauth2",
            oauthReady: true,
            running: true,
        },
    });
    const store = new WebStore(domains.domains);
    return { domains, store };
}

function renderConnections(
    store: WebStore,
    domains: WebTestDomains,
    instance?: string,
) {
    return render(
        withWebDomains(
            domains,
            <Connections disabled={false} instance={instance} store={store} />,
        ),
    );
}

describe("Web Connections", () => {
    it("validates and saves endpoint changes, then exposes Control restart", async () => {
        const { domains, store } = setup();
        const validateConfig = vi.spyOn(store, "validateConfig");
        const updateConfig = vi.spyOn(store, "updateConfig");
        renderConnections(store, domains, "reverse-one");

        const mcpCard = screen.getByRole("heading", {
            name: "[Global] MCP listener",
        }).parentElement!;
        fireEvent.change(within(mcpCard).getByLabelText("Listen port"), {
            target: { value: "3200" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(validateConfig).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(updateConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    mcp: expect.objectContaining({ listenPort: 3200 }),
                }),
            ),
        );
        expect(
            screen.getByRole("button", { name: "Restart Control" }),
        ).toBeEnabled();
    });

    it("keeps OAuth approval controls out of Connections and exposes reverse enrollment and token actions", async () => {
        const { domains, store } = setup();
        const createReverseCode = vi
            .spyOn(store, "createReverseCode")
            .mockResolvedValue("devshell-worker enroll --device-code code");
        renderConnections(store, domains, "reverse-one");

        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
        expect(
            screen.queryByRole("link", { name: /approval/iu }),
        ).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Generate enrollment code" }),
        );
        await waitFor(() =>
            expect(
                screen.getByText(/devshell-worker enroll/u),
            ).toBeInTheDocument(),
        );
        expect(createReverseCode).toHaveBeenCalledWith("reverse-one");

        expect(
            screen.queryByRole("button", { name: "Rotate device token" }),
        ).toBeNull();
        expect(
            screen.getByText(/instance does not need to be recreated/iu),
        ).toBeInTheDocument();
    });

    it("manages OAuth approval mode and rotates a masked token", async () => {
        const config = connectionView();
        config.mcp.oauth2 = { approval: "token", token: "********" };
        const { domains, store } = setup({ config });
        const updateConfig = vi.spyOn(store, "updateConfig");
        renderConnections(store, domains);

        const oauth = screen.getByRole("heading", {
            name: "OAuth runtime",
        }).parentElement!;
        expect(within(oauth).getByText("token")).toBeInTheDocument();
        expect(within(oauth).getByText("configured")).toBeInTheDocument();

        fireEvent.click(
            within(oauth).getByRole("button", {
                name: "Rotate approval token",
            }),
        );
        await waitFor(() => expect(updateConfig).toHaveBeenCalledOnce());
        const patch = updateConfig.mock.calls[0]?.[0]?.mcp;
        expect(patch?.oauth2?.approval).toBe("token");
        expect(patch?.oauth2?.token).toMatch(/^ds_[0-9a-f]{64}$/u);
        await waitFor(() =>
            expect(
                within(oauth).getByText(/^ds_[0-9a-f]{64}$/u),
            ).toBeInTheDocument(),
        );
    });

    it("keeps global connection controls available without any instances", async () => {
        const { domains, store } = setup({ instances: [] });
        const validateConfig = vi.spyOn(store, "validateConfig");
        const updateConfig = vi.spyOn(store, "updateConfig");
        renderConnections(store, domains);

        expect(
            screen.getByRole("heading", { name: "[Global] MCP listener" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "[Global] Web UI" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "OAuth runtime" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: "[Instance] MCP" }),
        ).toBeNull();

        const mcpCard = screen.getByRole("heading", {
            name: "[Global] MCP listener",
        }).parentElement!;
        fireEvent.change(within(mcpCard).getByLabelText("Listen port"), {
            target: { value: "3200" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(validateConfig).toHaveBeenCalledOnce());
        await waitFor(() =>
            expect(updateConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    mcp: expect.objectContaining({ listenPort: 3200 }),
                    web: expect.any(Object),
                }),
            ),
        );
        expect(updateConfig.mock.calls[0]?.[0]).not.toHaveProperty("instance");
    });
});

function reverseInstance() {
    return {
        mcpEnabled: true,
        name: "reverse-one",
        snapshot: {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 1,
            name: asInstanceName("reverse-one"),
            ready: true,
            status: "ready",
        },
    };
}

function connectionView(): ConfigView {
    return {
        control: {
            artifactDirectTransfer: true,
            logLevel: "info",
        },
        instances: [
            {
                enabled: true,
                extensions: { model: ["instance"] },
                mcp: {
                    auth: { mode: "none" },
                    contextMode: "explicit",
                    enabled: true,
                    path: "/reverse-one/mcp",
                },
                name: "reverse-one",
                provider: "reverse",
                security: {
                    effectiveMode: "disabled",
                    mode: "disabled",
                },
                workspace: { enabled: true },
            },
        ],
        mcp: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3100,
            oauth2: { approval: "tui" },
            publicBaseUrl: "https://mcp.example.test",
        },
        restartControlRequired: true,
        web: {
            auth: "none",
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3101,
            publicBaseUrl: "https://web.example.test",
        },
    };
}
