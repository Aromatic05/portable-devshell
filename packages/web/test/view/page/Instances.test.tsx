import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { asInstanceName } from "@portable-devshell/shared";
import { expect, it, vi } from "vitest";

import { Instances } from "../../../src/view/page/Instances.js";
import { WebStore } from "../../../src/state/Store.js";
import {
    WebTestDomains,
    withWebDomains,
} from "../../support/DomainHarness.js";

import { deferred } from "../../support/BetaMatrixHarness.js";

function setup(
    options: {
        artifacts?: { shares?: readonly unknown[]; transfers?: readonly unknown[] };
        config?: unknown;
        instances?: readonly unknown[];
    } = {},
) {
    const domains = new WebTestDomains();
    domains.setInstances(options.instances ?? []);
    if (options.config !== undefined) domains.setConfig(options.config);
    if (options.artifacts !== undefined)
        domains.setArtifacts(options.artifacts as never);
    const store = new WebStore(domains.domains);
    return { domains, store };
}

function renderInstances(
    domains: WebTestDomains,
    store: WebStore,
    instance?: string,
) {
    const navigate = vi.fn();
    const view = render(
        withWebDomains(
            domains,
            <Instances
                navigate={navigate}
                route={
                    instance === undefined
                        ? { page: "instances" }
                        : { instance, page: "instances" }
                }
                store={store}
            />,
        ),
    );
    return { ...view, navigate };
}

it("does not offer Start or Stop for an offline self-managed reverse instance", () => {
    const { domains, store } = setup({
        instances: [reverseInstance("offline")],
    });
    renderInstances(domains, store, "reverse-mac");

    expect(
        screen.queryByRole("button", { name: "Start" }),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/self-managed.*offline/iu)).toBeInTheDocument();
});

it("does not offer Control lifecycle actions for an online self-managed reverse instance", () => {
    const { domains, store } = setup({
        instances: [reverseInstance("online")],
    });
    renderInstances(domains, store, "reverse-mac");

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
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("stopped")],
    });
    renderInstances(domains, store, "local-one");
    const start = vi.spyOn(store, "start");
    const link = screen.getByRole("link", { name: /local-one/u });

    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", "#/instances/local-one");
    expect(screen.getByRole("link", { name: "Config" })).toHaveAttribute(
        "href",
        "#/instances/local-one?view=config",
    );
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
        "href",
        "#/instances/local-one?view=connections",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(start).toHaveBeenCalledWith("local-one");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("shows live Overview status instead of a stale configured-instance snapshot", () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("stopped")],
    });
    domains.setOverview({
        instances: [{
            name: "local-one",
            snapshot: {
                connectionState: "connected",
                daemonState: "running",
                lastSeq: 10,
                name: asInstanceName("local-one"),
                ready: true,
                status: "ready",
            },
        }],
    });
    renderInstances(domains, store, "local-one");

    expect(screen.getByText("ready · connected")).toBeInTheDocument();
    expect(screen.queryByText("stopped · disconnected")).not.toBeInTheDocument();
});

it("creates a local instance from only name and provider", async () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    vi.spyOn(domains.instances, "createSchema").mockResolvedValue(
        createSchema(),
    );
    const createInstance = vi
        .spyOn(store, "createInstance")
        .mockResolvedValue({ succeeded: true });
    const validateCreate = vi.spyOn(domains.instances, "validateCreate");
    renderInstances(domains, store);

    fireEvent.click(screen.getByRole("button", { name: "New instance" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "web-created" } });

    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
        expect(createInstance).toHaveBeenCalledWith({
            name: "web-created",
            provider: "local",
        }),
    );
    expect(validateCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
        "Instance created successfully.",
    );
});

