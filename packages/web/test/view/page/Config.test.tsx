import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";

import { Config } from "../../../src/view/page/Config.js";
import type { WebState } from "../../../src/state/Model.js";
import type { WebStore } from "../../../src/state/Store.js";

describe("Web Config", () => {
    it("requires Save & Restart for restart-bound changes on a running worker", async () => {
        const state = configState();
        const store = {
            state,
            start: vi.fn(async () => true),
            stop: vi.fn(async () => true),
            updateInstanceConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
        } as unknown as WebStore;
        render(
            <Config
                disabled={false}
                instance="alpha"
                state={state}
                store={store}
            />,
        );

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

        await waitFor(() =>
            expect(store.validateConfig).toHaveBeenCalledTimes(1),
        );
        expect(store.stop).toHaveBeenCalledWith("alpha");
        await waitFor(() =>
            expect(store.updateInstanceConfig).toHaveBeenCalledWith(
                "alpha",
                expect.objectContaining({ logs: { retentionDays: 30 } }),
            ),
        );
        expect(store.start).toHaveBeenCalledWith("alpha");
    });

    it("hot-saves workspace changes without restarting the worker", async () => {
        const state = configState();
        const store = {
            state,
            start: vi.fn(async () => true),
            stop: vi.fn(async () => true),
            updateInstanceConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
        } as unknown as WebStore;
        render(
            <Config
                disabled={false}
                instance="alpha"
                state={state}
                store={store}
            />,
        );

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
            expect(store.updateInstanceConfig).toHaveBeenCalledWith(
                "alpha",
                expect.objectContaining({ workspace: { enabled: false } }),
            ),
        );
        expect(store.stop).not.toHaveBeenCalled();
        expect(store.start).not.toHaveBeenCalled();
    });

    it("keeps raw JSON available as an advanced editor", () => {
        const state = configState();
        const store = {
            state,
            updateInstanceConfig: vi.fn(async () => true),
            validateConfig: vi.fn(async () => true),
        } as unknown as WebStore;
        render(
            <Config
                disabled={false}
                instance="alpha"
                state={state}
                store={store}
            />,
        );

        expect(
            (
                screen.getByRole("textbox", {
                    name: "Advanced instance JSON",
                }) as HTMLTextAreaElement
            ).value,
        ).toContain('"provider": "local"');
    });
});

function configState(): WebState {
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
            },
            instanceState: {
                alpha: {
                    ...createInitialControlReadModelState().instanceState.alpha,
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 1,
                        name: asInstanceName("alpha"),
                        ready: true,
                        status: "ready",
                    },
                },
            },
        },
    } as WebState;
}
