import type { ReactNode } from "react";
import { number, record, redact, safeValue, string, type ToolCallPresentation } from "./ToolCallModel.js";
import {
    CodeLines, FileTree, InfoStrip, KeySummary, Notice, Stat, TaskState, Terminal,
    UnifiedDiff, ValueRows, fileLanguage,
} from "./ToolCallPrimitives.js";

type Renderer = (view: ToolCallPresentation) => ReactNode;
type Item = Record<string, unknown>;
function entries(value: unknown): Item[] {
    return Array.isArray(value) ? value.map(record).filter((item): item is Item => !!item) : [];
}
function textList(value: unknown): string[] {
    if (typeof value === "string") return [redact(value)];
    return Array.isArray(value) ? value.filter((entry): entry is string =>
        typeof entry === "string").map(redact) : [];
}
function heading(text: string): ReactNode { return <h3 className="tc-section-title">{text}</h3>; }

function OutlineView({ text }: { text: string }): ReactNode {
    return <ul className="tc-outline" aria-label="File structure">{redact(text).split(/\r?\n/u)
        .slice(0, 160).filter(Boolean).map((line, index) => {
            const indentation = line.match(/^[\s│├└─]*/u)?.[0].length ?? 0;
            return <li key={index} style={{ paddingInlineStart: Math.min(80, indentation * 5) }}>
                <span aria-hidden="true">›</span>{line.trim()}</li>;
        })}</ul>;
}

function ShellView({ input, result }: ToolCallPresentation): ReactNode {
    const args = record(input);
    const output = record(result?.output);
    const stdout = string(output?.stdout);
    const stderr = string(output?.stderr);
    return <div className="tc-view">
        {string(args?.command) && <div className="tc-command"><span aria-hidden="true">$</span>
            <code>{string(args?.command)}</code></div>}
        {string(args?.cwd) && <InfoStrip>Directory: {string(args?.cwd)}</InfoStrip>}
        <KeySummary output={output} />
        {stdout && <Terminal text={stdout} title="stdout"
            maxChars={output?.activityRetained === true ? stdout.length : undefined} />}
        {stderr && <Terminal text={stderr} title="stderr"
            maxChars={output?.activityRetained === true ? stderr.length : undefined} />}
        {!stdout && !stderr && (output?.activityStatus === "loading"
            ? <Notice>Loading retained terminal output…</Notice>
            : string(output?.activityError)
                ? <Notice tone="warning">{string(output?.activityError)}</Notice>
                : (number(output?.stdoutBytes) ?? 0) > 0 || (number(output?.stderrBytes) ?? 0) > 0
                    ? <Notice>Retained terminal output is unavailable or has expired.</Notice>
                    : <Notice>Command produced no terminal output.</Notice>)}
        {output?.stdoutTruncated === true || output?.stderrTruncated === true
            ? <Notice tone="warning">Output was truncated by the tool.</Notice> : null}
        {string(output?.termination) && <InfoStrip>Termination: {string(output?.termination)}</InfoStrip>}
    </div>;
}

function FileReadView({ result }: ToolCallPresentation): ReactNode {
    const output = record(result?.output);
    const files = entries(output?.files);
    if (!files.length) return <Notice>No file content was returned.</Notice>;
    return <div className="tc-view tc-files">{files.slice(0, 12).map((file, index) => {
        const path = string(file.path) ?? "File " + (index + 1);
        const view = string(file.view) ?? "content";
        const content = string(file.content);
        const metadata = record(file.metadata);
        return <section className="tc-file" key={index}>
            <div className="tc-file-header"><span aria-hidden="true">▤</span>
                <strong title={path}>{path}</strong><span className="tc-mini-label">{view}</span></div>
            {view === "metadata" ? <ValueRows value={metadata ?? file} /> :
                content ? view === "outline" ? <OutlineView text={content} /> :
                    <CodeLines text={content} language={fileLanguage(path)} /> :
                    <Notice>No content returned for this file.</Notice>}
            {file.truncated === true || file.nextSelector
                ? <InfoStrip>More lines available{file.nextSelector ? " · next selector: " +
                    String(file.nextSelector) : ""}</InfoStrip> : null}
        </section>;
    })}</div>;
}

