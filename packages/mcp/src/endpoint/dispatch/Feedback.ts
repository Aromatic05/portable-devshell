export class McpEndpointCallError extends Error {
    readonly feedback: readonly string[];
    readonly original: unknown;

    constructor(error: unknown, feedback: readonly string[]) {
        super(
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? { cause: error } : undefined,
        );
        this.name = "McpEndpointCallError";
        this.original = error;
        this.feedback = Object.freeze([...feedback]);
    }
}
