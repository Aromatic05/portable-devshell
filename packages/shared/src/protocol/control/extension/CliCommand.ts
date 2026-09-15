export interface CliCommandDescriptor {
    extensionId: string;
    id: string;
    summary?: string;
    title: string;
    usage?: string;
}

export interface CliCommandWireResult {
    kind: "json" | "text";
    text?: string;
    value?: import("../../JsonValue.js").JsonValue;
}