function SearchView({ input, result }: ToolCallPresentation): ReactNode {
    const args = record(input);
    const output = record(result?.output);
    const files = entries(output?.files);
    const pattern = string(args?.pattern);
    return <div className="tc-view">
        <div className="tc-stats">
            <Stat label="Files" value={files.length} />
            <Stat label="Query" value={pattern} />
        </div>
        {!files.length && <Notice>No matching text was found on this page.</Notice>}
        {files.slice(0, 16).map((file, index) => {
            const path = string(file.path) ?? "File " + (index + 1);
            return <section className="tc-file" key={index}>
                <div className="tc-file-header"><span aria-hidden="true">⌕</span><strong>{path}</strong>
                    {file.truncated === true && <span className="tc-mini-label">partial</span>}</div>
                <CodeLines text={string(file.content) ?? ""} search={pattern} />
                {number(file.nextLine) !== undefined &&
                    <InfoStrip>More matches after line {number(file.nextLine)!}</InfoStrip>}
            </section>;
        })}
        {string(output?.nextCursor) && <Notice>More files exist. Continue this search using its cursor.</Notice>}
    </div>;
}

function GlobView({ input, result }: ToolCallPresentation): ReactNode {
    const args = record(input);
    const output = record(result?.output);
    const found = entries(output?.entries);
    const paths = found.map((item) => ({
        path: string(item.path) ?? "",
        type: string(item.type),
    })).filter((item) => !!item.path);
    return <div className="tc-view">
        <div className="tc-stats"><Stat label="Found" value={found.length} />
            <Stat label="Pattern" value={textList(args?.patterns).join(", ") || undefined} /></div>
        <FileTree entries={paths} />
        {string(output?.nextCursor) && <Notice>Additional paths are available on the next page.</Notice>}
    </div>;
}

function EditView({ input, result }: ToolCallPresentation): ReactNode {
    const output = record(result?.output);
    const operations = entries(output?.operations);
    const added = operations.reduce((count, item) => count + (number(item.addedLines) ?? 0), 0);
    const removed = operations.reduce((count, item) => count + (number(item.removedLines) ?? 0), 0);
    return <div className="tc-view">
        <div className="tc-stats">
            <Stat label="Operations" value={operations.length} />
            <span className="tc-added">+{added}</span><span className="tc-removed">−{removed}</span>
        </div>
        {operations.slice(0, 25).map((operation, index) => {
            const status = string(operation.status) ?? "unknown";
            const path = string(operation.path) ?? "File";
            const change = string(operation.diff);
            const error = record(operation.error);
            return <section key={index} className="tc-edit-operation" data-state={status}>
                <div className="tc-edit-heading">
                    <span className="tc-edit-state" aria-label={status} />
                    <strong>{path}</strong>
                    <span className="tc-mini-label">{string(operation.action) ?? "edit"}</span>
                    <span className="tc-edit-count">{number(operation.addedLines) !== undefined
                        ? "+" + number(operation.addedLines) : ""}
                        {number(operation.removedLines) !== undefined
                            ? " / −" + number(operation.removedLines) : ""}</span>
                </div>
                {string(operation.movedFrom) && <InfoStrip>Moved from: {string(operation.movedFrom)}</InfoStrip>}
                {change && <UnifiedDiff diff={change} />}
                {status === "failed" && <Notice tone="danger">{string(error?.message) ??
                    string(error?.code) ?? "This operation failed"}</Notice>}
                {operation.truncated === true && <Notice tone="warning">Returned diff is truncated</Notice>}
            </section>;
        })}
        {operations.length > 0 && !operations.some((item) => typeof item.diff === "string") &&
            <Notice>Only change counts were returned; no actual diff was provided.
                Request resultDetail: diff to inspect resulting changes.</Notice>}
        {!operations.length && <Notice>No individual file operation results were returned.</Notice>}
        {!operations.some((item) => typeof item.diff === "string") && string(record(input)?.changes) &&
            <details className="tc-technical"><summary>Submitted patch (not a verified diff)</summary>
                <UnifiedDiff diff={string(record(input)?.changes)!} /></details>}
    </div>;
}

function warnings(output: Item | undefined): ReactNode {
    const items = entries(output?.warnings);
    return items.map((item, index) => <Notice tone="warning" key={index}>
        {string(item.message) ?? string(item.code) ?? "Terminal warning"}</Notice>);
}

