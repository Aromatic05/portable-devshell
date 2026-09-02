export const TESTSPACE_INSTANCE = "testspace-local";
export const TESTSPACE_REVERSE_INSTANCE = "testspace-reverse";
export const DEFAULT_TESTSPACE_COMMAND = "start";
const USER_TESTSPACE_COMMANDS = new Set([
    "comment-smoke",
    "exec",
    "smoke",
    "status",
    "stop",
    "tui",
    "web",
    "web-smoke",
]);

export function resolveTestspaceCommand(value) {
    if (value === undefined || value === "start" || value.startsWith("-")) {
        return DEFAULT_TESTSPACE_COMMAND;
    }
    if (value === "connector-loop") return value;
    return USER_TESTSPACE_COMMANDS.has(value) ? value : "invalid";
}

export function resolveTestspaceInvocation(argv) {
    const command = resolveTestspaceCommand(argv[0]);
    const args = command === DEFAULT_TESTSPACE_COMMAND && argv[0]?.startsWith("-")
        ? argv
        : argv.slice(1);
    return { args, command };
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

export function buildTestspaceInstanceConfig() {
    return [
        "version = 3",
        `name = "${TESTSPACE_INSTANCE}"`,
        "enabled = true",
        'provider = "local"',
        "",
        "[mcp]",
        "enabled = true",
        'auth = "none"',
        `path = "/${TESTSPACE_INSTANCE}/mcp"`,
        "",
        "[mcp.tools]",
        'groups = ["file", "bash", "artifact", "tmux", "todo", "instance"]',
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

export function buildTestspaceReverseInstanceConfig() {
    return [
        "version = 3",
        `name = "${TESTSPACE_REVERSE_INSTANCE}"`,
        "enabled = true",
        'provider = "reverse"',
        "",
        "[mcp]",
        "enabled = true",
        'auth = "none"',
        `path = "/${TESTSPACE_REVERSE_INSTANCE}/mcp"`,
        "",
        "[mcp.tools]",
        'groups = ["file", "bash", "artifact", "tmux", "todo", "instance"]',
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
        reverseMcp: `http://127.0.0.1:${mcpPort}/${TESTSPACE_REVERSE_INSTANCE}/mcp`,
        web: `http://127.0.0.1:${webPort}/web/`,
    };
}
