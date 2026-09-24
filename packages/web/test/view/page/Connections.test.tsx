import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";

import { Connections } from "../../../src/view/page/Connections.js";
import type { WebState } from "../../../src/state/Model.js";
import type { WebStore } from "../../../src/state/Store.js";

describe("Web Connections", () => {
    it("validates and saves endpoint changes, then exposes Control restart", async () => {
        const state = connectionState();
        const store = {
            state,
            updateConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
            restartControl: vi.fn(async () => true),
            decideOAuthApproval: vi.fn(async () => true),
            createReverseCode: vi.fn(
                async () => "devshell-worker enroll --device-code code",
            ),
            rotateReverseToken: vi.fn(async () => true),
            revokeReverseToken: vi.fn(async () => true),
        } as unknown as WebStore;
        render(
            <Connections
                disabled={false}
                instance="reverse-one"
                state={state}
                store={store}
            />,
        );

        const mcpCard = screen.getByRole("heading", {
            name: "[Global] MCP listener",
        }).parentElement!;
        fireEvent.change(within(mcpCard).getByLabelText("Listen port"), {
            target: { value: "3200" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(store.validateConfig).toHaveBeenCalledTimes(1),
        );
        await waitFor(() =>
            expect(store.updateConfig).toHaveBeenCalledWith(
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
        const state = connectionState();
        const store = {
            state,
            updateConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
            restartControl: vi.fn(async () => true),
            createReverseCode: vi.fn(
                async () => "devshell-worker enroll --device-code code",
            ),
            rotateReverseToken: vi.fn(async () => true),
            revokeReverseToken: vi.fn(async () => true),
        } as unknown as WebStore;
        render(
            <Connections
                disabled={false}
                instance="reverse-one"
                state={state}
                store={store}
            />,
        );

        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
        expect(
            screen.queryByRole("link", { name: /approval/iu }),
        ).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Create enrollment code" }),
        );
        await waitFor(() =>
            expect(
                screen.getByText(/devshell-worker enroll/u),
            ).toBeInTheDocument(),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Rotate device token" }),
        );
        const rotate = screen.getByRole("dialog", { name: "Confirm rotate" });
        expect(
            within(rotate).getByRole("button", { name: "Cancel" }),
        ).toHaveFocus();
        fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
        await waitFor(() =>
            expect(store.rotateReverseToken).toHaveBeenCalledWith(
                "reverse-one",
            ),
        );
        expect(rotate).not.toBeInTheDocument();
    });


    it("manages OAuth approval mode and rotates a masked token", async () => {
        const state = connectionState();
        state.readModel.configView!.mcp.oauth2 = {
            approval: "token",
            token: "********",
        };
        const updateMcpConfig = vi.fn(async () => true);
        const store = {
            state,
            updateConfig: vi.fn(async () => true),
            updateMcpConfig,
            validateConfig: vi.fn(async () => true),
            restartControl: vi.fn(async () => true),
        } as unknown as WebStore;
        render(<Connections disabled={false} state={state} store={store} />);

        const oauth = screen.getByRole("heading", { name: "OAuth runtime" })
            .parentElement!;
        expect(within(oauth).getByText("token")).toBeInTheDocument();
        expect(within(oauth).getByText("configured")).toBeInTheDocument();

        fireEvent.click(
            within(oauth).getByRole("button", { name: "Rotate approval token" }),
        );
        await waitFor(() => expect(updateMcpConfig).toHaveBeenCalledOnce());
        const patch = updateMcpConfig.mock.calls[0]?.[0];
        expect(patch?.oauth2?.approval).toBe("token");
        expect(patch?.oauth2?.token).toMatch(/^ds_[0-9a-f]{64}$/u);
        await waitFor(() =>
            expect(within(oauth).getByText(/^ds_[0-9a-f]{64}$/u)).toBeInTheDocument(),
        );
    });

    it("keeps global connection controls available without any instances", async () => {
        const state = connectionState();
        state.readModel.configView!.instances = [];
        state.readModel.instanceState = {};
        const store = {
            state,
            updateConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
            restartControl: vi.fn(async () => true),
        } as unknown as WebStore;
        render(<Connections disabled={false} state={state} store={store} />);

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

        await waitFor(() =>
            expect(store.validateConfig).toHaveBeenCalledOnce(),
        );
        await waitFor(() =>
            expect(store.updateConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    mcp: expect.objectContaining({ listenPort: 3200 }),
                    web: expect.any(Object),
                }),
            ),
        );
        expect(store.updateConfig.mock.calls[0]?.[0]).not.toHaveProperty(
            "instance",
        );
    });
});

function connectionState(): WebState {
    return {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            configView: {
                control: {
                    artifactDirectTransfer: true,
                    logLevel: "info",
                },
                instances: [
                    {
                        enabled: true,
                        extensions: { model: ["instance"] },
                        mcp: {
                            auth: "none",
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
            },
            instanceState: {
                "reverse-one": {
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 1,
                        name: asInstanceName("reverse-one"),
                        ready: true,
                        status: "ready",
                    },
                },
            },
            mcpStatus: {
                authMode: "oauth2",
                oauthReady: true,
                running: true,
            },
            oauthApprovals: [
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
        },
    } as WebState;
}
