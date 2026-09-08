import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type { McpProfile } from "./McpProfileStore.js";

export interface McpClientPort {
    callTool(name: string, input: Record<string, ExtensionJsonValue>, signal: AbortSignal): Promise<ExtensionJsonValue>;
    close(): Promise<void>;
    listTools(signal: AbortSignal): Promise<ExtensionJsonValue>;
}

export interface McpClientFactory {
    connect(profile: McpProfile, signal: AbortSignal): Promise<McpClientPort>;
}

export class McpHttpClientFactory implements McpClientFactory {
    readonly #version: string;

    constructor(version: string) {
        this.#version = version;
    }

    async connect(profile: McpProfile, signal: AbortSignal): Promise<McpClientPort> {
        const client = new Client({ name: "portable-devshell", version: this.#version });
        const transport = new StreamableHTTPClientTransport(new URL(profile.url));
        try {
            await client.connect(transport, { signal });
        } catch (error) {
            await client.close().catch(() => undefined);
            throw error;
        }
        return {
            callTool: async (name, input, requestSignal) => toJson(await client.callTool(
                { arguments: input, name },
                { signal: requestSignal }
            )),
            close: async () => await client.close(),
            listTools: async (requestSignal) => toJson(await client.listTools(undefined, { signal: requestSignal }))
        };
    }
}

function toJson(value: unknown): ExtensionJsonValue {
    return JSON.parse(JSON.stringify(value)) as ExtensionJsonValue;
}
