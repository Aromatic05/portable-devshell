import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";
import {
    McpToolCatalogArtifact,
    McpToolCatalogEnvironment,
    McpToolCatalogInstance,
    McpToolCatalogInteraction,
    McpToolSchemaAdapter,
} from "@portable-devshell/mcp/testing";

test("Control-owned MCP tools describe their structured output instead of generic objects", () => {
    const definitions = [
        ...new McpToolCatalogArtifact().list(),
        ...new McpToolCatalogEnvironment().list(),
        ...new McpToolCatalogInstance().list(),
        ...new McpToolCatalogInteraction().list(),
    ];

    for (const definition of definitions) {
        assertMeaningfulSchema(definition);
    }

    assert.deepEqual(required(definition(definitions, "artifact_share").outputSchema), [
        "blake3", "bytes", "downloadName", "expiresAtMs", "mediaType", "shareId", "source", "state", "url"
    ]);
    assertProperties(definition(definitions, "artifact_transfer").outputSchema, ["operation", "transfer"]);

    const environment = definition(definitions, "environ_info");
    const platform = property(environment.outputSchema, "platform");
    assert.equal(record(platform).additionalProperties, false);
    assert.deepEqual(required(platform), ["arch", "os"]);
    assertProperties(platform, ["arch", "distribution", "os", "packageManager", "shell"]);
    const distribution = property(platform, "distribution");
    assert.equal(record(distribution).additionalProperties, false);
    assert.deepEqual(required(distribution), ["id", "name"]);

    assertProperties(definition(definitions, "instance_list").outputSchema, ["instances"]);
    assertProperties(definition(definitions, "instance_status").outputSchema, [
        "enabled", "mcpEnabled", "name", "provider", "snapshot"
    ]);
    assertProperties(definition(definitions, "instance_connect").outputSchema, [
        "connectionState", "daemonState", "lastSeq", "name", "ready", "status", "workspace"
    ]);

    assertProperties(definition(definitions, "workspace_open").outputSchema, [
        "contextSelector", "ctxId", "instance"
    ]);
    assertProperties(definition(definitions, "workspace_snapshot").outputSchema, [
        "approvals", "background", "contextSelector", "ctxId", "currentEvent", "cursor", "instance", "questions", "tasks"
    ]);
    const questions = record(property(definition(definitions, "workspace_snapshot").outputSchema, "questions"));
    const question = record(questions.items);
    assert.equal(question.additionalProperties, false);
    assert.deepEqual(required(question), ["createdAt", "kind", "status", "targetId", "updatedAt", "waitId"]);
    assert.equal("result" in record(question.properties), false);
    const questionPayload = property(question, "payload");
    assert.equal(record(questionPayload).additionalProperties, false);
    assert.deepEqual(required(questionPayload), ["allowText", "choices", "question"]);
    assertAnyOf(definition(definitions, "workspace_watch").outputSchema, 2);
    assert.deepEqual(required(definition(definitions, "workspace_question_answer").outputSchema), [
        "answer", "detached", "questionId", "waitId"
    ]);
    assertProperties(definition(definitions, "workspace_task_control").outputSchema, [
        "items", "revision", "summary", "taskId", "tasks", "title"
    ]);
    assertAnyOf(definition(definitions, "workspace_wait_recover").outputSchema, 3);
    assertProperties(definition(definitions, "workspace_approval_decide").outputSchema, [
        "approvalId", "callId", "createdAt", "decision", "expiresAt", "inputSummary", "instance", "reason", "riskLevel", "source", "status", "toolName"
    ]);

    const adapter = new McpToolSchemaAdapter();
    const workspaceOpen = definition(definitions, "workspace_open");
    const adaptedOpen = adapter.toMcpTool(workspaceOpen, workspaceOpen.description);
    assertProperties(adaptedOpen.outputSchema, ["contextSelector", "instance"]);
    const transfer = definition(definitions, "artifact_transfer");
    const adaptedTransfer = adapter.toMcpTool(transfer, transfer.description);
    assertProperties(adaptedTransfer.outputSchema, ["operation", "transfer"]);
});

function definition(definitions: ToolDefinition[], name: string): ToolDefinition {
    const result = definitions.find((entry) => entry.name === name);
    assert.ok(result, `Missing tool ${name}`);
    return result;
}

function assertMeaningfulSchema(definition: ToolDefinition): void {
    const schema = record(definition.outputSchema);
    const properties = record(schema.properties);
    const union = Array.isArray(schema.anyOf) ? schema.anyOf : [];
    assert.equal(
        Object.keys(properties).length > 0 || union.length > 0,
        true,
        `${definition.name} must describe its structured output`,
    );
}

function assertProperties(schema: JsonValue, names: string[]): void {
    const properties = record(record(schema).properties);
    for (const name of names) assert.ok(name in properties, `Missing output property ${name}`);
}

function property(schema: JsonValue, name: string): JsonValue {
    const value = record(record(schema).properties)[name];
    assert.ok(value, `Missing output property ${name}`);
    return value;
}

function assertAnyOf(schema: JsonValue, count: number): void {
    const union = record(schema).anyOf;
    assert.equal(Array.isArray(union) ? union.length : 0, count);
}

function required(schema: JsonValue): string[] {
    const value = record(schema).required;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
