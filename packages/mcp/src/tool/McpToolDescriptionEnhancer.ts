export class McpToolDescriptionEnhancer {
    enhance(description: string | undefined): string {
        return description?.trim() ?? "";
    }
}
