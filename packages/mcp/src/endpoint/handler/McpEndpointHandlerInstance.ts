import type { JsonValue } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogInstanceName } from "../../tool/catalog/McpToolCatalogInstance.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { assertMcpNoArguments, readMcpInstanceName, readMcpSshCreateInput } from "../McpEndpointInput.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerInstance {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(toolName: McpToolCatalogInstanceName, input: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "instance_list":
                assertMcpNoArguments(input, toolName);
                return { instances: await waitForMcpEndpointAbortable(gateway.listInstances(), signal) };
            case "instance_status":
                return await waitForMcpEndpointAbortable(gateway.statusInstance(readMcpInstanceName(input, toolName)), signal);
            case "instance_start":
                return await waitForMcpEndpointAbortable(gateway.startInstance(readMcpInstanceName(input, toolName)), signal);
            case "instance_stop":
                return await waitForMcpEndpointAbortable(gateway.stopInstance(readMcpInstanceName(input, toolName)), signal);
            case "instance_create":
                return await waitForMcpEndpointAbortable(
                    gateway.createSshInstance(this.options.instanceName, readMcpSshCreateInput(input)),
                    signal
                );
        }
    }
}
