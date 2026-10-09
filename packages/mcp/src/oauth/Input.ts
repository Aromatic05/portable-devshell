export function readOAuthClientName(
    clientId: unknown,
    clientName: unknown,
): string {
    if (typeof clientName === "string" && clientName.length > 0) {
        return clientName;
    }
    if (typeof clientId === "string" && clientId.length > 0) {
        return clientId;
    }
    return "unknown-client";
}

export function readOAuthStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
}