it.each(["Back to instances", "Cancel"])("%s leaves an in-flight creation without closing a later form", async (exit) => {
    const { domains, store } = setup({ config: localConfig(), instances: [localInstance("ready")] });
    vi.spyOn(domains.instances, "createSchema").mockResolvedValue(createSchema());
    const request = deferred<{ instance: string; name: string }>();
    const create = vi.spyOn(domains.instances, "create").mockReturnValue(request.promise);
    function CreationPage() {
        useSyncExternalStore(store.subscribe, () => store.state);
        return <Instances navigate={() => undefined} route={{ page: "instances" }} store={store} />;
    }
    render(withWebDomains(domains, <CreationPage />));
    fireEvent.click(screen.getByRole("button", { name: "New instance" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(create).toHaveBeenCalledWith({ name: "first", provider: "local" });
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: exit })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: exit }));
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New instance" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "second" } });
    await act(async () => request.resolve({ instance: "first", name: "first" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("second");
    expect(screen.queryByText("Instance created successfully.")).not.toBeInTheDocument();
});

it("defaults creation to SSH and uses discovered OpenSSH hosts", async () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    vi.spyOn(domains.instances, "createSchema").mockResolvedValue({
        ...createSchema(),
        defaultProvider: "ssh",
        sshHosts: ["aromatic-server"],
    });
    const createInstance = vi
        .spyOn(store, "createInstance")
        .mockResolvedValue({ succeeded: true });
    renderInstances(domains, store);

    fireEvent.click(screen.getByRole("button", { name: "New instance" }));
    expect(await screen.findByRole("radio", { name: /SSH/u })).toBeChecked();
    expect(screen.getByRole("combobox", { name: /SSH host/u })).toHaveValue(
        "aromatic-server",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "remote" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
        expect(createInstance).toHaveBeenCalledWith({
            name: "remote",
            provider: "ssh",
            ssh: { command: "ssh 'aromatic-server'" },
        }),
    );
});

it("keeps confirmation for stopping a running local instance", () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    renderInstances(domains, store, "local-one");
    const stop = vi.spyOn(store, "stop");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(stop).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("local-one");
});

it("derives Stop from the live runtime snapshot when the catalog snapshot is inactive", () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("stopped")],
    });
    domains.setRuntime("local-one", {
        snapshot: localInstance("ready").snapshot,
    });
    renderInstances(domains, store, "local-one");

    const stop = vi.spyOn(store, "stop");
    const button = screen.getByRole("button", { name: "Stop" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("local-one");
});

