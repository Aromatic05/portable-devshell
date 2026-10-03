// Extension wire contract. The extension bounded context exposes four Control
// ports: extension lifecycle (`extension`), CLI commands (`cli`), TUI pages
// (`tui`), and Web applications/pages (`web`). The transports in
// ./Transport.ts are typed against these maps. `commandStream` is the cli
// port's dedicated command I/O stream: it carries stdout/stderr/terminal
// events down and input/eof up, and closes with the command's wire result.

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

export const extensionRuntimeOperations = {
    disable: "disable",
    enable: "enable",
    get: "get",
    install: "install",
    list: "list",
    reload: "reload",
    remove: "remove",
} as const;

export const cliCommandOperations = {
    command: "command",
    commandStream: "commandStream",
    commands: "commands",
} as const;

export const tuiPageOperations = {
    page: "page",
    pages: "pages",
} as const;

export const webPageOperations = {
    applications: "applications",
    page: "page",
    pages: "pages",
} as const;

export interface ExtensionRuntimeContract {
    disable: {
        request: { extensionId: string };
        response: ExtensionRuntimeRecord;
    };
    enable: {
        request: { extensionId: string };
        response: ExtensionRuntimeRecord;
    };
    get: {
        request: { extensionId: string };
        response: ExtensionRuntimeRecord;
    };
    install: {
        request: { sourcePath: string };
        response: ExtensionRuntimeRecord;
    };
    list: {
        request: undefined;
        response: ExtensionRuntimeRecord[];
    };
    reload: {
        request: { extensionId: string };
        response: ExtensionRuntimeRecord;
    };
    remove: {
        request: { extensionId: string; purge: boolean };
        response: ExtensionRemoveResult;
    };
}

export interface CliCommandContract {
    command: {
        request: CliCommandWireRequest;
        response: CliCommandWireResult;
    };
    commands: {
        request: undefined;
        response: CliCommandDescriptor[];
    };
}

export interface TuiPageContract {
    page: {
        request: TuiPageWireRequest;
        response: TuiPageSnapshot;
    };
    pages: {
        request: undefined;
        response: TuiPageDescriptor[];
    };
}

export interface WebPageContract {
    applications: {
        request: undefined;
        response: WebApplicationDescriptor[];
    };
    page: {
        request: WebPageWireRequest;
        response: WebPageSnapshot;
    };
    pages: {
        request: undefined;
        response: WebPageDescriptor[];
    };
}

export type ExtensionRuntimeOperation = keyof ExtensionRuntimeContract;

export type ExtensionRuntimeRequest<Operation extends ExtensionRuntimeOperation> =
    ExtensionRuntimeContract[Operation]["request"];

export type ExtensionRuntimeResponse<Operation extends ExtensionRuntimeOperation> =
    ExtensionRuntimeContract[Operation]["response"];

export type CliCommandOperation = keyof CliCommandContract;

export type CliCommandRequest<Operation extends CliCommandOperation> =
    CliCommandContract[Operation]["request"];

export type CliCommandResponse<Operation extends CliCommandOperation> =
    CliCommandContract[Operation]["response"];

export type TuiPageOperation = keyof TuiPageContract;

export type TuiPageRequest<Operation extends TuiPageOperation> =
    TuiPageContract[Operation]["request"];

export type TuiPageResponse<Operation extends TuiPageOperation> =
    TuiPageContract[Operation]["response"];

export type WebPageOperation = keyof WebPageContract;

export type WebPageRequest<Operation extends WebPageOperation> =
    WebPageContract[Operation]["request"];

export type WebPageResponse<Operation extends WebPageOperation> =
    WebPageContract[Operation]["response"];

export interface CliCommandWireRequest {
    argv: string[];
    commandId: string;
    workingDirectory?: string;
}

export type TuiPageWireRequest =
    | { kind: "read"; pageId: string }
    | { actionId: string; itemId?: string; kind: "action"; pageId: string };

export type WebPageWireRequest =
    | { kind: "read"; pageId: string }
    | { actionId: string; kind: "action"; pageId: string; rowId?: string };

export type CliCommandStreamClientMessage =
    | { name: "eof" }
    | { name: "input"; payload: { data: string } };

export type CliCommandStreamServerMessage =
    | { name: "stderr"; payload: { chunk: string } }
    | { name: "stdout"; payload: { chunk: string } }
    | { name: "terminal"; payload: { raw: boolean } };

export type CliCommandStreamResult = CliCommandWireResult;