/**
 * Raw-fetch helpers for the strict modern MCP protocol revision (2026-07-28).
 *
 * The 2025 stateless fallback was removed from `McpEndpointBinding`, so a
 * request must carry the documented per-request `_meta` envelope plus the
 * standard `MCP-Protocol-Version` / `Mcp-Method` (and, for named methods,
 * `Mcp-Name`) request headers. These helpers build exactly that wire shape so
 * integration tests exercise the real modern handshake instead of the retired
 * legacy one.
 */

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY =
    "io.modelcontextprotocol/clientCapabilities";

export interface ModernEnvelope {
    [PROTOCOL_VERSION_META_KEY]: string;
    [CLIENT_INFO_META_KEY]: { name: string; version: string };
    [CLIENT_CAPABILITIES_META_KEY]: Record<string, unknown>;
}

export function modernEnvelope(
    extra: Record<string, unknown> = {},
): ModernEnvelope & Record<string, unknown> {
    return {
        ...extra,
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: {
            name: "portable-devshell-integration-test",
            version: "0.0.0",
        },
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    };
}

export function modernRpcRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown> = {},
): Record<string, unknown> {
    const { _meta, ...rest } = params;
    return {
        id,
        jsonrpc: "2.0",
        method,
        params: {
            ...rest,
            _meta: modernEnvelope(
                typeof _meta === "object" && _meta !== null
                    ? (_meta as Record<string, unknown>)
                    : {},
            ),
        },
    };
}

/**
 * The standard request headers the modern path validates. `Mcp-Name` mirrors
 * `params.name` for `tools/call` / `prompts/get` and `params.uri` for
 * `resources/read`; it must be omitted for every other method.
 */
export function modernRpcHeaders(
    method: string,
    params: Record<string, unknown> = {},
): Record<string, string> {
    const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    };
    const nameSource = method === "resources/read" ? "uri" : "name";
    const name = params[nameSource];
    if (typeof name === "string") {
        headers["mcp-name"] = name;
    }
    return headers;
}

export function modernRequestInit(
    method: string,
    body: Record<string, unknown>,
): RequestInit {
    const params =
        typeof body.params === "object" && body.params !== null
            ? (body.params as Record<string, unknown>)
            : {};
    return {
        body: JSON.stringify(body),
        headers: modernRpcHeaders(method, params),
        method: "POST",
    };
}

/** POST one modern JSON-RPC message and return the raw response. */
export async function postModern(
    url: string,
    id: string | number,
    method: string,
    params: Record<string, unknown> = {},
): Promise<Response> {
    const body = modernRpcRequest(id, method, params);
    return await fetch(url, modernRequestInit(method, body));
}

/** Negotiate the modern protocol: `server/discover` carries the envelope. */
export async function discoverModern(url: string): Promise<Response> {
    return await postModern(url, "server-discover", "server/discover");
}
