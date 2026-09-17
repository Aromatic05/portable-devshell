import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { parseContextMessageDirective } from "@portable-devshell/shared/browser";

import type { WebMessageEntry } from "../Model.js";

export const ConversationHistory = memo(function ConversationHistory({
    entries,
    threadKey,
}: {
    entries: readonly WebMessageEntry[];
    threadKey: string;
}) {
    const historyEndRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);
    const previousThreadKeyRef = useRef<string>();
    const latestEntryId = entries.at(-1)?.id;

    useLayoutEffect(() => {
        if (previousThreadKeyRef.current !== threadKey) {
            previousThreadKeyRef.current = threadKey;
            followBottomRef.current = true;
        }
        const end = historyEndRef.current;
        if (
            followBottomRef.current &&
            typeof end?.scrollIntoView === "function"
        ) {
            end.scrollIntoView({ block: "end" });
        }
    }, [latestEntryId, threadKey]);

    useEffect(() => {
        const updateFollowBottom = () => {
            const distanceFromBottom =
                document.documentElement.scrollHeight -
                window.innerHeight -
                window.scrollY;
            followBottomRef.current = distanceFromBottom <= 96;
        };
        window.addEventListener("scroll", updateFollowBottom, {
            passive: true,
        });
        return () => window.removeEventListener("scroll", updateFollowBottom);
    }, [threadKey]);

    return (
        <div
            aria-label="Conversation history"
            className="message-history"
            role="log"
        >
            {entries.length === 0 ? (
                <p className="empty">No Comments or Reports yet.</p>
            ) : (
                entries.map((entry) => {
                    const parsed =
                        entry.kind === "comment"
                            ? parseContextMessageDirective(entry.text)
                            : { body: entry.text };
                    return (
                        <article
                            className={`message-entry ${entry.kind}`}
                            key={entry.id}
                        >
                            <div className="message-meta">
                                <strong>
                                    {entry.kind === "comment" ? "You" : "Agent"}
                                </strong>
                                <time dateTime={entry.at}>
                                    {formatMessageDate(entry.at)}
                                </time>
                                {parsed.directive === undefined ? null : (
                                    <span className="message-control-chip">
                                        #{parsed.directive}
                                    </span>
                                )}
                                {entry.kind === "comment" &&
                                entry.status !== "delivered" ? (
                                    <span className="result pending">
                                        {entry.status}
                                    </span>
                                ) : null}
                            </div>
                            {parsed.body.length === 0 ? null : (
                                <p>{parsed.body}</p>
                            )}
                        </article>
                    );
                })
            )}
            <div
                aria-hidden="true"
                className="message-history-end"
                ref={historyEndRef}
            />
        </div>
    );
});

function formatMessageDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}
