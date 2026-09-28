import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionApi.js";

export type ControlRouteScope = "control" | "instance";

export interface ControlRouteDeclaration extends ExtensionPointDeclaration {
    readonly module: string;
    readonly operation: string;
    readonly scope: ControlRouteScope;
}

export interface ControlRouteRequest {
    readonly payload?: ExtensionJsonValue;
    readonly seq?: number;
}

export interface ControlRouteInvocationContext {
    readonly destination: string;
    readonly peer: "cli" | "tui" | "web";
    readonly protocolVersion?: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly subject?: {
        readonly id: string;
        readonly kind: string;
    };
}

export type ControlRouteBinding = (
    request: ControlRouteRequest,
    context: ControlRouteInvocationContext,
) => Promise<ExtensionJsonValue | undefined> | ExtensionJsonValue | undefined;

/** Unary Control protocol operation contributed by an Extension generation. */
export const routes = defineExtensionPoint<
    ControlRouteDeclaration,
    ControlRouteBinding
>("control.routes");
