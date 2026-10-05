import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionCore.js";

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

export interface ControlStreamMessage {
    readonly name: string;
    readonly payload?: ExtensionJsonValue;
    readonly seq?: number;
}

/** Output stream whose lifetime is bounded by the invocation signal. */
export interface ControlStream {
    send(message: ControlStreamMessage): Promise<void>;
    close(payload?: ExtensionJsonValue): Promise<void>;
}

export type ControlStreamBinding = (
    stream: ControlStream,
    request: ControlRouteRequest,
    context: ControlRouteInvocationContext,
) => Promise<void> | void;

export const streams = defineExtensionPoint<
    ControlRouteDeclaration,
    ControlStreamBinding
>("control.streams");
