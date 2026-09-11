import { Box, Text } from "ink";

import { readContextConversationDraft } from "../../../state/TuiContextConversationDraft.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
} from "../../../state/route/TuiRouteState.js";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    tuiMessagesHistoryRows,
    tuiMessagesRenderedHistoryRows,
} from "./TuiMessagesProjection.js";

export function TuiMessagesView(props: {
    state: TuiAppState;
    viewportRows: number;
    width: number;
}) {
    const route = currentTuiRoute(props.state);
    const instance = props.state.ui.selectedInstance;
    if (route.page !== "messages" || route.view === "contexts" || instance === undefined) {
        return (
            <Box flexDirection="column">
                <Text bold>Messages</Text>
                <Text dimColor>Select a session from the Context sidebar.</Text>
            </Box>
        );
    }

    const history = renderTuiMessageHistoryLines(
        props.state,
        instance,
        route.ctxId,
        props.width,
    );
    const historyRows = tuiMessagesHistoryRows(props.viewportRows);
    const maxOffset = Math.max(0, history.length - historyRows);
    const scrollKey = currentTuiRouteScrollKey(props.state);
    const requestedOffset = props.state.ui.scrollOffsets[scrollKey] ?? maxOffset;
    const offset = Math.min(Math.max(0, requestedOffset), maxOffset);
    const visible = history.slice(offset, offset + historyRows);
    const renderedHistoryRows = tuiMessagesRenderedHistoryRows(
        visible.length,
        props.viewportRows,
    );
    const draft = readContextConversationDraft(props.state, instance, route.ctxId);
    const editor = props.state.interaction.editor;
    const editing =
        props.state.interaction.focusScope === "contextConversation" &&
        editor?.kind === "comment" &&
        editor.editing === true;
    const status = props.state.interaction.screenStatusByPage.messages;

    return (
        <Box flexDirection="column">
            <Box flexDirection="column" height={renderedHistoryRows} overflow="hidden">
                {visible.length === 0 ? <Text dimColor>No messages yet.</Text> : null}
                {visible.map((line, index) => (
                    <Text dimColor={line.kind === "meta"} key={`${offset + index}:${line.text}`}>
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

function ComposerText(props: { cursor: number; cursorVisible: boolean; draft: string }) {
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
