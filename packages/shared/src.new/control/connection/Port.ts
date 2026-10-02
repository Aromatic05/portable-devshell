// Server-side control host port definitions. Each control subdomain exposes a
// named port whose operations and streams are handled against a typed context.
// These types are domain-blind; the request/response vocabulary lives in the
// owning subdomain's Contract.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { ControlClientKind } from "../service/Model.js";

export interface ControlPeerSubject {
    readonly id: string;
    readonly kind: string;
}

export interface ControlPortRequest {
    readonly id: string;
    readonly name: string;
    readonly payload?: JsonValue;
}

export interface ControlPortContext {
    readonly connectionId: string;
    readonly host: string;
    readonly peer: ControlClientKind;
    readonly protocolVersion?: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly subject?: ControlPeerSubject;
    afterReply(action: () => Promise<void> | void): void;
}

export interface ControlStreamMessage {
    readonly name: string;
    readonly payload?: JsonValue;
    readonly seq?: number;
}

export type ControlPortHandler = (
    request: ControlPortRequest,
    context: ControlPortContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export type ControlPortStreamHandler = (
    stream: MessageStream,
    request: ControlPortRequest,
    context: ControlPortContext,
) => Promise<void> | void;

export interface ControlPortDefinition {
    readonly name: string;
    readonly operations: readonly {
        readonly name: string;
        readonly handle: ControlPortHandler;
    }[];
    readonly streams?: readonly {
        readonly name: string;
        readonly handle: ControlPortStreamHandler;
    }[];
}

export interface ControlHostDefinition {
    readonly host: string;
    readonly ports: readonly ControlPortDefinition[];
}
