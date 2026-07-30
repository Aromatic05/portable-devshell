import { formatHint, type ToolDiagnosticHint } from "./ToolDiagnosticHint.js";

export function mergeComments(
    userComments: readonly string[],
    hints: readonly ToolDiagnosticHint[]
): string[] {
    const out: string[] = [];
    const seenStrings = new Set<string>();
    const seenCodes = new Set<string>();

    for (const comment of userComments) {
        if (typeof comment !== "string" || comment.length === 0) continue;
        if (seenStrings.has(comment)) continue;
        seenStrings.add(comment);
        out.push(comment);
    }

    for (const hint of hints) {
        if (seenCodes.has(hint.code)) continue;
        seenCodes.add(hint.code);
        const formatted = formatHint(hint);
        if (seenStrings.has(formatted)) continue;
        seenStrings.add(formatted);
        out.push(formatted);
    }

    return out;
}
