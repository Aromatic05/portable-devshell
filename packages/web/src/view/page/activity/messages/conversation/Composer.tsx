import { type FormEvent, useEffect, useRef, useState } from "react";
import {
    parseContextMessageDirective,
    type ContextMessageDirective,
} from "@portable-devshell/shared/browser";

import type { WebRoute } from "../../../../../app/Route.js";
import type { WebState } from "../../../../../state/Model.js";
import type { WebStore } from "../../../../../state/Store.js";
import {
    buildConversationMarkdown,
    downloadMarkdown,
    markdownExportFilename,
} from "../Export.js";
import type { WebMessageEntry } from "../Model.js";

export function ConversationComposer({
    entries,
    onActivity,
    route,
    state,
    store,
    title,
}: {
    entries: readonly WebMessageEntry[];
    onActivity(): void;
    route: Extract<WebRoute, { page: "messages"; view: "thread" }>;
    state: WebState;
    store: WebStore;
    title: string;
}) {
    const [draft, setDraft] = useState("");
    const [messageDirective, setMessageDirective] =
        useState<ContextMessageDirective>();
    const [controlMenuOpen, setControlMenuOpen] = useState(false);
    const [feedback, setFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();
    const controlMenuRef = useRef<HTMLDivElement>(null);
    const controlTriggerRef = useRef<HTMLButtonElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!controlMenuOpen) return;
        const pointerDown = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                controlMenuRef.current?.contains(event.target) !== true
            ) {
                setControlMenuOpen(false);
            }
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setControlMenuOpen(false);
                queueMicrotask(() => controlTriggerRef.current?.focus());
            }
        };
        document.addEventListener("pointerdown", pointerDown);
        document.addEventListener("keydown", keyDown);
        return () => {
            document.removeEventListener("pointerdown", pointerDown);
            document.removeEventListener("keydown", keyDown);
        };
    }, [controlMenuOpen]);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const text = composeMessageText(messageDirective, draft);
        if (text.length === 0) return;
        setFeedback(undefined);
        const queued = await store.queueContextMessage(
            route.instance,
            route.ctxId,
            text,
        );
        if (queued) {
            setDraft("");
            setMessageDirective(undefined);
            setControlMenuOpen(false);
            setFeedback({ kind: "success", text: "Message queued." });
            const textarea = textareaRef.current;
            if (textarea !== null) textarea.style.height = "";
        } else {
            setFeedback({
                kind: "error",
                text: store.state.error ?? "Message could not be queued.",
            });
        }
    }

    function exportMarkdown(): void {
        downloadMarkdown(
            markdownExportFilename(title, route.instance, route.ctxId),
            buildConversationMarkdown({
                ctxId: route.ctxId,
                entries,
                instance: route.instance,
                title,
            }),
        );
    }

    const operation = `context-message:${route.instance}:${route.ctxId}`;
    return (
        <form
            className="messages-composer"
            onSubmit={(event) => void submit(event)}
        >
            {messageDirective === undefined ? null : (
                <div className="messages-composer-controls">
                    <span className="message-control-card">
                        <strong>#{messageDirective}</strong>
                        <button
                            aria-label="Remove message control"
                            onClick={() => setMessageDirective(undefined)}
                            type="button"
                        >
                            ×
                        </button>
                    </span>
                </div>
            )}
            <div className="messages-control-picker" ref={controlMenuRef}>
                <button
                    aria-controls="messages-control-popover"
                    aria-expanded={controlMenuOpen}
                    aria-label="Add message control"
                    onClick={() => setControlMenuOpen((open) => !open)}
                    ref={controlTriggerRef}
                    type="button"
                >
                    +
                </button>
                {controlMenuOpen ? (
                    <div
                        aria-label="Message controls"
                        className="messages-control-menu"
                        id="messages-control-popover"
                    >
                        {messageControlOptions.map((option) => (
                            <button
                                key={option.directive}
                                onClick={() => {
                                    setMessageDirective(option.directive);
                                    setControlMenuOpen(false);
                                }}
                                type="button"
                            >
                                <strong>{option.label}</strong>
                                <span>{option.description}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            <label className="sr-only" htmlFor="messages-comment">
                Comment
            </label>
            <textarea
                id="messages-comment"
                maxLength={composerMaxLength}
                onChange={(event) => {
                    onActivity();
                    setFeedback(undefined);
                    setDraft(event.target.value);
                    growComposerTextarea(event.target);
                }}
                onFocus={onActivity}
                onKeyDown={(event) => {
                    if (
                        event.key !== "Enter" ||
                        event.shiftKey ||
                        event.nativeEvent.isComposing
                    )
                        return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                }}
                placeholder="Send a Comment"
                ref={textareaRef}
                rows={1}
                value={draft}
            />
            <button
                aria-label="Export Markdown"
                className="messages-export"
                onClick={exportMarkdown}
                title="Export Markdown"
                type="button"
            >
                ↓
            </button>
            <button
                aria-label="Send Comment"
                className="primary"
                disabled={
                    (draft.trim().length === 0 &&
                        messageDirective === undefined) ||
                    state.operations[operation] !== undefined
                }
                type="submit"
            >
                {state.operations[operation] !== undefined ? "…" : "➤"}
            </button>
            {draft.length > composerLengthHintThreshold ? (
                <p aria-live="off" className="messages-composer-length">
                    {draft.length} / {composerMaxLength}
                </p>
            ) : null}
            {feedback === undefined ? null : (
                <p
                    className={`messages-composer-feedback ${feedback.kind === "error" ? "error" : "notice"}`}
                    role={feedback.kind === "error" ? "alert" : "status"}
                >
                    {feedback.text}
                </p>
            )}
        </form>
    );
}

const composerMaxLength = 20_000;
const composerLengthHintThreshold = 18_000;
const composerTextareaMaxHeightPx = 160;

const messageControlOptions: ReadonlyArray<{
    description: string;
    directive: ContextMessageDirective;
    label: string;
}> = [
    {
        description: "Require a reply within five tool calls.",
        directive: "push",
        label: "Push",
    },
    {
        description: "Stop model tool calls until resumed.",
        directive: "stop",
        label: "Stop",
    },
    {
        description: "Release a previous Stop.",
        directive: "resume",
        label: "Resume",
    },
];

function composeMessageText(
    directive: ContextMessageDirective | undefined,
    draft: string,
): string {
    const text = draft.trim();
    if (directive === undefined) return text;
    const parsed = parseContextMessageDirective(text);
    const body = parsed.directive === undefined ? text : parsed.body;
    return body.length === 0 ? `#${directive}` : `#${directive} ${body}`;
}

function growComposerTextarea(element: HTMLTextAreaElement): void {
    if (element.scrollHeight <= 0) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, composerTextareaMaxHeightPx)}px`;
}
