export interface ToolDiagnosticHint {
    readonly code: string;
    readonly kind: "diagnostic" | "error";
    readonly text: string;
}

export function formatHint(hint: ToolDiagnosticHint): string {
    return `[${hint.code}] ${hint.text}`;
}

export function errorHint(code: string, text: string): ToolDiagnosticHint {
    return { code, kind: "error", text };
}

export function diagnosticHint(code: string, text: string): ToolDiagnosticHint {
    return { code, kind: "diagnostic", text };
}

export interface CommentAdvice {
    code?: string;
    text: string;
}

export function composeComments(advice: readonly CommentAdvice[]): string[] {
    const out: string[] = [];
    const seenCodes = new Set<string>();
    const seenTexts = new Set<string>();

    for (const entry of advice) {
        if (typeof entry.text !== "string" || entry.text.length === 0) continue;
        if (entry.code !== undefined) {
            if (seenCodes.has(entry.code)) continue;
            seenCodes.add(entry.code);
        }
        if (seenTexts.has(entry.text)) continue;
        seenTexts.add(entry.text);
        out.push(entry.text);
    }

    return out;
}

export function mergeComments(
    userComments: readonly string[],
    hints: readonly ToolDiagnosticHint[],
): string[] {
    return composeComments([
        ...userComments.map((text) => ({ text })),
        ...hints.map((hint) => ({ code: hint.code, text: formatHint(hint) })),
    ]);
}
