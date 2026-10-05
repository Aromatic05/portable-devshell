import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    streams,
    type ControlStreamBinding,
    type ControlStreamMessage,
} from "@portable-devshell/extension/control";
import type {
    ExtensionPointDefinition,
    ExtensionPointSandboxBridge,
    ExtensionPointValidationContext,
} from "../../../registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../../../sandbox/bridge/PointCodec.js";
import { parseControlRouteDeclaration } from "./Declaration.js";
import {
    readControlRouteRequest,
    readExtensionRecord,
    readExtensionString,
    readRoutePeer,
    readRouteSubject,
} from "./Sandbox.js";

export const controlStreamsExtensionPointDefinition: ExtensionPointDefinition = {
    id: streams.id,
    parseDeclaration: parseControlRouteDeclaration,
    validateBinding: validateStreamBinding,
    createSandboxBinding: createStreamSandboxBinding,
};

export const controlStreamsSandboxCodec: ExtensionSandboxPointCodec = {
    id: streams.id,
    describeBinding(binding, context) {
        validateStreamBinding(binding, context);
        return { kind: "stream" };
    },
    async invokeBinding(binding, input, signal, context) {
        validateStreamBinding(binding, context);
        const value = readExtensionRecord(input, "Control stream invocation");
        const invocation = readExtensionRecord(value.context, "Control stream context");
        await binding(
            {
                send: async (message) => {
                    await context.requestInterface("stream.send", message as unknown as ExtensionJsonValue);
                },
                close: async (payload) => {
                    await context.requestInterface("stream.close", payload);
                },
            },
            readControlRouteRequest(value.request),
            {
                destination: readExtensionString(invocation.destination, "destination"),
                peer: readRoutePeer(invocation.peer),
                requestId: readExtensionString(invocation.requestId, "requestId"),
                signal,
                ...(invocation.protocolVersion === undefined ? {} : {
                    protocolVersion: readExtensionString(invocation.protocolVersion, "protocolVersion"),
                }),
                ...(invocation.subject === undefined ? {} : { subject: readRouteSubject(invocation.subject) }),
            },
        );
    },
};

function createStreamSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): ControlStreamBinding {
    const value = readExtensionRecord(descriptor, "Control stream descriptor");
    if (value.kind !== "stream" || Object.keys(value).some((key) => key !== "kind"))
        throw new TypeError("Control stream descriptor is invalid.");
    return async (stream, request, invocation) => {
        await bridge.invokeBinding(streams.id, context.id, {
            request: request as unknown as ExtensionJsonValue,
            context: {
                destination: invocation.destination,
                peer: invocation.peer,
                requestId: invocation.requestId,
                ...(invocation.protocolVersion === undefined ? {} : { protocolVersion: invocation.protocolVersion }),
                ...(invocation.subject === undefined ? {} : { subject: { ...invocation.subject } }),
            },
        }, {
            signal: invocation.signal,
            interfacePort: {
                async request(operation, input) {
                    if (operation === "stream.send") {
                        await stream.send(readStreamMessage(input));
                        return undefined;
                    }
                    if (operation === "stream.close") {
                        await stream.close(input);
                        return undefined;
                    }
                    throw new TypeError(`Unsupported Control stream interface operation: ${operation}.`);
                },
            },
        });
    };
}

function validateStreamBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is ControlStreamBinding {
    if (typeof binding !== "function")
        throw new TypeError(`Extension ${context.extensionId} control.streams/${context.id} binding must be a function.`);
}

function readStreamMessage(input: ExtensionJsonValue | undefined): ControlStreamMessage {
    const value = readExtensionRecord(input, "Control stream message");
    if (Object.keys(value).some((key) => key !== "name" && key !== "payload" && key !== "seq"))
        throw new TypeError("Control stream message contains unknown fields.");
    if (value.seq !== undefined && (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0))
        throw new TypeError("Control stream message seq must be a non-negative integer.");
    return {
        name: readExtensionString(value.name, "name"),
        ...(value.payload === undefined ? {} : { payload: value.payload }),
        ...(value.seq === undefined ? {} : { seq: value.seq }),
    };
}
