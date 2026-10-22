import {
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    connectControlChannel,
    createApprovalTransport,
    createCliCommandTransport,
    createConfigTransport,
    createInstanceTransport,
    createContextTransport,
    createDebugTransport,
    createExtensionRuntimeTransport,
    createAuthTransport,
    createMessageTransport,
    createOverviewTransport,
    createConnectionTransport,
    createProcessTransport,
    createServerTransport,
    createToolTransport,
    type ApprovalTransport,
    type ConfigTransport,
    type InstanceTransport,
    type ContextTransport,
    type ControlChannelOptions,
    type DebugTransport,
    type ExtensionRuntimeTransport,
    type AuthTransport,
    type MessageTransport,
    type OverviewTransport,
    type ConnectionTransport,
    type ProcessTransport,
    type ServerTransport,
    type ToolTransport,
} from "@portable-devshell/shared";

import { CliRenderError } from "../app/Failure.js";
import { createCliRuntimeAdapter, type CliClientRuntime } from "./Runtime.js";
import { createCliCommandAdapter, type CliClientCommand } from "./Command.js";
import { CliClientEventStream } from "./Stream.js";

export { CliClientEventStream };

export interface CliClientOptions extends ControlChannelOptions {}

/**
 * CLI-local dependency surface. It carries the explicitly named domain
 * transports the stateless CLI composes over one shared Endpoint; it holds no
 * aggregate snapshot or subscription policy.
 */
export interface CliClients {
    approval(instance: string): ApprovalTransport;
    cli: CliClientCommand;
    config: ConfigTransport;
    context: ContextTransport;
    contextMessage: MessageTransport;
    debug: DebugTransport;
    extension: ExtensionRuntimeTransport;
    instance: InstanceTransport;
    mcp: AuthTransport;
    overview: OverviewTransport;
    reverse: ConnectionTransport;
    runtime(instance: string): CliClientRuntime;
    server: ServerTransport;
    tool(instance: string): ToolTransport;
    close(): void;
    reconnect(): Promise<void>;
}

export function createCliClients(options: CliClientOptions = {}): CliClients {
    const endpoint = new Endpoint({
        connectChannel: (signal) => connectControlChannel(options, signal),
    });
    return {
        approval: (instance) => createApprovalTransport(endpoint, instance),
        cli: createCliCommandAdapter(
            endpoint,
            createCliCommandTransport(endpoint),
        ),
        config: createConfigTransport(endpoint),
        context: createContextTransport(endpoint),
        contextMessage: createMessageTransport(endpoint),
        debug: createDebugTransport(endpoint),
        extension: createExtensionRuntimeTransport(endpoint),
        instance: createInstanceTransport(endpoint),
        mcp: createAuthTransport(endpoint),
        overview: createOverviewTransport(endpoint),
        reverse: createConnectionTransport(endpoint),
        runtime: (instance) => {
            const runtime: ProcessTransport = createProcessTransport(
                endpoint,
                instance,
            );
            return createCliRuntimeAdapter(endpoint, instance, runtime);
        },
        server: createServerTransport(endpoint, { clientKind: "cli" }),
        tool: (instance) => createToolTransport(endpoint, instance),
        close: () => endpoint.close(),
        reconnect: async () => await endpoint.reconnect(),
    };
}

export async function negotiateCliControl(clients: CliClients): Promise<void> {
    const hello = await clients.server.hello();
    if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
        throw new CliRenderError(
            "control.protocolVersionMismatch",
            `Incompatible control protocol version: ${hello.protocolVersion}.`,
        );
    }
}
