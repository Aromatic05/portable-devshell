import { useState, type ReactNode } from "react";
import {
    headlineFor, number, record, titleFor,
    type ToolCallPresentation, type ToolCallResult,
} from "./ToolCallModel.js";
import { ToolCallDetails } from "./ToolCallRenderers.js";

export type { ToolCallResult } from "./ToolCallModel.js";

/** Native Tool Result is the only source of data for an ordinary Inline card. */
export function readToolCallResult(raw: unknown): ToolCallResult | undefined {
    const value = record(raw);
    if (!value) return undefined;
    const meta = record(value._meta);
    const identity = record(meta?.["portable-devshell/toolcall"]);
    if (!("structuredContent" in value) && !("content" in value) && !identity) return undefined;
    const contents = Array.isArray(value.content) ? value.content : [];
    const image = contents.map(record).find((part) =>
        part?.type === "image" && typeof part.data === "string" &&
        typeof part.mediaType === "string" &&
        /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/u.test(part.mediaType) &&
        /^[A-Za-z0-9+/=\s]+$/u.test(part.data) && part.data.length <= 14_000_000);
    return {
        ...(typeof identity?.name === "string" ? { name: identity.name } : {}),
        isError: value.isError === true,
        ...("structuredContent" in value ? { output: value.structuredContent } :
            "content" in value ? { output: value.content } : {}),
        ...(image ? { image: { src: "data:" + image.mediaType + ";base64," +
            (image.data as string).replace(/\s/gu, ""), mediaType: image.mediaType as string } } : {}),
    };
}

/** Host globals are read on mount and remount; no persistent Widget state. */
export function restoreToolCallResult(): ToolCallResult | undefined {
    const openai = record((window as Window & { openai?: unknown }).openai);
    const metadata = record(openai?.toolResponseMetadata);
    const nested = record(metadata?.mcp_tool_result) ?? record(metadata?.call_tool_result);
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

export function ToolCallCard({
    input, result, enabled = true, onEnabledChange, name: assignedName,
    purpose, summary, state, detail,
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
            onClick={() => setExpanded((previous) => !previous)}>
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
            {summary && <div className="tc-summary">{summary}</div>}
        </div>}
    </section>;
}
