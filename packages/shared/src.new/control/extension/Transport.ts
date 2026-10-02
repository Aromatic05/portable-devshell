import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    cliCommandOperations,
    extensionRuntimeOperations,
    tuiPageOperations,
    webPageOperations,
    type CliCommandOperation,
    type CliCommandRequest,
    type CliCommandResponse,
    type ExtensionRuntimeOperation,
    type ExtensionRuntimeRequest,
    type ExtensionRuntimeResponse,
    type TuiPageOperation,
    type TuiPageRequest,
    type TuiPageResponse,
    type WebPageOperation,
    type WebPageRequest,
    type WebPageResponse,
} from "./Contract.js";
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

/** Installed extension runtime lifecycle. */
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

/** Extension-provided CLI commands. */
export interface CliCommandTransport {
    command(
        commandId: string,
        argv: readonly string[],
        options?: { signal?: AbortSignal; workingDirectory?: string },
    ): Promise<CliCommandWireResult>;
    commands(): Promise<CliCommandDescriptor[]>;
}

/** Extension-provided TUI pages. */
export interface TuiPageTransport {
    action(
        pageId: string,
        actionId: string,
        itemId?: string,
    ): Promise<TuiPageSnapshot>;
    page(pageId: string): Promise<TuiPageSnapshot>;
    pages(): Promise<TuiPageDescriptor[]>;
}

/** Extension-provided Web applications and pages. */
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
    return extensionRuntimeTransport(
        createPortClient(endpoint, CONTROL_HOST, "extension"),
    );
}

export function createCliCommandTransport(endpoint: Endpoint): CliCommandTransport {
    return cliCommandTransport(createPortClient(endpoint, CONTROL_HOST, "cli"));
}

export function createTuiPageTransport(endpoint: Endpoint): TuiPageTransport {
    return tuiPageTransport(createPortClient(endpoint, CONTROL_HOST, "tui"));
}

export function createWebPageTransport(endpoint: Endpoint): WebPageTransport {
    return webPageTransport(createPortClient(endpoint, CONTROL_HOST, "web"));
}

export function extensionRuntimeTransport(
    port: PortClient,
): ExtensionRuntimeTransport {
    const request = <Operation extends ExtensionRuntimeOperation>(
        operation: Operation,
        payload: ExtensionRuntimeRequest<Operation>,
    ): Promise<ExtensionRuntimeResponse<Operation>> =>
        port.request<ExtensionRuntimeResponse<Operation>>(operation, payload);
    return {
        disable: (extensionId) =>
            request(extensionRuntimeOperations.disable, { extensionId }),
        enable: (extensionId) =>
            request(extensionRuntimeOperations.enable, { extensionId }),
        get: (extensionId) =>
            request(extensionRuntimeOperations.get, { extensionId }),
        install: (sourcePath) =>
            request(extensionRuntimeOperations.install, { sourcePath }),
        list: () => request(extensionRuntimeOperations.list, undefined),
        reload: (extensionId) =>
            request(extensionRuntimeOperations.reload, { extensionId }),
        remove: (extensionId, purge = false) =>
            request(extensionRuntimeOperations.remove, { extensionId, purge }),
    };
}

export function cliCommandTransport(port: PortClient): CliCommandTransport {
    const request = <Operation extends CliCommandOperation>(
        operation: Operation,
        payload: CliCommandRequest<Operation>,
        signal?: AbortSignal,
    ): Promise<CliCommandResponse<Operation>> =>
        port.request<CliCommandResponse<Operation>>(operation, payload, signal);
    return {
        command: (commandId, argv, options = {}) =>
            request(
                cliCommandOperations.command,
                {
                    argv: [...argv],
                    commandId,
                    ...(options.workingDirectory === undefined
                        ? {}
                        : { workingDirectory: options.workingDirectory }),
                },
                options.signal,
            ),
        commands: () => request(cliCommandOperations.commands, undefined),
    };
}

export function tuiPageTransport(port: PortClient): TuiPageTransport {
    const request = <Operation extends TuiPageOperation>(
        operation: Operation,
        payload: TuiPageRequest<Operation>,
    ): Promise<TuiPageResponse<Operation>> =>
        port.request<TuiPageResponse<Operation>>(operation, payload);
    return {
        action: (pageId, actionId, itemId) =>
            request(tuiPageOperations.page, {
                actionId,
                ...(itemId === undefined ? {} : { itemId }),
                kind: "action",
                pageId,
            }),
        page: (pageId) =>
            request(tuiPageOperations.page, { kind: "read", pageId }),
        pages: () => request(tuiPageOperations.pages, undefined),
    };
}

export function webPageTransport(port: PortClient): WebPageTransport {
    const request = <Operation extends WebPageOperation>(
        operation: Operation,
        payload: WebPageRequest<Operation>,
    ): Promise<WebPageResponse<Operation>> =>
        port.request<WebPageResponse<Operation>>(operation, payload);
    return {
        action: (pageId, actionId, rowId) =>
            request(webPageOperations.page, {
                actionId,
                kind: "action",
                pageId,
                ...(rowId === undefined ? {} : { rowId }),
            }),
        applications: () => request(webPageOperations.applications, undefined),
        page: (pageId) =>
            request(webPageOperations.page, { kind: "read", pageId }),
        pages: () => request(webPageOperations.pages, undefined),
    };
}