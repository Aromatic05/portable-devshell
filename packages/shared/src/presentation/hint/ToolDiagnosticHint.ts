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
