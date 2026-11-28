import type { JsonValue } from "@portable-devshell/shared";

import type {
    CodeMethodDescriptor,
    CodeObjectDescriptor,
} from "../Api.js";

const MAX_TYPE_DEPTH = 4;

export function schemaToTsType(schema: JsonValue | undefined, depth = 0): string {
    if (schema === undefined || schema === null) return "unknown";
    if (typeof schema === "boolean") return schema ? "unknown" : "never";
    if (typeof schema !== "object" || Array.isArray(schema)) return "unknown";
    if (depth >= MAX_TYPE_DEPTH) return "Record<string, unknown>";

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    }
    if ("const" in schema && schema.const !== undefined) {
        return JSON.stringify(schema.const);
    }
    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
        return schema.anyOf
            .map((branch) => schemaToTsType(branch, depth + 1))
            .join(" | ");
    }
    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
        return schema.oneOf
            .map((branch) => schemaToTsType(branch, depth + 1))
            .join(" | ");
    }

    const type = schema.type;
    if (Array.isArray(type)) {
        return type
            .map((entry) =>
                typeof entry === "string"
                    ? schemaToTsType({ ...schema, type: entry }, depth)
                    : "unknown",
            )
            .join(" | ");
    }

    if (type === "string") return "string";
    if (type === "number" || type === "integer") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") {
        const itemType = schemaToTsType(schema.items, depth + 1);
        return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
    }
    if (type === "object" || isRecord(schema.properties)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = new Set(
            Array.isArray(schema.required)
                ? schema.required.filter((entry): entry is string => typeof entry === "string")
                : [],
        );
        const entries = Object.entries(properties);
        if (entries.length === 0) {
            if (isRecord(schema.additionalProperties)) {
                return `Record<string, ${schemaToTsType(schema.additionalProperties, depth + 1)}>`;
            }
            return "Record<string, unknown>";
        }
        const fields = entries.map(([key, propSchema]) => {
            const opt = required.has(key) ? "" : "?";
            const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
                ? key
                : JSON.stringify(key);
            return `${safeKey}${opt}: ${schemaToTsType(propSchema, depth + 1)}`;
        });
        return `{ ${fields.join("; ")} }`;
    }

    return "unknown";
}

export function formatMethodSignature(
    method: CodeMethodDescriptor,
    prefix?: string,
): string {
    const input = formatInputParam(method.inputSchema);
    const output =
        method.outputSchema === undefined
            ? "unknown"
            : schemaToTsType(method.outputSchema);
    const name = prefix === undefined ? method.name : `${prefix}.${method.name}`;
    return `${name}(${input}): Promise<${output}>`;
}

export function emitObjectDts(
    descriptor: CodeObjectDescriptor,
    filter?: string,
): string {
    const query = filter?.trim().toLowerCase();
    const methods =
        query === undefined || query.length === 0
            ? descriptor.methods
            : descriptor.methods.filter(
                  (method) =>
                      method.name.toLowerCase().includes(query) ||
                      method.summary.toLowerCase().includes(query),
              );
    const lines: string[] = [
        `/** ${descriptor.summary} (${descriptor.scopeLevel}-scoped) */`,
        `declare namespace devshell.${descriptor.id} {`,
    ];
    if (descriptor.id === "instance") {
        lines.push(
            "  /** Create a lazy InstanceHandle for another instance or workspace. */",
            "  function call(target: { name?: string; handle?: string; workspace: string }): InstanceHandle;",
        );
    } else if (descriptor.callable === true) {
        lines.push("  function call(target: unknown): unknown;");
    }
    if (methods.length === 0) {
        lines.push("  // No matching methods.");
    } else {
        for (const method of methods) {
            if (method.summary.length > 0)
                lines.push(`  /** ${method.summary} */`);
            lines.push(`  function ${formatMethodSignature(method)};`);
            if (method.example !== undefined && method.example.length > 0)
                lines.push(`  // Example: ${method.example}`);
        }
    }
    lines.push("}");
    return lines.join("\n");
}

export function emitOverviewDts(
    objects: readonly CodeObjectDescriptor[],
    filter?: string,
): string {
    const query = filter?.trim().toLowerCase();
    const matched =
        query === undefined || query.length === 0
            ? objects
            : objects.filter(
                  (obj) =>
                      obj.id.toLowerCase().includes(query) ||
                      obj.summary.toLowerCase().includes(query) ||
                      obj.methods.some(
                          (method) =>
                              method.name.toLowerCase().includes(query) ||
                              method.summary.toLowerCase().includes(query),
                      ),
              );

    const instanceObjects = matched.filter((obj) => obj.scopeLevel === "instance");
    const controlObjects = matched.filter((obj) => obj.scopeLevel === "control");

    const lines: string[] = [
        "// DevShell Code Mode API (QuickJS-NG)",
        "// Top-level `await` supported. Last expression returns automatically.",
        "// Use `devshell.help(\"<namespace>\")` for full signatures.",
        "",
        "interface InstanceHandle {",
        "  readonly name: string;",
        "  readonly workspace: string;",
        "  withWorkspace(workspace: string): InstanceHandle;",
        "  ready(): Promise<{ instance: string; workspace: string; state: string }>;",
    ];
    for (const obj of instanceObjects) {
        const names = obj.methods.map((method) => method.name).join(", ");
        lines.push(`  /** ${obj.summary} */`);
        lines.push(`  readonly ${obj.id}: { /* ${names} */ };`);
    }
    lines.push("}", "", "interface DevShellRoot extends InstanceHandle {");
    for (const obj of controlObjects) {
        const names = obj.methods.map((method) => method.name).join(", ");
        const callableNote =
            obj.id === "instance"
                ? "(target: { name?: string; handle?: string; workspace: string }): InstanceHandle; "
                : obj.callable === true
                  ? "(target: unknown): unknown; "
                  : "";
        lines.push(`  /** ${obj.summary} */`);
        lines.push(`  readonly ${obj.id}: { ${callableNote}/* ${names} */ };`);
    }
    lines.push(
        "  help(target?: string, options?: { filter?: string }): string;",
        "}",
        "declare const devshell: DevShellRoot;",
    );
    return lines.join("\n");
}

function formatInputParam(schema: JsonValue): string {
    if (!isRecord(schema)) return "input?: unknown";
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const propCount = Object.keys(properties).length;
    if (propCount === 0 && required.length === 0) return "input?: Record<string, unknown>";
    const optional = required.length === 0 ? "?" : "";
    return `input${optional}: ${schemaToTsType(schema)}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
