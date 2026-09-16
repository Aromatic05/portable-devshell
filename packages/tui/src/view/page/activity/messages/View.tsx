import { Box, Text } from "ink";

import { readContextConversationDraft } from "./Draft.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
} from "../../../../state/route/State.js";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    selectTuiMessageHiddenSessions,
    selectTuiMessageHistorySessions,
    selectTuiMessageSessions,
    tuiMessagesHistoryRows,
} from "./Projection.js";

export function TuiMessagesView(props: {
    state: TuiAppState;
    viewportRows: number;
    width: number;
}) {
    const route = currentTuiRoute(props.state);
    if (route.page !== "messages" || route.view === "contexts") {
        const scope = props.state.ui.messageScope;
        const conversations =
            scope === "active"
                ? selectTuiMessageSessions(props.state)
                : scope === "history"
                  ? selectTuiMessageHistorySessions(props.state)
                  : selectTuiMessageHiddenSessions(props.state);
        const message =
            conversations.length === 0
                ? scope === "active"
                    ? "No current conversations. Open History or Hidden."
                    : scope === "history"
                      ? "No conversation history."
                      : "No hidden conversations."
                : "Select a Conversation from the sidebar.";
        return (
            <Box flexDirection="column">
                <Text bold>Messages</Text>
                <Text dimColor>{message}</Text>
            </Box>
        );
    }
    const instance = route.instance;

    const history = renderTuiMessageHistoryLines(
        props.state,
        instance,
        route.ctxId,
        props.width,
    );
    const historyRows = tuiMessagesHistoryRows(props.viewportRows);
    const maxOffset = Math.max(0, history.length - historyRows);
    const scrollKey = currentTuiRouteScrollKey(props.state);
    const requestedOffset =
        props.state.ui.scrollOffsets[scrollKey] ?? maxOffset;
    const offset = Math.min(Math.max(0, requestedOffset), maxOffset);
    const visible = history.slice(offset, offset + historyRows);
    const draft = readContextConversationDraft(
        props.state,
        instance,
        route.ctxId,
    );
    const editor = props.state.interaction.editor;
    const editing =
        props.state.interaction.focusScope === "contextConversation" &&
        editor?.kind === "comment" &&
        editor.editing === true;
    const status = props.state.interaction.screenStatusByPage.messages;

    return (
        <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="column" height={historyRows} overflow="hidden">
                {visible.length === 0 ? (
                    <Text dimColor>No messages yet.</Text>
                ) : null}
                {visible.map((line, index) => (
                    <Text
                        dimColor={line.kind === "meta"}
                        key={`${offset + index}:${line.text}`}
                    >
                        {line.text}
                    </Text>
                ))}
            </Box>
            <Text dimColor>{"─".repeat(Math.max(1, props.width))}</Text>
            <Box>
                <Text>{"> "}</Text>
                {editing ? (
                    <ComposerText
                        cursor={editor.cursor ?? draft.length}
                        cursorVisible
                        draft={draft}
                    />
                ) : (
                    <Text>{draft || "Write a comment…"}</Text>
                )}
            </Box>
            <Text dimColor>{status ?? "Enter send · Esc sessions"}</Text>
        </Box>
    );
}

function ComposerText(props: {
    cursor: number;
    cursorVisible: boolean;
    draft: string;
}) {
    const segments = renderTuiMessageComposerSegments(
        props.draft,
        props.cursor,
        props.cursorVisible,
    );
    return (
        <Text>
            {segments.map((segment, index) => (
                <Text key={index} underline={segment.underline}>
                    {segment.text}
                </Text>
            ))}
        </Text>
    );
}
