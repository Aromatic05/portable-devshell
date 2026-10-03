import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type {
    CliCommandDescriptor,
    CliCommandWireResult,
    ExtensionRemoveResult,
    ExtensionRuntimeRecord,
    TuiPageDescriptor,
    TuiPageSnapshot,
    WebApplicationDescriptor,
    WebPageDescriptor,
    WebPageSnapshot,
} from "./Model.js";

export interface ExtensionRuntimeTransport {
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
    const port = createPortClient(endpoint, CONTROL_HOST, "cli");
    return {
        command: (commandId, argv, options = {}) =>
            port.request<CliCommandWireResult>(
                "command",
                {
                    argv: [...argv],
                    commandId,
                    ...(options.workingDirectory === undefined
                        ? {}
                        : { workingDirectory: options.workingDirectory }),
                },
                options.signal,
            ),
        commands: () => port.request<CliCommandDescriptor[]>("commands"),
    };
}

export function createTuiPageTransport(endpoint: Endpoint): TuiPageTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "tui");
    return {
        action: (pageId, actionId, itemId) =>
            port.request<TuiPageSnapshot>("page", {
                actionId,
                ...(itemId === undefined ? {} : { itemId }),
                kind: "action",
                pageId,
            }),
        page: (pageId) =>
            port.request<TuiPageSnapshot>("page", { kind: "read", pageId }),
        pages: () => port.request<TuiPageDescriptor[]>("pages"),
    };
}

export function createWebPageTransport(endpoint: Endpoint): WebPageTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "web");
    return {
        action: (pageId, actionId, rowId) =>
            port.request<WebPageSnapshot>("page", {
                actionId,
                kind: "action",
                pageId,
                ...(rowId === undefined ? {} : { rowId }),
            }),
        applications: () =>
            port.request<WebApplicationDescriptor[]>("applications"),
        page: (pageId) =>
            port.request<WebPageSnapshot>("page", { kind: "read", pageId }),
        pages: () => port.request<WebPageDescriptor[]>("pages"),
    };
}
