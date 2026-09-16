import type {
    WorkerExecProcessInput,
    WorkerTcpConnectInput,
} from "./Model.js";

const encoder = new TextEncoder();

export function encodeTcpServiceMetadata(
    input: WorkerTcpConnectInput,
): Uint8Array {
    return encodeJson({ host: input.host, port: input.port });
}

export function encodeExecServiceMetadata(
    input: WorkerExecProcessInput,
): Uint8Array {
    return encodeJson({
        ...(input.args === undefined ? {} : { args: [...input.args] }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        executable: input.executable,
    });
}

function encodeJson(value: unknown): Uint8Array {
    return encoder.encode(JSON.stringify(value));
}