function TmuxView({ name, input, result }: ToolCallPresentation): ReactNode {
    const args = record(input);
    const output = record(result?.output);
    const task = record(output?.task);
    const pane = record(output?.pane);
    const panes = entries(output?.panes);
    const lines = textList(output?.output);
    return <div className="tc-view">
        <div className="tc-stats">
            <Stat label="Task" value={string(task?.id)} />
            <Stat label="Pane" value={string(pane?.name) ?? string(pane?.id)} />
            {task?.status !== undefined && <TaskState status={task.status} />}
            {string(output?.waitReason) && <Stat label="Wait" value={string(output?.waitReason)} />}
        </div>
        {string(args?.command) && name === "tmux_run" &&
            <div className="tc-command"><span aria-hidden="true">$</span><code>{string(args?.command)}</code></div>}
        {name === "tmux_input" && <InfoStrip>Input sent to {string(args?.task) ??
            string(args?.pane) ?? "terminal"}</InfoStrip>}
        {output?.detached === true && <Notice>The task is detached; it may still be running.</Notice>}
        {output?.interrupted === true && <Notice tone="warning">Waiting stopped, not the task.</Notice>}
        {(output?.timedOut === true || output?.waitReason === "timeout") &&
            <Notice tone="warning">The wait timed out; the task may still be running.</Notice>}
        {panes.length ? <div className="tc-pane-list">{panes.map((item, index) =>
            <section className="tc-pane" key={index}>
                <div className="tc-file-header"><strong>{string(item.name) ?? "Pane"}</strong>
                    <TaskState status={item.status} /></div>
                {string(item.cwd) && <InfoStrip>Directory: {string(item.cwd)}</InfoStrip>}
                {string(item.command) && <InfoStrip>Command: {string(item.command)}</InfoStrip>}
                {textList(item.lines).length > 0 &&
                    <Terminal title={string(item.name) ?? "Pane"} text={textList(item.lines).join("\n")} />}
            </section>)}</div> : null}
        {lines.length > 0 && <Terminal title="Task transcript" text={lines.join("\n")} />}
        {name === "tmux_manage" && string(output?.closedTaskId) &&
            <Notice>Closed task: {string(output?.closedTaskId)}</Notice>}
        {name === "tmux_manage" && string(output?.closedPaneId) &&
            <Notice>Closed pane: {string(output?.closedPaneId)}</Notice>}
        {warnings(output)}
        {!lines.length && !panes.length && name === "tmux_read" &&
            <Notice>No additional transcript lines were returned.</Notice>}
    </div>;
}

function TodoView({ input, result, name }: ToolCallPresentation): ReactNode {
    const args = record(input);
    const output = record(result?.output);
    const items = entries(output?.items);
    const tasks = entries(output?.tasks);
    const plan = record(output?.summary);
    const checkpoint = record(output?.checkpoint) ?? record(args?.checkpoint);
    const completed = number(plan?.completed) ?? items.filter((item) => item.status === "completed").length;
    const total = number(plan?.total) ?? items.length;
    return <div className="tc-view">
        <div className="tc-file-header"><strong>{string(output?.title) ??
            string(args?.title) ?? "Task plan"}</strong>
            <span className="tc-mini-label">{name === "todo_write" ? "Updated" : "Current"}</span></div>
        {total > 0 && <div className="tc-progress" role="progressbar" aria-label="Tasks completed"
            aria-valuenow={completed} aria-valuemin={0} aria-valuemax={total}>
            <span style={{ width: Math.min(100, Math.max(0, (completed / total) * 100)) + "%" }} /></div>}
        <InfoStrip>{completed} / {total} complete</InfoStrip>
        {items.length > 0 && <ul className="tc-todo-list">{items.map((item, index) => {
            const status = string(item.status) ?? "pending";
            return <li key={string(item.id) ?? index} data-state={status}>
                <span className="tc-todo-icon" aria-hidden="true">{status === "completed" ? "✓" :
                    status === "in_progress" ? "◉" : status === "failed" ? "✕" :
                        status === "blocked" ? "!" : "○"}</span>
                <div><span>{string(item.content) ?? "Unnamed task"}</span>
                    {string(item.detail) && <p>{string(item.detail)}</p>}</div>
            </li>;
        })}</ul>}
        {tasks.length > 0 && !items.length && <div className="tc-pane-list">
            {tasks.map((item, index) => <section className="tc-pane" key={index}>
                <div className="tc-file-header"><strong>{string(item.title) ?? "Plan"}</strong>
                    <TaskState status={item.status} /></div>
                <InfoStrip>{number(item.completed) ?? 0} / {number(item.total) ?? 0} complete</InfoStrip>
            </section>)}
        </div>}
        {checkpoint && <section className="tc-checkpoint">
            {heading("Checkpoint")}
            {string(checkpoint.summary) && <p>{string(checkpoint.summary)}</p>}
            {string(checkpoint.next) && <p><strong>Next:</strong> {string(checkpoint.next)}</p>}
            {textList(checkpoint.blockers).length > 0 && <Notice tone="warning">
                {textList(checkpoint.blockers).join("; ")}</Notice>}
        </section>}
    </div>;
}

