import { Box, Text } from "ink";

import { readContextConversationDraft } from "../../../state/TuiContextConversationDraft.js";
import { isActiveContextForInstance, isLatestObservedContext } from "../../../state/audit/TuiAuditContextActivity.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
} from "../../../state/route/TuiRouteState.js";
import {
    renderTuiMessageHistoryLines,
    tuiMessagesHistoryRows,
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
    const draft = readContextConversationDraft(props.state, instance, route.ctxId);
    const editor = props.state.interaction.editor;
    const editing =
        props.state.interaction.focusScope === "contextConversation" &&
        editor?.kind === "comment" &&
        editor.editing === true;
    const active = isActiveContextForInstance(props.state, instance, route.ctxId);
    const current = active && isLatestObservedContext(props.state, instance, route.ctxId);
    const status = props.state.interaction.screenStatusByPage.messages;

    return (
        <Box flexDirection="column" height={props.viewportRows}>
            <Box flexDirection="column" height={historyRows} overflow="hidden">
                {visible.length === 0 ? <Text dimColor>No messages yet.</Text> : null}
                {visible.map((line, index) => (
                    <Text dimColor={line.kind === "meta"} key={`${offset + index}:${line.text}`}>
                        {line.text}
                    </Text>
                ))}
            </Box>
            <Text dimColor>{"─".repeat(Math.max(1, props.width))}</Text>
            <Box>
                <Text>{current ? "> " : "× "}</Text>
                {editing ? (
                    <ComposerText draft={draft} cursor={editor.cursor ?? draft.length} />
                ) : (
                    <Text dimColor={!current}>
                        {draft || (current ? "Write a comment…" : "Comment unavailable")}
                    </Text>
                )}
            </Box>
            <Text dimColor>
                {status ?? (current ? "Enter send · Esc sessions" : "This session is read-only.")}
            </Text>
        </Box>
    );
}

function ComposerText(props: { cursor: number; draft: string }) {
    const cursor = Math.min(Math.max(0, props.cursor), props.draft.length);
    return (
        <Text>
            {props.draft.slice(0, cursor)}
            <Text inverse>{props.draft[cursor] ?? " "}</Text>
            {props.draft.slice(cursor + (cursor < props.draft.length ? 1 : 0))}
        </Text>
    );
}
