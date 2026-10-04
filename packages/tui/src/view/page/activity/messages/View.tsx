import { Box, Text } from "ink";

import { readContextMessageDraft } from "./Draft.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
} from "../../../../state/route/State.js";
import type { TuiDomainReader } from "../../../domain/Reader.js";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    selectTuiMessageHiddenSessions,
    selectTuiMessageHistorySessions,
    selectTuiMessageSessions,
    tuiMessagesHistoryRows,
} from "./Projection.js";

export function TuiMessagesView(props: {
    reader: TuiDomainReader;
    state: TuiAppState;
    viewportRows: number;
    width: number;
}) {
    const route = currentTuiRoute(props.state);
    if (route.page !== "messages" || route.view === "contexts") {
        const scope = props.state.ui.messageScope;
        const messages =
            scope === "active"
                ? selectTuiMessageSessions(props.reader)
                : scope === "history"
                  ? selectTuiMessageHistorySessions(props.reader)
                  : selectTuiMessageHiddenSessions(props.reader);
        const message =
            messages.length === 0
                ? scope === "active"
                    ? "No current messages. Open History or Hidden."
                    : scope === "history"
                      ? "No message history."
                      : "No hidden messages."
                : "Select a Message from the sidebar.";
        return (
            <Box flexDirection="column">
                <Text bold>Messages</Text>
                <Text dimColor>{message}</Text>
            </Box>
        );
    }
    const instance = route.instance;

    const history = renderTuiMessageHistoryLines(
        props.reader,
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
    const draft = readContextMessageDraft(
        props.state,
        instance,
        route.ctxId,
    );
    const editor = props.state.interaction.editor;
    const editing =
        props.state.interaction.focusScope === "contextMessage" &&
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
