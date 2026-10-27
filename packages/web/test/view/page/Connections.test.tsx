import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asInstanceName, type ConfigView } from "@portable-devshell/shared";

import { deferred } from "../../support/BetaMatrixHarness.js";
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

    it("locks all connection fields throughout Save validation and persists exactly the validated draft", async () => {
        const { domains, store } = setup();
        const validation = deferred<boolean>();
        const validate = vi.spyOn(store, "validateConfig").mockReturnValue(validation.promise);
        const persistence = deferred<boolean>();
        const update = vi.spyOn(store, "updateConfig").mockReturnValue(persistence.promise);
        renderConnections(store, domains, "reverse-one");
        const card = screen.getByRole("heading", { name: "[Global] MCP listener" }).parentElement!;
        const port = within(card).getByLabelText("Listen port");
        fireEvent.change(port, { target: { value: "3200" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(port).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        expect(update).not.toHaveBeenCalled();
        await act(async () => validation.resolve(true));
        await waitFor(() => expect(update).toHaveBeenCalledOnce());
        expect(validate.mock.calls[0]![0].mcp).toEqual(expect.objectContaining({ listenPort: 3200 }));
        expect(update.mock.calls[0]![0].mcp).toEqual(expect.objectContaining({ listenPort: 3200 }));
        expect(port).toBeDisabled();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        await act(async () => persistence.resolve(true));
        await waitFor(() => expect(port).toBeEnabled());
    });

    it("preserves the draft and blocks a stale Save when server connection settings change during validation", async () => {
        const { domains, store } = setup();
        const validation = deferred<boolean>();
        vi.spyOn(store, "validateConfig").mockReturnValue(validation.promise);
        const update = vi.spyOn(store, "updateConfig");
        renderConnections(store, domains, "reverse-one");
        const card = screen.getByRole("heading", { name: "[Global] MCP listener" }).parentElement!;
        const port = within(card).getByLabelText("Listen port");
        fireEvent.change(port, { target: { value: "3200" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        const server = connectionView();
        server.mcp.listenPort = 3300;
        act(() => domains.setConfig(server));
        await act(async () => validation.resolve(true));
        expect(update).not.toHaveBeenCalled();
        expect(port).toHaveValue("3200");
        expect(screen.getByText(/changed during validation/u)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(port).toHaveValue("3300");
    });

    it("preserves drafts through unrelated revisions and exposes relevant conflicts with a Cancel recovery", () => {
        const { domains, store } = setup();
        renderConnections(store, domains, "reverse-one");
        const card = screen.getByRole("heading", { name: "[Global] MCP listener" }).parentElement!;
        const port = within(card).getByLabelText("Listen port");
        fireEvent.change(port, { target: { value: "3200" } });
        const unrelated = connectionView();
        unrelated.control.logLevel = "debug";
        act(() => domains.setConfig(unrelated));
        expect(port).toHaveValue("3200");
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
        expect(screen.queryByText(/settings changed on the server/u)).not.toBeInTheDocument();
        const changed = connectionView();
        changed.mcp.listenPort = 3300;
        act(() => domains.setConfig(changed));
        expect(port).toHaveValue("3200");
        expect(screen.getByRole("alert")).toHaveTextContent("Your unsaved draft is preserved");
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(port).toHaveValue("3300");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        changed.mcp.listenPort = 3400;
        act(() => domains.setConfig(structuredClone(changed)));
        expect(port).toHaveValue("3400");
    });

    it("allows typing OAuth scopes a separator at a time and saves the parsed list", async () => {
        const { domains, store } = setup();
        const update = vi.spyOn(store, "updateConfig");
        renderConnections(store, domains);
        const card = screen.getByRole("heading", { name: "[Global] Web UI" }).parentElement!;
        fireEvent.change(within(card).getByLabelText("Auth"), { target: { value: "oauth2" } });
        fireEvent.change(within(card).getByLabelText("OAuth resource"), { target: { value: "web" } });
        const scopes = within(card).getByLabelText("OAuth scopes");
        fireEvent.change(scopes, { target: { value: "read" } });
        fireEvent.change(scopes, { target: { value: "read," } });
        expect(scopes).toHaveValue("read,");
        fireEvent.change(scopes, { target: { value: "read,write" } });
        fireEvent.blur(scopes);
        expect(scopes).toHaveValue("read, write");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
            web: expect.objectContaining({ oauth2: expect.objectContaining({ requiredScopes: ["read", "write"] }) }),
        })));
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

    it("copies only the enrollment command and shows code expiry", async () => {
        const { domains, store } = setup();
        const command = "devshell-worker enroll --controller https://controller.test --device-code issued";
        vi.spyOn(store, "createReverseCode").mockResolvedValue(
            `${command}\nCode expires: 2099-01-01T00:00:00.000Z`,
        );
        const writeText = vi.fn(async () => undefined);
        const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
        Object.defineProperty(navigator, "clipboard", {
            configurable: true, value: { writeText },
        });
        try {
            renderConnections(store, domains, "reverse-one");
            fireEvent.click(screen.getByRole("button", { name: "Generate enrollment code" }));
            expect(await screen.findByText(/Expires in/u)).toBeInTheDocument();
            fireEvent.click(screen.getByRole("button", { name: "Copy enrollment command" }));
            await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
            expect(screen.getByText("Enrollment command copied.")).toBeInTheDocument();
        } finally {
            if (original === undefined) Reflect.deleteProperty(navigator, "clipboard");
            else Object.defineProperty(navigator, "clipboard", original);
        }
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
                }),
            ),
        );
        expect(updateConfig.mock.calls[0]?.[0]).toEqual({ mcp: { listenPort: 3200 } });
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
