import type {
    ToolNameHandle,
    ToolNameRegistrar,
} from "@portable-devshell/core/toolcall";
import {
    mcpAllInstances,
    mcpTools,
    type McpToolRegistration,
} from "@portable-devshell/mcp/tool";
import {
    Endpoint,
    Rpc,
    type ToolDefinition,
} from "@portable-devshell/shared";

const MCP_TOOL_NAME_PORT = "mcp-tool-name";
const TOOLCALL_TOOL_NAME_PORT = "toolcall-tool-name";

export class McpToolNameTransport {
    readonly registerToolName: ToolNameRegistrar;
    readonly #client: Rpc;
    readonly #endpoint: Endpoint;
    readonly #local = new Map<string, ToolNameHandle>();
    readonly #pending = new Set<Promise<void>>();
    readonly #registrations = new Map<string, McpToolRegistration>();
    readonly #server: Rpc;
    readonly #failures: unknown[] = [];

    constructor() {
        const endpoint = new Endpoint();
        this.#endpoint = endpoint;
        this.#server = new Rpc(endpoint.bind(MCP_TOOL_NAME_PORT), {
            register: async (message, context) => {
                const name = readToolName(message);
                const handle = async (): Promise<ToolDefinition> =>
                    await context.request<ToolDefinition>("definition", {
                        name,
                    });
                const definition = await handle();
                if (definition.name !== name)
                    throw new Error(
                        `Tool definition ${definition.name} does not match registered name ${name}.`,
                    );
                if (this.#registrations.has(name))
                    throw new Error(`Tool name already registered: ${name}`);
                this.#registrations.set(
                    name,
                    mcpTools.register(mcpAllInstances, [definition]),
                );
                return {};
            },
            unregister: (message) => {
                const name = readToolName(message);
                this.#registrations.get(name)?.dispose();
                this.#registrations.delete(name);
                return {};
            },
        });
        this.#client = new Rpc(
            endpoint
                .bind(TOOLCALL_TOOL_NAME_PORT)
                .connect(endpoint.host, MCP_TOOL_NAME_PORT),
            {
                definition: async (message) => {
                    const name = readToolName(message);
                    const handle = this.#local.get(name);
                    if (handle === undefined)
                        throw new Error(
                            `Tool name registration is unavailable: ${name}`,
                        );
                    return await handle();
                },
            },
        );
        this.registerToolName = (name, handle) => {
            this.#local.set(name, handle);
            const registered = this.#client
                .request("register", { name })
                .then(() => undefined);
            this.#track(registered);
            let disposed = false;
            return () => {
                if (disposed) return;
                disposed = true;
                const unregistered = registered
                    .then(() => this.#client.request("unregister", { name }))
                    .then(() => undefined)
                    .finally(() => {
                        if (this.#local.get(name) === handle)
                            this.#local.delete(name);
                    });
                this.#track(unregistered);
            };
        };
    }

    async flush(): Promise<void> {
        while (this.#pending.size > 0)
            await Promise.all([...this.#pending]);
        if (this.#failures.length === 0) return;
        const failures = this.#failures.splice(0);
        throw new AggregateError(
            failures,
            "MCP tool-name transport failed.",
        );
    }

    close(): void {
        this.#client.close();
        this.#server.close();
        this.#endpoint.close();
        for (const registration of this.#registrations.values())
            registration.dispose();
        this.#registrations.clear();
        this.#local.clear();
    }

    #track(operation: Promise<void>): void {
        const tracked = operation
            .catch((error) => {
                this.#failures.push(error);
            })
            .finally(() => {
                this.#pending.delete(tracked);
            });
        this.#pending.add(tracked);
    }
}

function readToolName(value: unknown): string {
    if (
        typeof value !== "object" ||
        value === null ||
        !("name" in value) ||
        typeof value.name !== "string" ||
        value.name.length === 0
    )
        throw new Error("Tool name registration requires a name.");
    return value.name;
}
