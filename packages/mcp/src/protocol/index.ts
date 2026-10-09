import { createToolCallProvenanceRuntime, type ToolCallProvenanceApi } from "@portable-devshell/shared";

/** Protocol-scoped provenance survives HTTP listener replacement. */
export class McpProtocolRuntime {
    readonly provenance: ToolCallProvenanceApi;
    constructor(filePath: string) { this.provenance = createToolCallProvenanceRuntime(filePath); }
    async close(): Promise<void> { await this.provenance.flush(); }
}
