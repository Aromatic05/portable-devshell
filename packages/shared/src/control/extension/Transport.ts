import { CONTROL_HOST } from "../../client/Control.js";
import { EventStreamReader, readStreamGapPayload, type EventStreamPort } from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type {
    CliCommandDescriptor,
    CliCommandWireResult,
    ExtensionRemoveResult,
    ExtensionRuntimeRecord,
    ExtensionChangeEvent,
    ExtensionSnapshot,
    TuiPageDescriptor,
    TuiPageSnapshot,
    WebApplicationDescriptor,
    WebPageDescriptor,
    WebPageSnapshot,
} from "./Model.js";

export interface ExtensionRuntimeTransport {
    snapshot(): Promise<ExtensionSnapshot>;
    subscribe(fromRevision: number): Promise<EventStreamPort<ExtensionChangeEvent>>;
    disable(extensionId: string): Promise<ExtensionRuntimeRecord>;
    enable(extensionId: string): Promise<ExtensionRuntimeRecord>;
    get(extensionId: string): Promise<ExtensionRuntimeRecord>;
    install(sourcePath: string): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(extensionId: string): Promise<ExtensionRuntimeRecord>;
    remove(
        extensionId: string,
        purge?: boolean,
    ): Promise<ExtensionRemoveResult>;
}

export interface CliCommandTransport {
    command(
        commandId: string,
        argv: readonly string[],
        options?: { signal?: AbortSignal; workingDirectory?: string },
    ): Promise<CliCommandWireResult>;
    commands(): Promise<CliCommandDescriptor[]>;
}

export interface TuiPageTransport {
    action(
        pageId: string,
        actionId: string,
        itemId?: string,
    ): Promise<TuiPageSnapshot>;
    page(pageId: string): Promise<TuiPageSnapshot>;
    pages(): Promise<TuiPageDescriptor[]>;
}

export interface WebPageTransport {
    action(
        pageId: string,
        actionId: string,
        rowId?: string,
    ): Promise<WebPageSnapshot>;
    applications(): Promise<WebApplicationDescriptor[]>;
    page(pageId: string): Promise<WebPageSnapshot>;
    pages(): Promise<WebPageDescriptor[]>;
}

export function createExtensionRuntimeTransport(
    endpoint: Endpoint,
): ExtensionRuntimeTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "extension");
    return {
        snapshot: () => port.request<ExtensionSnapshot>("snapshot"),
        subscribe: async (fromRevision) => new EventStreamReader<ExtensionChangeEvent>(
            await port.open("subscribe", { fromRevision }),
            {
                decodeEvent: (payload) => {
                    if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
                        !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 1 ||
                        !Array.isArray(payload.extensionIds) ||
                        !payload.extensionIds.every((id) => typeof id === "string"))
                        throw new TypeError("Invalid Extension change event.");
                    return { extensionIds: payload.extensionIds as string[], revision: payload.revision as number };
                },
                readGap: readStreamGapPayload,
            },
        ),
        disable: (extensionId) =>
            port.request<ExtensionRuntimeRecord>("disable", { extensionId }),
        enable: (extensionId) =>
            port.request<ExtensionRuntimeRecord>("enable", { extensionId }),
        get: (extensionId) =>
            port.request<ExtensionRuntimeRecord>("get", { extensionId }),
        install: (sourcePath) =>
            port.request<ExtensionRuntimeRecord>("install", { sourcePath }),
        list: () => port.request<ExtensionRuntimeRecord[]>("list"),
        reload: (extensionId) =>
            port.request<ExtensionRuntimeRecord>("reload", { extensionId }),
        remove: (extensionId, purge = false) =>
            port.request<ExtensionRemoveResult>("remove", {
                extensionId,
                purge,
            }),
    };
}

export function createCliCommandTransport(
    endpoint: Endpoint,
): CliCommandTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "extension");
    return {
        command: (commandId, argv, options = {}) =>
            port.request<CliCommandWireResult>(
                "cliCommand",
                {
                    argv: [...argv],
                    commandId,
                    ...(options.workingDirectory === undefined
                        ? {}
                        : { workingDirectory: options.workingDirectory }),
                },
                options.signal,
            ),
        commands: () => port.request<CliCommandDescriptor[]>("cliCommands"),
    };
}

export function createTuiPageTransport(endpoint: Endpoint): TuiPageTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "extension");
    return {
        action: (pageId, actionId, itemId) =>
            port.request<TuiPageSnapshot>("tuiPage", {
                actionId,
                ...(itemId === undefined ? {} : { itemId }),
                kind: "action",
                pageId,
            }),
        page: (pageId) =>
            port.request<TuiPageSnapshot>("tuiPage", { kind: "read", pageId }),
        pages: () => port.request<TuiPageDescriptor[]>("tuiPages"),
    };
}

export function createWebPageTransport(endpoint: Endpoint): WebPageTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "extension");
    return {
        action: (pageId, actionId, rowId) =>
            port.request<WebPageSnapshot>("webPage", {
                actionId,
                kind: "action",
                pageId,
                ...(rowId === undefined ? {} : { rowId }),
            }),
        applications: () =>
            port.request<WebApplicationDescriptor[]>("webApplications"),
        page: (pageId) =>
            port.request<WebPageSnapshot>("webPage", { kind: "read", pageId }),
        pages: () => port.request<WebPageDescriptor[]>("webPages"),
    };
}
