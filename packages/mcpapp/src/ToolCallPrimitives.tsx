import type { ReactNode } from "react";
import { number, record, redact, safeValue, string } from "./ToolCallModel.js";

export function ValueRows({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
    const data = record(safeValue(value));
    if (!data) {
        if (Array.isArray(value)) return <ul className="tc-values">{value.slice(0, 25).map((entry, index) =>
            <li key={index}><ValueRows value={entry} depth={depth + 1} /></li>)}</ul>;
        return <span className="tc-value">{redact(String(value ?? "—")).slice(0, 1_200)}</span>;
    }
    return <dl className="tc-fields">{Object.entries(data).slice(0, depth > 1 ? 8 : 24).map(([key, entry]) =>
        <div className="tc-field" key={key}>
            <dt>{key.replace(/([a-z])([A-Z])/gu, "$1 $2")}</dt>
            <dd>{typeof entry === "object" && entry !== null
                ? depth < 2 ? <ValueRows value={entry} depth={depth + 1} /> : "Nested information"
                : <span>{String(entry ?? "—")}</span>}</dd>
        </div>)}</dl>;
}

export function InfoStrip({ children }: { children: ReactNode }): ReactNode {
    return <div className="tc-info">{children}</div>;
}

export function Notice({ children, tone = "neutral" }: {
    children: ReactNode; tone?: "neutral" | "warning" | "danger";
}): ReactNode {
    return <div role={tone === "danger" ? "alert" : undefined} className="tc-notice" data-tone={tone}>
        {children}
    </div>;
}

const tokenRegex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$|#[^\n]*$|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|pub|fn|struct|impl|use|match|def|True|False|None|self|new|throw|try|catch)\b|\b[0-9]+\b)/gmu;
function syntaxTokens(source: string, language?: string): ReactNode {
    if (!language || !/^(ts|tsx|js|jsx|json|py|rs|css|sh|bash|toml|yaml)$/u.test(language))
        return source;
    const fragments: ReactNode[] = [];
    let start = 0;
    for (const match of source.matchAll(tokenRegex)) {
        const index = match.index;
        if (index > start) fragments.push(source.slice(start, index));
        const token = match[0];
        const category = /^["']/u.test(token) ? "string" :
            /^(\/\/|#)/u.test(token) ? "comment" : /^\d/u.test(token) ? "number" : "keyword";
        fragments.push(<span className={"tc-syntax-" + category} key={index}>{token}</span>);
        start = index + token.length;
    }
    fragments.push(source.slice(start));
    return fragments;
}

export function fileLanguage(path: string): string | undefined {
    const extension = path.split(".").at(-1)?.toLowerCase();
    return extension === "typescript" ? "ts" : extension;
}

export function CodeLines({ text, language, search }: {
    text: string; language?: string; search?: string;
}): ReactNode {
    const content = redact(text).split(/\r?\n/u);
    const shown = content.slice(0, 250);
    return <div className="tc-code" role="region" aria-label="File content">
        {shown.map((line, index) => {
            const numbered = /^(\*?)(\d+):([\s\S]*)$/u.exec(line);
            const lineNo = numbered ? Number(numbered[2]) : index + 1;
            const source = numbered ? numbered[3] : line;
            const marked = numbered?.[1] === "*";
            const matchIndex = search ? source.toLowerCase().indexOf(search.toLowerCase()) : -1;
            return <div className="tc-code-line" data-match={marked || matchIndex >= 0} key={index}>
                <span className="tc-gutter" aria-hidden="true">{lineNo}</span>
                <code>{matchIndex >= 0 && search
                    ? <>{syntaxTokens(source.slice(0, matchIndex), language)}
                        <mark>{source.slice(matchIndex, matchIndex + search.length)}</mark>
                        {syntaxTokens(source.slice(matchIndex + search.length), language)}</>
                    : syntaxTokens(source, language)}</code>
            </div>;
        })}
        {content.length > shown.length && <div className="tc-limit">Showing first 250 lines of this result</div>}
    </div>;
}

type AnsiStyle = { foreground?: string; bold: boolean };
function ansiSegments(text: string): ReactNode {
    // Preserve only SGR colors and weight; discard other control sequences.
    const source = redact(text).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-HJKSTfmnsu]", "gu"), (value) =>
        value.endsWith("m") ? value : "");
    const segments: ReactNode[] = [];
    const expression = new RegExp(String.fromCharCode(27) + "\\[([0-9;]*)m", "gu");
    let previous = 0;
    let style: AnsiStyle = { bold: false };
    const add = (part: string, index: number) => {
        if (part) segments.push(<span key={index} data-ansi={style.foreground ?? "default"}
            className={style.bold ? "tc-ansi-bold" : undefined}>{part}</span>);
    };
    for (const match of source.matchAll(expression)) {
        add(source.slice(previous, match.index), previous);
        for (const code of (match[1] || "0").split(";").map(Number)) {
            if (code === 0) style = { bold: false };
            else if (code === 1) style = { ...style, bold: true };
            else if (code === 22) style = { ...style, bold: false };
            else if (code === 39) style = { ...style, foreground: undefined };
            else if (code >= 30 && code <= 37) style = { ...style, foreground: String(code) };
            else if (code >= 90 && code <= 97) style = { ...style, foreground: String(code - 60) };
        }
        previous = match.index + match[0].length;
    }
    add(source.slice(previous), previous);
    return segments;
}

export function Terminal({ text, title = "Terminal", maxChars = 24_000 }: {
    text: string; title?: string; maxChars?: number;
}): ReactNode {
    const body = text.slice(-maxChars);
    return <div className="tc-terminal" role="region" aria-label={title}>
        <div className="tc-terminal-heading"><span className="tc-terminal-dot" />{title}</div>
        <pre>{ansiSegments(body)}</pre>
        {text.length > body.length && <div className="tc-limit">Showing recent output only</div>}
    </div>;
}

export function UnifiedDiff({ diff }: { diff: string }): ReactNode {
    const lines = redact(diff).split(/\r?\n/u).slice(0, 350);
    return <div className="tc-diff" role="region" aria-label="File diff">
        {lines.map((line, index) => <div key={index} className="tc-diff-line" data-kind={
            line.startsWith("+") && !line.startsWith("+++") ? "added" :
                line.startsWith("-") && !line.startsWith("---") ? "removed" :
                    line.startsWith("@@") || line.startsWith("***") || line.startsWith("diff ") ? "header" : "context"}>
            <code>{line || " "}</code>
        </div>)}
        {diff.split(/\r?\n/u).length > lines.length && <div className="tc-limit">Diff is truncated in this view</div>}
    </div>;
}

interface FileNode { label: string; path: string; type?: string; children: Map<string, FileNode> }
function tree(entries: Array<{ path: string; type?: string }>): FileNode {
    const root: FileNode = { label: "", path: "", children: new Map() };
    for (const entry of entries.slice(0, 180)) {
        let node = root;
        const parts = entry.path.replace(/^\.\//u, "").split("/").filter(Boolean);
        for (const [index, part] of parts.entries()) {
            let child = node.children.get(part);
            if (!child) {
                child = { label: part, path: parts.slice(0, index + 1).join("/"), children: new Map() };
                node.children.set(part, child);
            }
            node = child;
        }
        if (parts.length) node.type = entry.type;
    }
    return root;
}
function TreeNode({ node }: { node: FileNode }): ReactNode {
    const children = Array.from(node.children.values()).sort((left, right) =>
        Number(right.children.size > 0 || right.type === "directory") -
        Number(left.children.size > 0 || left.type === "directory") ||
        left.label.localeCompare(right.label));
    const folder = node.children.size > 0 || node.type === "directory";
    return <li>{folder ? <details open>
        <summary title={node.path}><span aria-hidden="true">▸</span> {node.label || "/"}</summary>
        <ul>{children.map((child) => <TreeNode key={child.path} node={child} />)}</ul>
    </details> : <div className="tc-tree-file" title={node.path}>
        <span aria-hidden="true">{node.type === "symlink" ? "↗" : "◻"}</span> {node.label}
    </div>}</li>;
}

export function FileTree({ entries }: { entries: Array<{ path: string; type?: string }> }): ReactNode {
    const root = tree(entries.map((entry) => ({ path: redact(entry.path), type: entry.type })));
    return <div className="tc-tree" role="tree" aria-label="Matching files and directories">
        {entries.length ? <ul>{Array.from(root.children.values()).map((node) =>
            <TreeNode key={node.path} node={node} />)}</ul> : <Notice>No matching paths</Notice>}
        {entries.length > 180 && <div className="tc-limit">Showing first 180 entries</div>}
    </div>;
}

export function TaskState({ status }: { status: unknown }): ReactNode {
    const state = string(status) ?? "unknown";
    const tone = state === "completed" || state === "0" ? "done" :
        state === "failed" || (/^\d+$/u.test(state) && state !== "0") ? "failed" :
            state === "running" || state === "in_progress" ? "running" : "other";
    return <span className="tc-task-status" data-tone={tone}>{state.replaceAll("_", " ")}</span>;
}

export function Stat({ label, value }: { label: string; value: string | number | undefined }): ReactNode {
    return value === undefined ? null : <span className="tc-stat">
        <span>{label}</span><strong>{value}</strong>
    </span>;
}

export function KeySummary({ output }: { output: unknown }): ReactNode {
    const data = record(output);
    if (!data) return null;
    return <div className="tc-stats">
        <Stat label="Exit" value={number(data.exitCode)} />
        <Stat label="Duration" value={number(data.durationMs) === undefined
            ? undefined : Math.round(number(data.durationMs)!) + " ms"} />
        <Stat label="stdout" value={number(data.stdoutBytes)} />
        <Stat label="stderr" value={number(data.stderrBytes)} />
    </div>;
}
