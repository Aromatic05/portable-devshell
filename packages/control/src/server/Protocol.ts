import {
    CONTROL_PROTOCOL_VERSION,
    TRANSPORT_PROTOCOL_VERSION_UNSUPPORTED_CODE,
    controlErrorCodes,
    createRemoteError,
    type ControlClientKind,
    type ControlProtocolHelloResponse,
    type JsonValue,
} from "@portable-devshell/shared";

export interface ControlHelloRequest {
    clientKind: ControlClientKind;
    clientVersion?: string;
    protocolRange: {
        max: string;
        min: string;
    };
}

export function negotiateControlProtocol(
    payload: JsonValue | undefined,
    peer: ControlClientKind,
): ControlProtocolHelloResponse {
    const request = readControlHelloRequest(payload);
    if (request.clientKind !== peer) {
        throw createRemoteError({
            code: controlErrorCodes.clientIdentityInvalid,
            message: `server.hello clientKind ${request.clientKind} does not match ${peer}.`,
            retryable: false,
        });
    }
    if (
        compareProtocolVersion(
            request.protocolRange.min,
            CONTROL_PROTOCOL_VERSION,
        ) > 0 ||
        compareProtocolVersion(
            request.protocolRange.max,
            CONTROL_PROTOCOL_VERSION,
        ) < 0
    ) {
        throw createRemoteError({
            code: TRANSPORT_PROTOCOL_VERSION_UNSUPPORTED_CODE,
            details: {
                clientMaxProtocolVersion: request.protocolRange.max,
                clientMinProtocolVersion: request.protocolRange.min,
                serverProtocolVersion: CONTROL_PROTOCOL_VERSION,
            },
            message: "Control RPC protocol version is not supported.",
            retryable: false,
        });
    }
    return {
        capabilities: ["request", "stream", "streamResume"],
        protocolVersion: CONTROL_PROTOCOL_VERSION,
    };
}

export function readControlHelloRequest(
    payload: JsonValue | undefined,
): ControlHelloRequest {
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    )
        throw invalidHello("server.hello requires an object payload.");
    const clientKind = payload.clientKind;
    if (clientKind !== "cli" && clientKind !== "tui" && clientKind !== "web")
        throw invalidHello(
            "server.hello clientKind must be cli, tui, or web.",
        );
    if (
        payload.clientVersion !== undefined &&
        typeof payload.clientVersion !== "string"
    )
        throw invalidHello("server.hello clientVersion must be a string.");
    const base: Pick<ControlHelloRequest, "clientKind" | "clientVersion"> = {
        clientKind,
        ...(payload.clientVersion === undefined
            ? {}
            : { clientVersion: payload.clientVersion }),
    };
    if (payload.protocolRange === undefined)
        throw invalidHello(
            "server.hello requires protocolRange with semantic versions.",
        );
    return {
        ...base,
        protocolRange: readProtocolRange(payload.protocolRange),
    };
}

function readProtocolRange(value: JsonValue): { max: string; min: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw invalidHello("server.hello protocolRange must be an object.");
    const min = value.min;
    const max = value.max;
    if (typeof min !== "string" || typeof max !== "string")
        throw invalidHello(
            "server.hello protocolRange min and max must be semantic versions.",
        );
    parseProtocolVersion(min);
    parseProtocolVersion(max);
    if (compareProtocolVersion(min, max) > 0)
        throw invalidHello(
            "server.hello protocolRange min must not exceed max.",
        );
    return { max, min };
}

function compareProtocolVersion(left: string, right: string): number {
    const leftVersion = parseProtocolVersion(left);
    const rightVersion = parseProtocolVersion(right);
    if (leftVersion.major !== rightVersion.major)
        return leftVersion.major - rightVersion.major;
    if (leftVersion.minor !== rightVersion.minor)
        return leftVersion.minor - rightVersion.minor;
    return leftVersion.patch - rightVersion.patch;
}

function parseProtocolVersion(value: string): {
    major: number;
    minor: number;
    patch: number;
} {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
    if (match === null)
        throw invalidHello(`Invalid Control protocol version ${value}.`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger))
        throw invalidHello(`Invalid Control protocol version ${value}.`);
    return { major, minor, patch };
}

function invalidHello(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}
