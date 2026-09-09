import type { JsonValue } from "@portable-devshell/shared";

interface CommandResultLike {
    exitCode: number | null;
    stderr: string;
    stdout: string;
}

export function renderToolResult(result: JsonValue): string {
    if (!isCommandResult(result)) {
        return `${JSON.stringify(result, null, 2)}\n`;
    }

    const sections = [`exitCode: ${result.exitCode}`];

    if (result.stdout.length > 0) {
        sections.push(`stdout:\n${result.stdout.replace(/\n$/u, "")}`);
    }

    if (result.stderr.length > 0) {
        sections.push(`stderr:\n${result.stderr.replace(/\n$/u, "")}`);
    }

    return `${sections.join("\n")}\n`;
}

function isCommandResult(value: JsonValue): value is JsonValue & CommandResultLike {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    return (
        (typeof candidate.exitCode === "number" || candidate.exitCode === null) &&
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string"
    );
}
