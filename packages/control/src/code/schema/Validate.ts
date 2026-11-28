import type { JsonValue } from "@portable-devshell/shared";

import type { CodeMethodDescriptor } from "../Api.js";
import { formatMethodSignature } from "./DtsEmitter.js";

export function validateMethodInput(
    namespaceId: string,
    method: CodeMethodDescriptor,
    rawInput: JsonValue | undefined,
): JsonValue {
    const schema = method.inputSchema;
    const input = rawInput === undefined ? {} : rawInput;
    const issues = checkSchema(schema, input, "$");
    if (issues.length === 0) return input;
    const signature = formatMethodSignature(method, `devshell.${namespaceId}`);
    throw new TypeError(
        `Invalid arguments for devshell.${namespaceId}.${method.name}: ${issues.join("; ")}\nSignature:\n  ${signature}`,
    );
}

function checkSchema(
    schema: JsonValue | undefined,
    value: JsonValue,
    path: string,
): string[] {
    if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema))
        return [];

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const matched = schema.enum.some((candidate) => deepEqual(candidate, value));
        if (!matched) {
            return [
                `${path} must be one of ${schema.enum.map((c) => JSON.stringify(c)).join(", ")}`,
            ];
        }
    }
    if ("const" in schema && schema.const !== undefined && !deepEqual(schema.const, value)) {
        return [`${path} must equal ${JSON.stringify(schema.const)}`];
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
        const ok = schema.anyOf.some((branch) => checkSchema(branch, value, path).length === 0);
        if (!ok) return [`${path} does not match any allowed schema variant`];
        return [];
    }
    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
        const ok = schema.oneOf.some((branch) => checkSchema(branch, value, path).length === 0);
        if (!ok) return [`${path} does not match any allowed schema variant`];
        return [];
    }

    const type = schema.type;
    if (typeof type === "string") {
        const typeIssue = checkPrimitiveType(type, value, path);
        if (typeIssue !== undefined) return [typeIssue];
    } else if (Array.isArray(type)) {
        const ok = type.some(
            (candidate) =>
                typeof candidate === "string" &&
                checkPrimitiveType(candidate, value, path) === undefined,
        );
        if (!ok) {
            return [`${path} must be of type ${type.join(" | ")}`];
        }
    }

    if (type === "array" && Array.isArray(value) && schema.items !== undefined) {
        const issues: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
            issues.push(...checkSchema(schema.items, value[index]!, `${path}[${index}]`));
            if (issues.length >= 4) break;
        }
        return issues;
    }

    if (
        (type === "object" || isRecord(schema.properties)) &&
        isRecord(value)
    ) {
        const issues: string[] = [];
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
            ? schema.required.filter((entry): entry is string => typeof entry === "string")
            : [];
        for (const key of required) {
            if (!(key in value) || value[key] === undefined) {
                issues.push(`missing required "${key}"`);
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    issues.push(`unexpected key "${key}"`);
                }
            }
        }
        for (const [key, propSchema] of Object.entries(properties)) {
            if (!(key in value) || value[key] === undefined) continue;
            issues.push(
                ...checkSchema(propSchema, value[key]!, path === "$" ? key : `${path}.${key}`),
            );
            if (issues.length >= 4) break;
        }
        return issues;
    }

    return [];
}

function checkPrimitiveType(
    expected: string,
    value: JsonValue,
    path: string,
): string | undefined {
    switch (expected) {
        case "string":
            return typeof value === "string"
                ? undefined
                : `${path} must be a string (got ${describeRuntimeType(value)})`;
        case "number":
            return typeof value === "number" && Number.isFinite(value)
                ? undefined
                : `${path} must be a number (got ${describeRuntimeType(value)})`;
        case "integer":
            return typeof value === "number" && Number.isSafeInteger(value)
                ? undefined
                : `${path} must be an integer (got ${describeRuntimeType(value)})`;
        case "boolean":
            return typeof value === "boolean"
                ? undefined
                : `${path} must be a boolean (got ${describeRuntimeType(value)})`;
        case "null":
            return value === null
                ? undefined
                : `${path} must be null (got ${describeRuntimeType(value)})`;
        case "array":
            return Array.isArray(value)
                ? undefined
                : `${path} must be an array (got ${describeRuntimeType(value)})`;
        case "object":
            return isRecord(value)
                ? undefined
                : `${path} must be an object (got ${describeRuntimeType(value)})`;
        default:
            return undefined;
    }
}

function describeRuntimeType(value: JsonValue): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
    if (left === right) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((item, index) => deepEqual(item, right[index]!))
        );
    }
    if (isRecord(left) && isRecord(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (leftKeys.length !== rightKeys.length) return false;
        return leftKeys.every((key) => key in right && deepEqual(left[key]!, right[key]!));
    }
    return false;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
