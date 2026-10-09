import { createToolCallProvenanceRuntime, type ToolCallProvenanceApi } from "@portable-devshell/shared";

/** Persistent Protocol state survives HTTP generations; McpProtocolRoute owns per-generation Endpoints/Bindings. */
export class McpProtocolRuntime {
    readonly provenance: ToolCallProvenanceApi;
    constructor(filePath: string) { this.provenance = createToolCallProvenanceRuntime(filePath); }
    async close(): Promise<void> { await this.provenance.flush(); }
}
