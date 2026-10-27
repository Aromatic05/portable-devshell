import { Box, Text } from "ink";

import { readContextMessageDraft } from "../../../../state/editor/MessageDraft.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
} from "../../../../state/route/State.js";
import type { TuiDomainReader } from "../../../../app/control/Reader.js";
import {
    renderTuiMessageComposerLines,
    renderTuiMessageHistoryLines,
    selectTuiMessageHiddenSessions,
    selectTuiMessageHistorySessions,
    selectTuiMessageSessions,
    tuiMessagesHistoryRows,
    tuiMessageHistoryNotice,
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
    const notice = tuiMessageHistoryNotice(props.reader, instance, route.ctxId);
    const historyRows = Math.max(0, tuiMessagesHistoryRows(props.viewportRows) - (notice === undefined ? 0 : 1));
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
            <Box flexDirection="column" height={tuiMessagesHistoryRows(props.viewportRows)} overflow="hidden">
                {notice === undefined ? null : <Text color="yellow" wrap="truncate-end">{notice}</Text>}
                {visible.length === 0 && notice === undefined ? (
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
            <Box height={2} flexShrink={0} overflowY="hidden">
                <Text>{"> "}</Text>
                <ComposerText
                    cursor={editing ? editor.cursor ?? draft.length : draft.length}
                    cursorVisible={editing}
                    draft={draft || (editing ? "" : "Write a comment…")}
                    width={Math.max(1, props.width - 2)}
                />
            </Box>
            <Text dimColor wrap="truncate-end">{status ?? "Enter send · Esc sessions"}</Text>
        </Box>
    );
}

function ComposerText(props: {
    cursor: number;
    cursorVisible: boolean;
    draft: string;
    width: number;
}) {
    const lines = renderTuiMessageComposerLines(
        props.draft,
        props.cursor,
        props.cursorVisible,
        props.width,
        2,
    );
    return (
        <Box flexDirection="column" width={props.width} flexShrink={0}>
            {lines.map((segments, row) => (
                <Text key={row} wrap="truncate-end">
                    {segments.map((segment, index) => (
                        <Text key={index} underline={segment.underline}>
                            {segment.text}
                        </Text>
                    ))}
                </Text>
            ))}
        </Box>
    );
}
