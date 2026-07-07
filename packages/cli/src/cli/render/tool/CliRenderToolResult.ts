import type { CliCommandResult } from "../../control/CliControlStream.js";

export function renderToolResult(result: CliCommandResult): string {
    const sections = [`exitCode: ${result.exitCode}`];

    if (result.stdout.length > 0) {
        sections.push(`stdout:\n${result.stdout.replace(/\n$/u, "")}`);
    }

    if (result.stderr.length > 0) {
        sections.push(`stderr:\n${result.stderr.replace(/\n$/u, "")}`);
    }

    return `${sections.join("\n")}\n`;
}