function ImageView({ input, result }: ToolCallPresentation): ReactNode {
    const output = record(result?.output);
    const source = record(output?.source);
    return <div className="tc-view">
        {result?.image ? <figure className="tc-image">
            <img src={result.image.src} alt={string(output?.name) ?? "Tool output image"} />
            <figcaption>{string(output?.name) ?? "Image"}</figcaption>
        </figure> : output?.activityImageStatus === "loading"
            ? <Notice>Loading stored image preview…</Notice>
            : string(output?.activityImageError)
                ? <Notice tone="warning">{string(output?.activityImageError)}</Notice>
                : <Notice>Image preview is unavailable in this view.</Notice>}
        <div className="tc-stats">
            <Stat label="Type" value={string(output?.mediaType)} />
            <Stat label="Bytes" value={number(output?.bytes)} />
            <Stat label="Source" value={string(source?.path) ??
                string(source?.handle) ?? string(record(input)?.path)} />
        </div>
    </div>;
}

function EnvironmentView({ input, result, name }: ToolCallPresentation): ReactNode {
    const output = record(result?.output);
    const args = record(input);
    if (name === "mcpapp_open") return <Notice>Workspace was opened for this Context.</Notice>;
    return <div className="tc-view">
        <div className="tc-stats">
            <Stat label="Instance" value={string(output?.instance)} />
            <Stat label="Workspace" value={string(output?.workspace) ?? string(args?.workspace)} />
            <Stat label="Connection" value={string(output?.connectionState)} />
        </div>
        <ValueRows value={output ?? {}} />
    </div>;
}

function ReportView({ input, result }: ToolCallPresentation): ReactNode {
    const message = string(record(input)?.message) ?? string(record(result?.output)?.message);
    return message ? <div className="tc-report">{message}</div> :
        <ValueRows value={result?.output} />;
}

function GenericView({ result, detail }: ToolCallPresentation): ReactNode {
    return <div className="tc-view">
        {result?.output !== undefined ? <ValueRows value={result.output} /> :
            detail ? <div className="tc-report">{redact(detail)}</div> :
                <Notice>No additional structured details were returned.</Notice>}
        {result?.output !== undefined && <details className="tc-technical">
            <summary>Raw data (debugging only)</summary>
            <pre>{JSON.stringify(safeValue(result.output), null, 2).slice(0, 8_000)}</pre>
        </details>}
    </div>;
}

const renderers: Record<string, Renderer> = {
    bash_run: ShellView,
    file_read: FileReadView,
    file_grep: SearchView,
    file_glob: GlobView,
    file_edit: EditView,
    tmux_run: TmuxView,
    tmux_read: TmuxView,
    tmux_input: TmuxView,
    tmux_inspect: TmuxView,
    tmux_manage: TmuxView,
    todo_read: TodoView,
    todo_write: TodoView,
    todo_report: ReportView,
    artifact_viewImage: ImageView,
    environ_info: EnvironmentView,
    environ_remote: EnvironmentView,
    mcpapp_open: EnvironmentView,
};

/** Exactly one domain renderer serves both immutable Inline and audited Workspace. */
export function ToolCallDetails(view: ToolCallPresentation): ReactNode {
    if (!view.result && !view.detail) return <Notice>Waiting for the tool result.</Notice>;
    // Old audit entries may lack typed output. Preserve the recorded text
    // without treating a debugging dump as the primary display for new calls.
    if (view.result?.output === undefined && view.detail) {
        if (view.name === "bash_run" || view.name.startsWith("tmux_"))
            return <Terminal text={view.detail} title="Recorded output" />;
        if (view.name === "file_read" || view.name === "file_grep")
            return <CodeLines text={view.detail} />;
        return <div className="tc-report">{redact(view.detail)}</div>;
    }
    const renderer = renderers[view.name] ?? GenericView;
    const error = record(view.result?.output);
    const message = string(record(error?.error)?.message) ?? string(error?.message) ??
        string(error?.error) ?? "Tool execution failed";
    return <>{view.result?.isError && <Notice tone="danger">{message}</Notice>}
        {renderer(view)}</>;
}
