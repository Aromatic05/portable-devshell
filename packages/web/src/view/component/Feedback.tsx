export function PartialFailures({ failures }: { failures: Record<string, string> }) {
    const entries = Object.entries(failures).sort(([left], [right]) =>
        left.localeCompare(right)
    );
    if (entries.length === 0) return null;
    return <details className="partial" role="status">
        <summary>{entries.length} data source{entries.length === 1 ? "" : "s"} could not be refreshed. Other data remains available.</summary>
        <ul>
            {entries.map(([key, error]) => <li key={key}><strong>{label(key)}</strong>: {error}</li>)}
        </ul>
    </details>;
}

function label(key: string): string {
    const [kind, instance] = key.split(":", 2);
    const names: Record<string, string> = {
        approvals: "Approvals",
        commentCalls: "Comment calls",
        contextMessages: "Context messages",
        instance: "Instance state",
        logs: "Logs",
        mcp: "MCP status",
        oauthApprovals: "OAuth approvals",
        overview: "Overview",
        stream: "Live updates",
        todos: "Todos",
        toolCalls: "Tool calls",
    };
    return instance === undefined
        ? (names[kind ?? ""] ?? key)
        : `${instance} · ${names[kind ?? ""] ?? kind}`;
}
