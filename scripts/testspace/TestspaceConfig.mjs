export const TESTSPACE_INSTANCE = "testspace-local";
export const DEFAULT_TESTSPACE_COMMAND = "start";
const USER_TESTSPACE_COMMANDS = new Set(["stop", "tui", "web"]);

export function resolveTestspaceCommand(value) {
    if (value === undefined) return DEFAULT_TESTSPACE_COMMAND;
    if (value === "connector-loop") return value;
    return USER_TESTSPACE_COMMANDS.has(value) ? value : "invalid";
}

export function buildTestspaceGlobalConfig({ mcpPort, webPort }) {
    return [
        "version = 2",
        "",
        "[control]",
        'logLevel = "info"',
        "",
        "[mcp]",
        "enabled = true",
        'listenHost = "127.0.0.1"',
        `listenPort = ${mcpPort}`,
        `publicBaseUrl = "http://127.0.0.1:${mcpPort}"`,
        "",
        "[web]",
        "enabled = true",
        'listenHost = "127.0.0.1"',
        `listenPort = ${webPort}`,
        `publicBaseUrl = "http://127.0.0.1:${webPort}"`,
        'auth = "none"',
        "",
    ].join("\n");
}

export function buildTestspaceInstanceConfig({ workspace }) {
    return [
        "version = 2",
        `name = "${TESTSPACE_INSTANCE}"`,
        "enabled = true",
        'provider = "local"',
        `workspace = ${JSON.stringify(workspace)}`,
        "",
        "[mcp]",
        "enabled = true",
        'auth = "none"',
        `path = "/${TESTSPACE_INSTANCE}/mcp"`,
        "",
        "[mcp.tools]",
        'groups = ["file", "bash", "artifact", "tmux", "todo", "context", "instance"]',
        'capabilities = ["read", "write", "execute", "manage"]',
        "",
        "[approvalPolicy]",
        'mode = "allow"',
        "",
        "[security]",
        'mode = "workspace"',
        "",
        "[logs]",
        "eventBufferSize = 500",
        "maxBytes = 16777216",
        "retentionDays = 7",
        "",
    ].join("\n");
}

export function testspaceUrls({ mcpPort, webPort }) {
    return {
        mcp: `http://127.0.0.1:${mcpPort}/${TESTSPACE_INSTANCE}/mcp`,
        web: `http://127.0.0.1:${webPort}/web/`,
    };
}
