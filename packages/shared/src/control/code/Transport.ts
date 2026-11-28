import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { JsonValue } from "../../types/Json.js";
import type { ControlStreamMessage } from "../server/Route.js";
import type {
    CodeDescribeRequest,
    CodeDescribeResult,
    CodeEvalMeta,
    CodeEvalRequest,
    CodeEvalResult,
    CodeLogEntry,
    CodeLogLevel,
} from "./Model.js";

export interface CodeEvalStreamOptions {
    readonly onLog?: (entry: CodeLogEntry) => void;
    readonly signal?: AbortSignal;
}

export interface CodeTransport {
    describe(
        request?: CodeDescribeRequest,
        signal?: AbortSignal,
    ): Promise<CodeDescribeResult>;
    eval(
        request: CodeEvalRequest,
        options?: CodeEvalStreamOptions,
    ): Promise<CodeEvalResult>;
}

export function createCodeTransport(endpoint: Endpoint): CodeTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "code");
    return {
        describe: (request = {}, signal) =>
            port.request<CodeDescribeResult>("describe", request, signal),
        eval: async (request, options = {}) => {
            options.signal?.throwIfAborted();
            const stream = await port.open("eval", request, options.signal);
            const aborted = () => {
                const reason = options.signal?.reason;
                const message =
                    reason instanceof Error
                        ? reason.message
                        : "Code execution was aborted.";
                void stream.cancel({ message });
            };
            options.signal?.addEventListener("abort", aborted, { once: true });
            try {
                while (true) {
                    const next = await stream.readMessage();
                    if (next.type === "close")
                        return readEvalResult(next.message as JsonValue | undefined);
                    if (next.type === "fin") continue;
                    const event = next.message as ControlStreamMessage;
                    if (event.name === "log") {
                        const entry = readLogEntry(event.payload);
                        options.onLog?.(entry);
                    }
                }
            } finally {
                options.signal?.removeEventListener("abort", aborted);
            }
        },
    };
}

function readEvalResult(value: JsonValue | undefined): CodeEvalResult {
    const body = readRecord(value, "Code eval result");
    if (typeof body.hasValue !== "boolean")
        throw new TypeError("Code eval result hasValue must be a boolean.");
    if (!Array.isArray(body.logs))
        throw new TypeError("Code eval result logs must be an array.");
    const logs = body.logs.map((entry) => readLogEntry(entry));
    const meta = readEvalMeta(body.meta);
    return {
        hasValue: body.hasValue,
        logs,
        meta,
        ...(body.hasValue ? { value: body.value } : {}),
    };
}

function readEvalMeta(value: JsonValue | undefined): CodeEvalMeta {
    const body = readRecord(value, "Code eval meta");
    if (typeof body.callId !== "string")
        throw new TypeError("Code eval meta callId must be a string.");
    if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs))
        throw new TypeError("Code eval meta durationMs must be a finite number.");
    if (typeof body.toolCalls !== "number" || !Number.isSafeInteger(body.toolCalls))
        throw new TypeError("Code eval meta toolCalls must be an integer.");
    if (typeof body.truncatedLogs !== "boolean")
        throw new TypeError("Code eval meta truncatedLogs must be a boolean.");
    if (typeof body.truncatedValue !== "boolean")
        throw new TypeError("Code eval meta truncatedValue must be a boolean.");
    return {
        callId: body.callId,
        durationMs: body.durationMs,
        toolCalls: body.toolCalls,
        truncatedLogs: body.truncatedLogs,
        truncatedValue: body.truncatedValue,
    };
}

function readLogEntry(value: JsonValue | undefined): CodeLogEntry {
    const body = readRecord(value, "Code log entry");
    if (!isLogLevel(body.level))
        throw new TypeError("Code log entry level is invalid.");
    if (typeof body.text !== "string")
        throw new TypeError("Code log entry text must be a string.");
    if (typeof body.timestampMs !== "number" || !Number.isFinite(body.timestampMs))
        throw new TypeError("Code log entry timestampMs must be a finite number.");
    return {
        level: body.level,
        text: body.text,
        timestampMs: body.timestampMs,
    };
}

function isLogLevel(value: JsonValue | undefined): value is CodeLogLevel {
    return (
        value === "log" ||
        value === "info" ||
        value === "warn" ||
        value === "error"
    );
}

function readRecord(
    value: JsonValue | undefined,
    label: string,
): Record<string, JsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value;
    throw new TypeError(`${label} must be an object.`);
}
