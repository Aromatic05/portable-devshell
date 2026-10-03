import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asInstanceName } from "@portable-devshell/shared";

import { Config } from "../../../src/view/page/Config.js";
import { WebStore } from "../../../src/state/Store.js";
import {
    WebTestDomains,
    withWebDomains,
} from "../../support/DomainHarness.js";

describe("Web Config", () => {
    it("requires Save & Restart for restart-bound changes on a running worker", async () => {
        const { store } = renderConfig();
        const validateConfig = vi.spyOn(store, "validateConfig");
        const stop = vi.spyOn(store, "stop");
        const updateInstanceConfig = vi.spyOn(store, "updateInstanceConfig");
        const start = vi.spyOn(store, "start");

        fireEvent.change(
            screen.getByRole("spinbutton", { name: "Log retention days" }),
            { target: { value: "30" } },
        );

        expect(
            screen.getByRole("button", { name: "Save Only" }),
        ).toBeDisabled();
        const restart = screen.getByRole("button", { name: "Save & Restart" });
        expect(restart).toBeEnabled();
        fireEvent.click(restart);

        await waitFor(() => expect(validateConfig).toHaveBeenCalledTimes(1));
        expect(stop).toHaveBeenCalledWith("alpha");
        await waitFor(() =>
            expect(updateInstanceConfig).toHaveBeenCalledWith(
                "alpha",
                expect.objectContaining({ logs: { retentionDays: 30 } }),
            ),
        );
        expect(start).toHaveBeenCalledWith("alpha");
    });

    it("hot-saves workspace changes without restarting the worker", async () => {
        const { store } = renderConfig();
        const validateConfig = vi.spyOn(store, "validateConfig");
        const stop = vi.spyOn(store, "stop");
        const start = vi.spyOn(store, "start");
        const updateInstanceConfig = vi.spyOn(store, "updateInstanceConfig");

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Workspace enabled" }),
        );

        const save = screen.getByRole("button", { name: "Save Only" });
        expect(save).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Save & Restart" }),
        ).toBeDisabled();
        fireEvent.click(save);

        await waitFor(() =>
            expect(updateInstanceConfig).toHaveBeenCalledWith(
                "alpha",
                expect.objectContaining({ workspace: { enabled: false } }),
            ),
        );
        expect(validateConfig).toHaveBeenCalledTimes(1);
        expect(stop).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });

    it("keeps raw JSON available as an advanced editor", () => {
        renderConfig();

        expect(
            (
                screen.getByRole("textbox", {
                    name: "Advanced instance JSON",
                }) as HTMLTextAreaElement
            ).value,
        ).toContain('"provider": "local"');
    });
});

function renderConfig({
    disabled = false,
    instance = "alpha",
}: {
    disabled?: boolean;
    instance?: string;
} = {}) {
    const domains = new WebTestDomains();
    domains.setConfig(configView());
    domains.setInstances([
        {
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
    ]);
    const store = new WebStore(domains.domains);
    return {
        domains,
        store,
        ...render(
            withWebDomains(
                domains,
                <Config disabled={disabled} instance={instance} store={store} />,
            ),
        ),
    };
}

function configView() {
    return {
        control: {
            artifactDirectTransfer: true,
            logLevel: "info",
        },
        instances: [
            {
                approvalPolicy: { mode: "disabled" },
                enabled: true,
                extensions: { model: ["instance"] },
                logs: { retentionDays: 7 },
                mcp: {
                    auth: "none",
                    contextMode: "explicit",
                    enabled: true,
                    path: "/alpha/mcp",
                },
                name: "alpha",
                provider: "local",
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
        },
        restartControlRequired: false,
        web: {
            auth: "none",
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3101,
            publicBaseUrl: "",
        },
    };
}
