// Shared route-definition vocabulary used by provider-side host/port routing.
// Request and response semantics stay in the owning domain Contract.

import type { ControlClientKind } from "../../../control/server/Model.js";
import type { JsonValue } from "../../../types/Json.js";
import type { MessageStream } from "../../packet/Stream.js";

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
