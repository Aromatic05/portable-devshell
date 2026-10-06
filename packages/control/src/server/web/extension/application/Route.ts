import type { WebPageRequest } from "@portable-devshell/extension/web";
import {
    routeModule,
    createRemoteError,
    controlErrorCodes,
    type JsonValue,
    type ControlPortContext,
    type ControlPortDefinition,
    type WebApplicationDescriptor,
    type WebPageDescriptor,
    type WebPageSnapshot,
} from "@portable-devshell/shared";


export interface WebApplicationCatalogPort {
    list(): readonly WebApplicationDescriptor[];
}

export interface WebPagePort {
    invoke(
        pageId: string,
        request: WebPageRequest,
        context: { requestId: string; signal: AbortSignal },
    ): Promise<WebPageSnapshot>;
    list(): readonly WebPageDescriptor[];
}

export function createWebApplicationRouteModule(
    port: WebApplicationCatalogPort,
    pages?: WebPagePort,
): ControlPortDefinition {
    return routeModule("extension", {
        webApplications: (_request, context) => {
            requireWeb(context);
            return [...port.list()] as unknown as JsonValue;
        },
        webPage: async (request, context) => {
            requireWeb(context);
            if (pages === undefined) throw unavailable();
            const input = readPageRequest(request.payload);
            return (await pages.invoke(input.pageId, input.request, {
                requestId: context.requestId,
                signal: context.signal,
            })) as unknown as JsonValue;
        },
        webPages: (_request, context) => {
            requireWeb(context);
            return [...(pages?.list() ?? [])] as unknown as JsonValue;
        },
    });
}

function readPageRequest(payload: JsonValue | undefined): {
    pageId: string;
    request: WebPageRequest;
} {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        throw invalid("web.page requires an object payload.");
    const pageId = readText(payload.pageId, "pageId");
    if (payload.kind === "read") return { pageId, request: { kind: "read" } };
    if (payload.kind === "action") {
        return {
            pageId,
            request: {
                actionId: readText(payload.actionId, "actionId"),
                kind: "action",
                ...(payload.rowId === undefined
                    ? {}
                    : { rowId: readText(payload.rowId, "rowId") }),
            },
        };
    }
    throw invalid("web.page kind must be read or action.");
}

function requireWeb(context: ControlPortContext): void {
    if (context.peer === "web") return;
    throw createRemoteError({
        code: controlErrorCodes.webAccessDenied,
        message: "Web application access is available only to Web clients.",
        retryable: false,
    });
}

function readText(value: JsonValue | undefined, label: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw invalid(`${label} must be a non-empty string.`);
}

function invalid(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.webAccessDenied,
        message,
        retryable: false,
    });
}

function unavailable(): Error {
    return createRemoteError({
        code: controlErrorCodes.webAccessDenied,
        message: "Web Extension pages are not available.",
        retryable: false,
    });
}
