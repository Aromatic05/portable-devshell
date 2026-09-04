export interface McpToolProvenanceRecord {
    callId: string;
    explanation?: string;
    instance: string;
    purpose?: string;
}

export interface McpToolProvenanceRecorder {
    record(record: McpToolProvenanceRecord): Promise<void>;
}