it("offers restart, disable, delete, and refresh actions for a managed instance", async () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    renderInstances(domains, store, "local-one");
    const refreshInstance = vi.spyOn(domains.runtime("local-one"), "load");
    const restart = vi.spyOn(store, "restart");
    const setInstanceEnabled = vi.spyOn(store, "setInstanceEnabled");
    const deleteInstance = vi.spyOn(store, "deleteInstance");

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(refreshInstance).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    let dialog = screen.getByRole("dialog", { name: "Confirm restart" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() =>
        expect(restart).toHaveBeenCalledWith("local-one"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    dialog = screen.getByRole("dialog", { name: "Confirm disable" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
        expect(setInstanceEnabled).toHaveBeenCalledWith("local-one", false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = screen.getByRole("dialog", { name: "Confirm delete" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
        expect(deleteInstance).toHaveBeenCalledWith("local-one"),
    );
});

it("shows per-instance artifact activity and confirms revoke and cancel", async () => {
    const { domains, store } = setup({
        artifacts: { shares: artifactShares(), transfers: artifactTransfers() },
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    renderInstances(domains, store, "local-one");
    const refreshArtifacts = vi.spyOn(domains.artifact, "refresh");
    const revokeArtifactShare = vi.spyOn(store, "revokeArtifactShare");
    const cancelArtifactTransfer = vi.spyOn(store, "cancelArtifactTransfer");

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
    await waitFor(() => expect(refreshArtifacts).toHaveBeenCalledOnce());

    fireEvent.click(
        within(activity).getByRole("button", { name: "Revoke share" }),
    );
    let dialog = screen.getByRole("dialog", { name: "Confirm revoke" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
        expect(revokeArtifactShare).toHaveBeenCalledWith("share-local-one"),
    );

    fireEvent.click(
        within(activity).getByRole("button", { name: "Cancel transfer" }),
    );
    dialog = screen.getByRole("dialog", { name: "Confirm cancel transfer" });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Cancel transfer" }),
    );
    await waitFor(() =>
        expect(cancelArtifactTransfer).toHaveBeenCalledWith(
            "transfer-local-one",
        ),
    );
});

it("updates artifact share expiry while the page remains open", async () => {
    vi.useFakeTimers();
    try {
        vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
        const shares = artifactShares();
        shares[0]!.expiresAtMs = Date.now() + 2_000;
        const { domains, store } = setup({
            artifacts: { shares, transfers: [] },
            config: localConfig(),
            instances: [localInstance("ready")],
        });
        renderInstances(domains, store, "local-one");
        const activity = screen.getByRole("region", {
            name: "Artifact activity",
        });
        expect(within(activity).getByText(/expires 2s/u)).toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(within(activity).getByText(/expires 1s/u)).toBeInTheDocument();
    } finally {
        vi.useRealTimers();
    }
});

it("enables a disabled instance without a confirmation dialog", () => {
    const { domains, store } = setup({
        config: localConfig(false),
        instances: [localInstance("stopped")],
    });
    renderInstances(domains, store, "local-one");
    const setInstanceEnabled = vi.spyOn(store, "setInstanceEnabled");

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(setInstanceEnabled).toHaveBeenCalledWith("local-one", true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps a failed Stop confirmation open and shows the failure in place", async () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    vi.spyOn(store, "state", "get").mockReturnValue({
        error: "Stop failed.",
        operations: {},
    });
    const stop = vi.spyOn(store, "stop").mockResolvedValue(false);
    renderInstances(domains, store, "local-one");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(
        within(screen.getByRole("dialog", { name: "Confirm stop" })).getByRole(
            "button",
            { name: "Stop" },
        ),
    );

    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Stop failed.");
});

it("shows instance refresh failures beside the selected detail instead of failing silently", async () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    vi.spyOn(domains.runtime("local-one"), "load").mockRejectedValue(
        new Error("Instance refresh failed."),
    );
    renderInstances(domains, store, "local-one");

    expect(await screen.findByRole("alert")).toHaveTextContent(
        "Instance refresh failed.",
    );
    expect(
        screen.getByRole("heading", { name: "local-one", level: 3 }),
    ).toBeInTheDocument();
});

it("routes an instance card link to a bookmarkable detail URL", () => {
    const { domains, store } = setup({
        config: localConfig(),
        instances: [localInstance("ready")],
    });
    const { navigate } = renderInstances(domains, store);
    const link = screen.getByRole("link", { name: /local-one/u });

    expect(link).toHaveAttribute("href", "#/instances/local-one");
    fireEvent.click(link);

    expect(navigate).toHaveBeenCalledWith({
        instance: "local-one",
        page: "instances",
    });
});

function reverseInstance(availability: "offline" | "online") {
    const online = availability === "online";
    return {
        mcpEnabled: true,
        name: "reverse-mac",
        snapshot: {
            connectionState: online ? "connected" : "disconnected",
            daemonState: online ? "running" : "stopped",
            lastSeq: 1,
            name: asInstanceName("reverse-mac"),
            ready: online,
            reverse: {
                availability,
                enrollmentState: "enrolled",
                managementMode: "selfManaged",
                ...(online ? { transport: "sse" as const } : {}),
            },
            status: online ? "ready" : "stopped",
        },
    };
}

function localInstance(status: "ready" | "stopped") {
    const ready = status === "ready";
    return {
        mcpEnabled: true,
        name: "local-one",
        snapshot: {
            connectionState: ready ? "connected" : "disconnected",
            daemonState: ready ? "running" : "stopped",
            lastSeq: 1,
            name: asInstanceName("local-one"),
            ready,
            status,
        },
    };
}

function localConfig(enabled = true) {
    return {
        instances: [
            {
                enabled,
                name: "local-one",
                provider: "local",
            },
        ],
    };
}

function createSchema() {
    return {
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
    };
}

function artifactShares() {
    return [
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
            state: "active" as const,
            url: "https://example.test/share-local-one",
        },
    ];
}

function artifactTransfers() {
    return [
        {
            createdAt: "2026-09-16T00:00:00.000Z",
            source: {
                instance: "local-one",
                path: "build.tar",
                workspace: "/workspace",
            },
            status: "transferring" as const,
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
    ];
}
