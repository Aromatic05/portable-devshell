import {
    type FormEvent,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    parseContextMessageDirective,
    type ContextMessageDirective,
} from "@portable-devshell/shared";

import type { WebRoute } from "../../../../../app/Route.js";
import type { WebStore } from "../../../../../state/Store.js";
import {
    buildMessageMarkdown,
    downloadMarkdown,
    markdownExportFilename,
} from "../Export.js";
import type { WebMessageEntry } from "../Model.js";

export interface MessageDraft {
    text: string;
    directive?: ContextMessageDirective;
}

export function MessageComposer({
    draft: messageDraft,
    onDraftChange,
    historyComplete,
    entries,
    onActivity,
    route,
    store,
    title,
}: {
    draft: MessageDraft;
    onDraftChange(update: (draft: MessageDraft) => MessageDraft): void;
    historyComplete: boolean;
    entries: readonly WebMessageEntry[];
    onActivity(): void;
    route: Extract<WebRoute, { page: "messages"; view: "thread" }>;
    store: WebStore;
    title: string;
}) {
    const operations = useSyncExternalStore(
        store.subscribe,
        () => store.state.operations,
        () => store.state.operations,
    );
    const draft = messageDraft.text;
    const messageDirective = messageDraft.directive;
    const [controlMenuOpen, setControlMenuOpen] = useState(false);
    const [feedback, setFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();
    const draftRevision = useRef(0);
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
        const submittedDraft = messageDraft;
        const submittedRevision = draftRevision.current;
        const text = composeMessageText(messageDirective, draft);
        if (text.length === 0) return;
        setFeedback(undefined);
        const queued = await store.queueContextMessage(
            route.instance,
            route.ctxId,
            text,
        );
        if (queued && draftRevision.current !== submittedRevision) return;
        if (queued) {
            onDraftChange((current) => current === submittedDraft ? { text: "" } : current);
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
            buildMessageMarkdown({
                ctxId: route.ctxId,
                entries,
                instance: route.instance,
                title,
                historyComplete,
            }),
        );
        setFeedback({ kind: "success", text: historyComplete
            ? `Exported ${entries.length} loaded messages.`
            : `Exported ${entries.length} loaded messages only. Earlier history may be missing; load older messages before exporting again.` });
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
                            onClick={() => {
                                draftRevision.current += 1;
                                onDraftChange((current) => ({ ...current, directive: undefined }));
                            }}
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
                                    draftRevision.current += 1;
                                    onDraftChange((current) => ({ ...current, directive: option.directive }));
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
                    draftRevision.current += 1;
                    const text = event.target.value;
                    onDraftChange((current) => ({ ...current, text }));
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
                title={historyComplete ? "Export Markdown" : "Export loaded messages only; earlier history may be missing"}
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
                    operations[operation] !== undefined
                }
                type="submit"
            >
                {operations[operation] !== undefined ? "…" : "➤"}
            </button>
            {historyComplete ? null : <p className="hint">Markdown export includes loaded messages only. Load older Comments and Reports to include earlier history.</p>}
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
