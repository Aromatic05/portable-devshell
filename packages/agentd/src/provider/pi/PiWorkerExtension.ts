import type { ToolDefinition } from "@portable-devshell/shared";

import {
    createPiWorkerToolsFromDefinitions,
    type PiWorkerTool,
    type PiWorkerToolExecutor
} from "./PiWorkerTools.js";

export interface PiExtensionApiLike {
    registerTool(tool: PiWorkerTool): void;
}

export interface PiInlineExtensionLike {
    factory(api: PiExtensionApiLike): void;
    hidden?: boolean;
    name: string;
}

/**
 * Pi-side adapter for the existing devshell Worker capability surface.
 *
 * The Agent session only knows that a hidden extension registered tools. Worker
 * transport, instance ownership, workspace binding and audit policy remain
 * outside Pi and are never exposed through the extension contract.
 */
export function createPiWorkerExtensionFromDefinitions(
    definitions: readonly ToolDefinition[],
    execute: PiWorkerToolExecutor
): PiInlineExtensionLike {
    const tools = createPiWorkerToolsFromDefinitions(definitions, execute);
    return {
        factory(api) {
            for (const tool of tools) api.registerTool(tool);
        },
        hidden: true,
        name: "devshell-worker"
    };
}
