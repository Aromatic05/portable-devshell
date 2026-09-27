import type { ExtensionContext } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";
import {
    pages as tuiPages,
    type TuiPageBinding,
    type TuiPageItem,
} from "@portable-devshell/extension/tui";
import {
    applications,
    pages as webPages,
    type WebPageBinding,
    type WebPageRow,
} from "@portable-devshell/extension/web";

import { executeAccessCommand } from "./AccessCommand.js";
import { AccessRuntime } from "./AccessRuntime.js";

let activeRuntime: AccessRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined)
        throw new Error("Access Extension is already active in this generation.");
    const runtime = new AccessRuntime(context);
    activeRuntime = runtime;
    context.register(
        nativeCommands,
        "access",
        async (argv, invocation) =>
            await executeAccessCommand(runtime, argv, invocation),
    );
    context.register(
        applications,
        "access",
        Object.freeze({
            source: Object.freeze({
                kind: "endpoint" as const,
                resolve: async () => await runtime.webUpstream(),
            }),
        }),
    );
    context.register(
        webPages,
        "access",
        createAccessWebPage(runtime),
    );
    context.register(tuiPages, "access", createAccessTuiPage(runtime));
}

function createAccessTuiPage(runtime: AccessRuntime): TuiPageBinding {
    return async (request, invocation) => {
        invocation.signal.throwIfAborted();
        if (request.kind === "action") {
            if (!invocation.localOwner)
                throw new Error("Access management requires the local Control owner.");
            const itemId = request.itemId;
            if (itemId === undefined)
                throw new TypeError("Access TUI action requires an endpoint id.");
            await applyAccessAction(runtime, request.actionId, itemId);
        }
        return {
            items: runtime.list().map(accessTuiItem),
        };
    };
}

function accessTuiItem(record: ReturnType<AccessRuntime["list"]>[number]): TuiPageItem {
    return {
        actions: [
            record.enabled
                ? { id: "disable", label: "Disable" }
                : { id: "enable", label: "Enable" },
            { id: "remove", label: "Remove", tone: "danger" },
        ],
        detail: [
            { text: `provider ${record.provider}` },
            { text: `target ${record.target}` },
            ...(record.origin === undefined ? [] : [{ text: `origin ${record.origin}` }]),
            ...(record.publicUrl === undefined
                ? []
                : [{ text: `public ${record.publicUrl}` }]),
            ...(record.error === undefined
                ? []
                : [{ text: `error ${record.error}`, tone: "danger" as const }]),
        ],
        id: record.id,
        status:
            record.state === "running"
                ? "ready"
                : record.state === "error"
                  ? "failed"
                  : record.state === "starting"
                    ? "running"
                    : record.state === "waiting"
                      ? "pending"
                      : "disabled",
        summary: [{ text: `${record.provider} -> ${record.target}` }],
        title: record.id,
    };
}

function createAccessWebPage(runtime: AccessRuntime): WebPageBinding {
    return async (request, invocation) => {
        invocation.signal.throwIfAborted();
        if (request.kind === "action") {
            if (request.rowId === undefined)
                throw new TypeError("Access Web action requires an endpoint id.");
            await applyAccessAction(runtime, request.actionId, request.rowId);
        }
        return {
            tables: [
                {
                    columns: [
                        { id: "endpoint", label: "Endpoint" },
                        { id: "provider", label: "Provider" },
                        { id: "target", label: "Target" },
                        { id: "state", label: "State" },
                        { id: "origin", label: "Service URL" },
                        { id: "public", label: "Public URL" },
                        { id: "error", label: "Error" },
                    ],
                    id: "endpoints",
                    rows: runtime.list().map(accessWebRow),
                    title: "Endpoints",
                },
            ],
        };
    };
}

function accessWebRow(
    record: ReturnType<AccessRuntime["list"]>[number],
): WebPageRow {
    return {
        actions: [
            record.enabled
                ? { id: "disable", label: "Disable" }
                : { id: "enable", label: "Enable" },
            { id: "remove", label: "Remove", tone: "danger" },
        ],
        cells: {
            endpoint: { text: record.id },
            provider: { text: record.provider },
            target: { text: record.target },
            state: {
                text: record.state,
                tone:
                    record.state === "running"
                        ? "success"
                        : record.state === "error"
                          ? "danger"
                          : record.state === "waiting"
                            ? "warning"
                            : "normal",
            },
            origin: { text: record.origin ?? "—" },
            public:
                record.publicUrl === undefined
                    ? { text: "—" }
                    : { href: record.publicUrl, text: record.publicUrl },
            error: {
                text: record.error ?? "—",
                ...(record.error === undefined
                    ? {}
                    : { tone: "danger" as const }),
            },
        },
        id: record.id,
    };
}

async function applyAccessAction(
    runtime: AccessRuntime,
    actionId: string,
    endpointId: string,
): Promise<void> {
    if (actionId === "enable") await runtime.setEnabled(endpointId, true);
    else if (actionId === "disable") await runtime.setEnabled(endpointId, false);
    else if (actionId === "remove") await runtime.remove(endpointId);
    else throw new TypeError(`Unknown Access action: ${actionId}`);
}

export async function deactivate(): Promise<void> {
    const runtime = activeRuntime;
    activeRuntime = undefined;
    await runtime?.dispose();
}

export { AccessRuntime } from "./AccessRuntime.js";
export { executeAccessCommand, ACCESS_USAGE } from "./AccessCommand.js";
