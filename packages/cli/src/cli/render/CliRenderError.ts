export class CliRenderError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "CliRenderError";
        this.code = code;
    }

    static usage(message: string): CliRenderError {
        return new CliRenderError("cli.usage", message);
    }
}

export function renderCliError(error: unknown): string {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
              ? error.message
              : String(error);
    const code =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined;

    if (code === "control.notRunning") {
        return `${message}\nRun: devshell start\n`;
    }

    return `${message}\n`;
}
