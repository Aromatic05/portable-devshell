import { useState, type ReactNode } from "react";
import {
    headlineFor, number, record, titleFor,
    type ToolCallPresentation, type ToolCallResult,
} from "./ToolCallModel.js";
import { ToolCallDetails } from "./ToolCallRenderers.js";

export type { ToolCallResult } from "./ToolCallModel.js";

const widgetPayloadKey = "portable-devshell/widgetPayload";
const widgetPayloadSchema = "portable-devshell.toolcall.v1";

export function readToolCallWidgetPayload(metadata: unknown): {
    input?: unknown; result: ToolCallResult;
} | undefined {
    const payload = record(record(metadata)?.[widgetPayloadKey]);
    if (payload?.schema !== widgetPayloadSchema ||
        typeof payload.toolName !== "string" ||
        !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(payload.toolName)) return undefined;
    return {
        ...("input" in payload ? { input: payload.input } : {}),
        result: { name: payload.toolName, isError: payload.isError === true, output: payload.output },
    };
}

/** Native Tool Result is the only source of data for an ordinary Inline card. */
export function readToolCallResult(raw: unknown): ToolCallResult | undefined {
    const value = record(raw);
    if (!value) return undefined;
    const meta = record(value._meta);
    const identity = record(meta?.["portable-devshell/toolcall"]);
    const widget = readToolCallWidgetPayload(meta)?.result;
    if (!("structuredContent" in value) && !("content" in value) && !identity && !widget) return undefined;
    const contents = Array.isArray(value.content) ? value.content : [];
    const image = contents.map(record).find((part) =>
        part?.type === "image" && typeof part.data === "string" &&
        typeof (part.mimeType ?? part.mediaType) === "string" &&
        /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/u.test(
            (part.mimeType ?? part.mediaType) as string) &&
        /^[A-Za-z0-9+/=\s]+$/u.test(part.data) && part.data.length <= 14_000_000);
    const imageType = image?.mimeType ?? image?.mediaType;
    return {
        ...(widget?.name ? { name: widget.name } :
            typeof identity?.name === "string" ? { name: identity.name } : {}),
        isError: widget?.isError ?? (value.isError === true),
        ...(widget ? { output: widget.output } : "structuredContent" in value ? { output: value.structuredContent } :
            "content" in value ? { output: value.content } : {}),
        ...(image ? { image: { src: "data:" + imageType + ";base64," +
            (image.data as string).replace(/\s/gu, ""), mediaType: imageType as string } } : {}),
    };
}

/** Host globals are read on mount and remount; no persistent Widget state. */
export function restoreToolCallResult(globals?: unknown): ToolCallResult | undefined {
    const openai = record(globals ?? (window as Window & { openai?: unknown }).openai);
    const metadata = record(openai?.toolResponseMetadata);
    const widget = readToolCallWidgetPayload(metadata);
    const nested = record(metadata?.mcp_tool_result) ?? record(metadata?.call_tool_result);
    if (widget) {
        // Widget payload is authoritative for structured text; native MCP image
        // bytes remain in the actual Tool Result, never duplicated in metadata.
        const native = nested ? readToolCallResult(nested) : undefined;
        return native?.image ? { ...widget.result, image: native.image } : widget.result;
    }
    if (nested) return readToolCallResult({
        ...nested,
        ...(openai && "toolOutput" in openai ? { structuredContent: openai.toolOutput } : {}),
    });
    if (metadata && ("portable-devshell/toolcall" in metadata || (openai && "toolOutput" in openai)))
        return readToolCallResult({
            _meta: metadata,
            ...(openai && "toolOutput" in openai ? { structuredContent: openai.toolOutput } : {}),
        });
    return undefined;
}

export function restoreToolCallInput(globals?: unknown): unknown {
    const openai = record(globals ?? (window as Window & { openai?: unknown }).openai);
    return readToolCallWidgetPayload(openai?.toolResponseMetadata)?.input ?? openai?.toolInput;
}

export function ToolCallCard({
    input, result, enabled = true, onEnabledChange, name: assignedName,
    purpose, summary, state, detail, onExpandedChange, expandedFooter,
}: {
    input?: unknown;
    result?: ToolCallResult;
    enabled?: boolean;
    onEnabledChange?: (enabled: boolean) => void;
    name?: string;
    purpose?: string;
    summary?: string;
    state?: string;
    detail?: string;
    onExpandedChange?: (expanded: boolean) => void;
    expandedFooter?: ReactNode;
}): ReactNode {
    const [expanded, setExpanded] = useState(false);
    const name = result?.name ?? assignedName ?? "ToolCall";
    const view: ToolCallPresentation = { name, input, result, purpose, summary, state, detail };
    const duration = number(record(result?.output)?.durationMs);
    const output = record(result?.output);
    const taskStatus = record(output?.task)?.status;
    const partialFailure = Array.isArray(output?.operations) && output.operations.some((entry) =>
        record(entry)?.status === "failed");
    const exit = number(output?.exitCode) ?? (summary?.match(/exit\s+(\d+)/u)
        ? Number(summary.match(/exit\s+(\d+)/u)?.[1]) : undefined);
    const status = result?.isError || state === "failed" || state === "denied" ? "Failed" :
        partialFailure ? "Partial failure" : state === "running" || state === "queued" ||
        taskStatus === "running" || (!result && !detail) ? "Running" : "Completed";
    const statusText = exit === undefined || status !== "Completed" ? status : status + " · exit " + exit;
    if (!enabled) return <div className="toolcall-hidden">
        <span>ToolCall hidden</span>
        <button type="button" onClick={() => onEnabledChange?.(true)}>Show</button>
    </div>;
    return <section className="toolcall-card" aria-label="ToolCall result" data-expanded={expanded}>
        <button type="button" className="toolcall-compact" aria-expanded={expanded}
            onClick={() => {
                const next = !expanded;
                setExpanded(next);
                onExpandedChange?.(next);
            }}>
            <span className="toolcall-line">
                <strong>{titleFor(name)}</strong>
                <span className="tc-tool-id">{name}</span>
                <span data-kind={status === "Failed" || status === "Partial failure" ? "error" :
                    status === "Running" ? "running" : "done"}>{statusText}</span>
                {duration !== undefined && <span className="toolcall-duration">{Math.round(duration)}ms</span>}
                <span className="toolcall-chevron" aria-hidden="true">⌄</span>
            </span>
            <span className="toolcall-description" title={headlineFor(view)}>{headlineFor(view)}</span>
        </button>
        {expanded && <div className="toolcall-expanded">
            <ToolCallDetails {...view} />
            {expandedFooter}
            {summary && <div className="tc-summary">{summary}</div>}
        </div>}
    </section>;
}
