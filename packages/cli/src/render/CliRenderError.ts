import { toControlErrorBody, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";

export interface CliRenderErrorOptions {
    cause?: ControlErrorBody;
    details?: JsonValue;
    retryable?: boolean;
}

export class CliRenderError extends Error {
    readonly code: string;
    readonly causeBody?: ControlErrorBody;
    readonly details?: JsonValue;
    readonly retryable?: boolean;

    constructor(code: string, message: string, options: CliRenderErrorOptions = {}) {
        super(message);
        this.name = "CliRenderError";
        this.code = code;
        this.causeBody = options.cause;
        this.details = options.details;
        this.retryable = options.retryable;
    }

    static usage(message: string): CliRenderError {
        return new CliRenderError("cli.usage", message);
    }
}

export function renderCliError(error: unknown, options: { debug?: boolean; verbose?: boolean } = {}): string {
    const body = readErrorBody(error);

    if (options.debug) {
        return `${JSON.stringify(body ?? { message: readMessage(error) }, null, 2)}\n`;
    }

    const message =
        body?.message ??
        (error instanceof Error
            ? error.message
            : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
              ? error.message
              : String(error));
    const code = body?.code;

    if (code === "control.notRunning") {
        return `${message}\nRun: devshell start\n`;
    }

    const lines = [message];
    const details = body?.details && typeof body.details === "object" && body.details !== null && !Array.isArray(body.details)
        ? (body.details as Record<string, JsonValue>)
        : undefined;

    for (const line of renderDiagnosticSummary(details)) {
        lines.push(line);
    }

    if (options.verbose) {
        for (const line of renderVerboseDetails(details, body?.cause)) {
            lines.push(line);
        }
    }

    return `${lines.join("\n")}\n`;
}

function renderDiagnosticSummary(details: Record<string, JsonValue> | undefined): string[] {
    if (details === undefined) {
        return [];
    }

    const lines: string[] = [];

    pushLine(lines, "provider", details.provider);
    pushLine(lines, "instance", details.instance);
    pushLine(lines, "operation", details.operation);
    pushLine(lines, "command", details.commandDisplay);
    pushLine(lines, "cwd", details.cwd);
    pushLine(lines, "exitCode", details.exitCode);
    pushLine(lines, "signal", details.signal);
    pushLine(lines, "cause", details.causeMessage);
    pushTail(lines, "stderr", details.stderrTail);
    pushTail(lines, "stdout", details.stdoutTail);

    return lines;
}

function renderVerboseDetails(details: Record<string, JsonValue> | undefined, cause: ControlErrorBody | undefined): string[] {
    const lines: string[] = [];

    if (details !== undefined) {
        lines.push(`details: ${JSON.stringify(details, null, 2)}`);
    }

    if (cause !== undefined) {
        lines.push(`cause: ${JSON.stringify(cause, null, 2)}`);
    }

    return lines;
}

function pushLine(lines: string[], label: string, value: JsonValue | undefined): void {
    if (typeof value === "string" || typeof value === "number") {
        lines.push(`${label}: ${value}`);
    }
}

function pushTail(lines: string[], label: string, value: JsonValue | undefined): void {
    if (typeof value !== "string" || value.length === 0) {
        return;
    }

    lines.push(`${label}:`);
    lines.push(value.replace(/\n$/u, ""));
}

function readErrorBody(error: unknown): ControlErrorBody | undefined {
    if (typeof error === "object" && error !== null && "causeBody" in error && "code" in error && "message" in error) {
        const candidate = error as {
            causeBody?: ControlErrorBody;
            code?: string;
            details?: JsonValue;
            message?: string;
            retryable?: boolean;
        };

        if (typeof candidate.code === "string" && typeof candidate.message === "string") {
            return {
                code: candidate.code,
                ...(candidate.causeBody === undefined ? {} : { cause: candidate.causeBody }),
                ...(candidate.details === undefined ? {} : { details: candidate.details }),
                message: candidate.message,
                retryable: candidate.retryable === true
            };
        }
    }

    return toControlErrorBody(error);
}

function readMessage(error: unknown): string {
    return error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : String(error);
}
