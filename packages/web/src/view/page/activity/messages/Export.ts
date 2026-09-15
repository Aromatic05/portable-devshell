import type { WebMessageEntry } from "./Model.js";

export function buildConversationMarkdown({
    ctxId,
    entries,
    instance,
    title,
}: {
    ctxId: string;
    entries: readonly WebMessageEntry[];
    instance: string;
    title: string;
}): string {
    const lines = [
        `# ${title}`,
        "",
        `- Instance: \`${instance}\``,
        `- Context: \`${ctxId}\``,
    ];

    for (const entry of entries) {
        lines.push(
            "",
            `## ${entry.kind === "comment" ? "You" : "Agent"}`,
            "",
            `_${entry.at}_`,
            "",
            entry.text,
        );
    }

    return `${lines.join("\n")}\n`;
}

export function markdownExportFilename(
    title: string,
    instance: string,
    ctxId: string,
): string {
    const stem = `${title}-${instance}-${ctxId}`
        .replace(/[<>:"/\\|?*]+/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120);
    return `${stem || "conversation"}.md`;
}

export function downloadMarkdown(filename: string, markdown: string): void {
    const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    link.style.display = "none";
    document.body.append(link);
    try {
        link.click();
    } finally {
        link.remove();
        URL.revokeObjectURL(url);
    }
}
