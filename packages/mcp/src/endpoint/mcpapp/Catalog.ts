import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { mcpAppResourceUri } from "../../mcpapp/app/App.js";
import {
    mcpAppOpenOutputSchema,
    mcpAppGoalResultOutputSchema,
    mcpAppSnapshotOutputSchema,
    mcpAppActionOutputSchema,
    mcpAppWatchOutputSchema,
} from "./Schema.js";

export type McpToolCatalogMcpAppName =
    | "mcpapp_goal"
    | "mcpapp_open"
    | "mcpapp_reconnect"
    | "mcpapp_snapshot"
    | "mcpapp_watch"
    | "mcpapp_action";

const appOnlyMeta: JsonValue = {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true,
};

const goalStepSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        id: { maxLength: 128, minLength: 1, type: "string" },
        note: { maxLength: 2000, minLength: 1, type: "string" },
        status: {
            enum: ["pending", "active", "completed", "skipped"],
            type: "string",
        },
        text: { maxLength: 2000, minLength: 1, type: "string" },
    },
    required: ["id", "text"],
    type: "object",
};

export class McpToolCatalogMcpApp {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            description:
                "Manage optional McpApp Goal mode for the current Context. environ_info normally bootstraps the MCP App, so action=start does not require a separate mcpapp_open call while the App remains active. start creates one durable Goal with an objective and ordered steps. update revises the objective, complete step list, or one step. Completing or skipping the final remaining step completes the Goal automatically. block suspends automatic continuation with a reason; resume reactivates it. finish remains a compatibility action for an all-terminal live Goal. stop terminates Goal mode without stopping shell or tmux processes. get reads the current Goal. Use mcpapp_open only to re-present or restore an inactive App.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    /**
                     * @compat workspace-goal-finish
                     * @removeAt 0.7.10
                     */
                    action: {
                        enum: [
                            "start",
                            "get",
                            "update",
                            "block",
                            "resume",
                            "finish",
                            "stop",
                        ],
                        type: "string",
                    },
                    note: { maxLength: 2000, minLength: 1, type: "string" },
                    objective: {
                        maxLength: 4000,
                        minLength: 1,
                        type: "string",
                    },
                    status: {
                        enum: ["pending", "active", "completed", "skipped"],
                        type: "string",
                    },
                    stepId: { maxLength: 128, minLength: 1, type: "string" },
                    steps: {
                        items: goalStepSchema,
                        maxItems: 100,
                        minItems: 1,
                        type: "array",
                    },
                    text: { maxLength: 2000, minLength: 1, type: "string" },
                },
                required: ["action"],
                type: "object",
            },
            name: "mcpapp_goal",
            outputSchema: mcpAppGoalResultOutputSchema,
            requiredCapabilities: [],
        },
        /**
         * @compat workspace-open-entrypoint
         * @removeAt 0.7.10
         */
        {
            _meta: {
                ui: {
                    resourceUri: mcpAppResourceUri,
                    visibility: ["model", "app"],
                },
                "ui/resourceUri": mcpAppResourceUri,
                "openai/outputTemplate": mcpAppResourceUri,
                "openai/widgetAccessible": true,
            },
            description:
                "Explicitly re-present or restore the portable-devshell MCP App for the current Context. environ_info normally bootstraps and presents the McpApp in the initial environment call, so models should not call mcpapp_open during the normal startup path. Keep this compatibility entrypoint for a dismissed, remounted, or otherwise inactive App.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
            },
            name: "mcpapp_open",
            outputSchema: mcpAppOpenOutputSchema,
            requiredCapabilities: [],
        },
        /**
         * @compat mcpapp-mcp-fallback
         * @removeAt 0.7.10
         */
        {
            _meta: appOnlyMeta,
            description:
                "Compatibility fallback for re-establishing the MCP App lifecycle when direct MCP App transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: { token: { minLength: 1, type: "string" } },
                required: ["token"],
                type: "object",
            },
            name: "mcpapp_reconnect",
            outputSchema: mcpAppSnapshotOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description:
                "Compatibility fallback for reading the authoritative McpApp snapshot when direct MCP App transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: { token: { minLength: 1, type: "string" } },
                type: "object",
            },
            name: "mcpapp_snapshot",
            outputSchema: mcpAppSnapshotOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description:
                "Compatibility fallback for waiting on McpApp state changes when direct MCP App transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    cursor: { minimum: 0, type: "integer" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["cursor"],
                type: "object",
            },
            name: "mcpapp_watch",
            outputSchema: mcpAppWatchOutputSchema,
            requiredCapabilities: [],
        },
    ];

    list(): ToolDefinition[] {
        return [
            ...this.#definitions.map((definition) => ({ ...definition })),
            {
                _meta: appOnlyMeta,
                description: "Apply one currently projected McpApp action and return a fresh McpApp snapshot. App-only; models must not call it.",
                group: "workspace",
                inputSchema: {
                    additionalProperties: false,
                    properties: {
                        actionId: { minLength: 1, type: "string" },
                        input: { maxLength: 20_000, type: "string" },
                        itemId: { minLength: 1, type: "string" },
                        token: { minLength: 1, type: "string" },
                    },
                    required: ["itemId", "actionId", "token"],
                    type: "object",
                },
                name: "mcpapp_action",
                outputSchema: mcpAppActionOutputSchema,
                requiredCapabilities: [],
            },
        ];
    }
}
