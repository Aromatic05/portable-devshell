import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { Instances } from "../../../src/view/page/Instances.js";
import type { WebStore } from "../../../src/state/Store.js";

function reverseStore(availability: "offline" | "online"): WebStore {
    const online = availability === "online";
    return {
        state: {
            connection: "online",
            operations: {},
            readModel: {
                ...createInitialControlReadModelState(),
                instances: [
                    {
                        mcpEnabled: true,
                        name: "reverse-mac",
                        snapshot: {
                            connectionState: online
                                ? "connected"
                                : "disconnected",
                            daemonState: online ? "running" : "stopped",
                            lastSeq: 1,
                            name: asInstanceName("reverse-mac"),
                            ready: online,
                            reverse: {
                                availability,
                                enrollmentState: "enrolled",
                                managementMode: "selfManaged",
                                ...(online
                                    ? { transport: "sse" as const }
                                    : {}),
                            },
                            status: online ? "ready" : "stopped",
                        },
                    },
                ],
            },
        },
        refreshInstance: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
    } as unknown as WebStore;
}

function localStore(status: "ready" | "stopped"): WebStore {
    const ready = status === "ready";
    return {
        state: {
            connection: "online",
            operations: {},
            readModel: {
                ...createInitialControlReadModelState(),
                artifactShares: [
                    {
                        blake3: "share-blake3",
                        bytes: 1024,
                        downloadName: "report.pdf",
                        expiresAtMs: Date.now() + 60_000,
                        mediaType: "application/pdf",
                        shareId: "share-local-one",
                        source: {
                            instance: "local-one",
                            path: "report.pdf",
                            workspace: "/workspace",
                        },
                        state: "active",
                        url: "https://example.test/share-local-one",
                    },
                ],
                artifactTransfers: [
                    {
                        createdAt: "2026-09-16T00:00:00.000Z",
                        source: {
                            instance: "local-one",
                            path: "build.tar",
                            workspace: "/workspace",
                        },
                        status: "transferring",
                        target: {
                            instance: "remote-one",
                            path: "build.tar",
                            workspace: "/remote",
                        },
                        totalBytes: 4096,
                        transferId: "transfer-local-one",
                        transferredBytes: 1024,
                        updatedAt: "2026-09-16T00:00:01.000Z",
                    },
                ],
                configView: {
                    instances: [
                        {
                            enabled: true,
                            name: "local-one",
                            provider: "local",
                        },
                    ],
                },
                instances: [
                    {
                        mcpEnabled: true,
                        name: "local-one",
                        snapshot: {
                            connectionState: ready
                                ? "connected"
                                : "disconnected",
                            daemonState: ready ? "running" : "stopped",
                            lastSeq: 1,
                            name: asInstanceName("local-one"),
                            ready,
                            status,
                        },
                    },
                ],
            },
        },
        cancelArtifactTransfer: vi.fn(async () => true),
        createInstance: vi.fn(async () => ({ succeeded: true })),
        deleteInstance: vi.fn(async () => true),
        getInstanceCreateSchema: vi.fn(async () => ({
            container: {
                defaultMode: "existingImage" as const,
                modes: [
                    "preset",
                    "dockerfile",
                    "compose",
                    "existingImage",
                    "existingStoppedContainer",
                ] as const,
                presets: [],
            },
            defaultEnabled: true,
            defaultMcpContextMode: "explicit" as const,
            defaultMcpEnabled: true,
            defaultModelExtensions: ["instance"],
            defaultProvider: "local" as const,
            defaultSecurityMode: "disabled" as const,
            providers: ["local", "ssh", "docker", "podman", "reverse"] as const,
        })),
        refreshInstance: vi.fn(async () => undefined),
        refreshArtifacts: vi.fn(async () => undefined),
        restart: vi.fn(async () => true),
        revokeArtifactShare: vi.fn(async () => true),
        setInstanceEnabled: vi.fn(async () => true),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        validateInstanceCreate: vi.fn(async (draft) => draft),
    } as unknown as WebStore;
}

