export interface McpHostRouteMatch {
    instanceName: string;
}

export class McpHostRouteMatcher {
    match(pathname: string): McpHostRouteMatch | undefined {
        const trimmed = pathname.trim();
        const segments = trimmed.split("/");

        if (segments.length !== 3 || segments[0] !== "" || segments[2] !== "mcp") {
            return undefined;
        }

        const instanceName = segments[1];

        if (instanceName.length === 0) {
            return undefined;
        }

        return { instanceName };
    }
}
