/** Shared sanitization for Inline cards and the Live Workspace audit projection.
 * Sanitization is applied before any presentation truncation.
 */
const privateKeyName = /password|secret|token|credential|authorization|api.?key|private.?key|cookie|^_meta$/iu;
const privateAssignment = /((?:password|secret|token|credential|authorization|api[_-]?key|private[_-]?key|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const bearerToken = /(Bearer\s+)[A-Za-z0-9._~+/-]+/giu;
const privateKeyBlock = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu;

export function isPresentationSecretKey(key: string): boolean {
    return privateKeyName.test(key);
}

export function isPresentationBinaryPayload(key: string, value: unknown): boolean {
    return (key === "data" || key === "base64") && typeof value === "string" && value.length > 1_024;
}

export function redactPresentationText(text: string): string {
    return text.replace(privateKeyBlock, "[redacted private key]")
        .replace(bearerToken, "$1[redacted]")
        .replace(privateAssignment, "$1[redacted]");
}