it("does not offer Start or Stop for an offline self-managed reverse instance", () => {
    render(<Instances store={reverseStore("offline")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(
        screen.queryByRole("button", { name: "Start" }),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/self-managed.*offline/iu)).toBeInTheDocument();
});

it("does not offer Control lifecycle actions for an online self-managed reverse instance", () => {
    render(<Instances store={reverseStore("online")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(
        screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByRole("button", { name: "Start" }),
    ).not.toBeInTheDocument();
    expect(
        screen.getByText(/self-managed.*remote machine/iu),
    ).toBeInTheDocument();
});

it("starts a stopped local instance directly and marks the selected card", () => {
    const store = localStore("stopped");
    render(<Instances store={store} />);
    const card = screen.getByRole("button", { name: /local-one/u });
    fireEvent.click(card);

    expect(card).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(store.start).toHaveBeenCalledWith("local-one");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("creates an instance through schema defaults and server validation", async () => {
    const store = localStore("ready");
    render(<Instances store={store} />);

    fireEvent.click(screen.getByRole("button", { name: "New instance" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "web-created" } });

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
        expect(store.validateInstanceCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                enabled: true,
                name: "web-created",
                provider: "local",
            }),
        ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
        expect(store.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "web-created",
                provider: "local",
            }),
        ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
        "Instance created successfully.",
    );
});

it("keeps confirmation for stopping a running local instance", () => {
    const store = localStore("ready");
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(store.stop).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(store.stop).toHaveBeenCalledWith("local-one");
});

it("offers restart, disable, delete, and refresh actions for a managed instance", async () => {
    const store = localStore("ready");
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
        expect(store.refreshInstance).toHaveBeenCalledWith("local-one"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    let dialog = screen.getByRole("dialog", { name: "Confirm restart" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() =>
        expect(store.restart).toHaveBeenCalledWith("local-one"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    dialog = screen.getByRole("dialog", { name: "Confirm disable" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
        expect(store.setInstanceEnabled).toHaveBeenCalledWith(
            "local-one",
            false,
        ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = screen.getByRole("dialog", { name: "Confirm delete" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
        expect(store.deleteInstance).toHaveBeenCalledWith("local-one"),
    );
});

it("shows per-instance artifact activity and confirms revoke and cancel", async () => {
    const store = localStore("ready");
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));

    const activity = screen.getByRole("region", { name: "Artifact activity" });
    expect(
        within(activity).getByText(/Share share-lo · report\.pdf/u),
    ).toBeInTheDocument();
    expect(
        within(activity).getByText(/Transfer transfer · transferring/u),
    ).toBeInTheDocument();

    fireEvent.click(
        within(activity).getByRole("button", { name: "Refresh artifacts" }),
    );
    await waitFor(() => expect(store.refreshArtifacts).toHaveBeenCalledOnce());

    fireEvent.click(
        within(activity).getByRole("button", { name: "Revoke share" }),
    );
    let dialog = screen.getByRole("dialog", { name: "Confirm revoke" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
        expect(store.revokeArtifactShare).toHaveBeenCalledWith(
            "share-local-one",
        ),
    );

    fireEvent.click(
        within(activity).getByRole("button", { name: "Cancel transfer" }),
    );
    dialog = screen.getByRole("dialog", { name: "Confirm cancel transfer" });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Cancel transfer" }),
    );
    await waitFor(() =>
        expect(store.cancelArtifactTransfer).toHaveBeenCalledWith(
            "transfer-local-one",
        ),
    );
});

it("enables a disabled instance without a confirmation dialog", () => {
    const store = localStore("stopped");
    const instances = store.state.readModel.configView!.instances as Array<
        Record<string, unknown>
    >;
    instances[0]!.enabled = false;
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(store.setInstanceEnabled).toHaveBeenCalledWith("local-one", true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps a failed Stop confirmation open and shows the failure in place", async () => {
    const store = localStore("ready");
    Object.assign(store.state, { error: "Stop failed." });
    store.stop = vi.fn(async () => false) as unknown as WebStore["stop"];
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(
        within(screen.getByRole("dialog", { name: "Confirm stop" })).getByRole(
            "button",
            { name: "Stop" },
        ),
    );

    await waitFor(() => expect(store.stop).toHaveBeenCalledOnce());
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Stop failed.");
});

it("shows instance refresh failures beside the selected detail instead of failing silently", async () => {
    const store = localStore("ready");
    store.refreshInstance = vi.fn(async () => {
        throw new Error("Instance refresh failed.");
    });
    render(<Instances store={store} />);

    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
        "Instance refresh failed.",
    );
    expect(
        screen.getByRole("heading", { name: "local-one", level: 3 }),
    ).toBeInTheDocument();
});
