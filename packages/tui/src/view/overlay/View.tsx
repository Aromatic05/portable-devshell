import type {
    ApprovalRequest,
    ToolCallRecord,
} from "@portable-devshell/shared";
import { Box, Text } from "ink";

import type { TuiAppState } from "../../state/store/Model.js";
import { topTuiOverlay } from "../../state/Overlay.js";
import type { TuiDomainReader } from "../../app/control/Reader.js";
import { TuiComponentConfirmDialog } from "./Confirm.js";
import { TuiComponentTextDetail } from "../component/content/Detail.js";
import {
    tuiApprovalActions,
    tuiApprovalActionText,
    tuiApprovalFields,
    tuiOverlayBodyLayout,
    tuiConfirmationBodyText,
} from "./Presentation.js";

export interface TuiOverlayViewProps {
    onTextDetailImageVisibility?(visible: boolean): void;
    reader: TuiDomainReader;
    state: TuiAppState;
    viewportRows: number;
    width: number;
}

export function TuiOverlayView(props: TuiOverlayViewProps) {
    const overlay = topTuiOverlay(props.state.interaction.overlays);
    if (overlay === undefined) return null;

    switch (overlay.kind) {
        case "confirmation":
            return (
                <TuiComponentConfirmDialog
                    body={tuiConfirmationBodyText(overlay)}
                    cancelFocused={overlay.selectedAction === "cancel"}
                    cancelLabel={overlay.cancelLabel}
                    confirmFocused={overlay.selectedAction === "confirm"}
                    confirmLabel={overlay.confirmLabel}
                    open={true}
                    title={overlay.title}
                    scrollOffset={overlay.scrollOffset}
                    viewportRows={props.viewportRows}
                    width={props.width}
                />
            );
        case "text-detail":
            return (
                <TuiComponentTextDetail
                    detail={{
                        body: overlay.body,
                        image: overlay.image,
                        scrollOffset: overlay.scrollOffset,
                        title: overlay.title,
                    }}
                    onImageVisibility={props.onTextDetailImageVisibility}
                    viewportRows={props.viewportRows}
                    width={props.width}
                />
            );
        case "approval": {
            const approval = props.reader
                .approval(overlay.instance)
                .approvals.find(
                    (candidate) => candidate.approvalId === overlay.approvalId,
                );
            const toolCall =
                approval === undefined
                    ? undefined
                    : props.reader.toolCalls.instances[
                          overlay.instance
                      ]?.calls.find(
                          (candidate) => candidate.callId === approval.callId,
                      );
            return (
                <ApprovalOverlay
                    approval={approval}
                    selectedAction={overlay.selectedAction}
                    scrollOffset={overlay.scrollOffset}
                    viewportRows={props.viewportRows}
                    toolCall={toolCall}
                    width={props.width}
                />
            );
        }
        case "search":
            return (
                <Box borderColor="cyan" borderStyle="round" paddingX={1}>
                    <Text>{`/ ${props.state.ui.searchQueries[props.state.ui.selectedPage] ?? ""}`}</Text>
                </Box>
            );
        case "tool-form":
            return (
                <Box
                    borderColor="cyan"
                    borderStyle="round"
                    flexDirection="column"
                    paddingX={1}
                >
                    <Text bold>{`Call Tool: ${overlay.toolName}`}</Text>
                    <Text dimColor>{`instance ${overlay.instance}`}</Text>
                    <Text>{overlay.input}</Text>
                </Box>
            );
    }
}

function ApprovalOverlay(props: {
    approval?: ApprovalRequest;
    scrollOffset?: number;
    viewportRows: number;
    selectedAction: "back" | "input" | "deny" | "approve";
    toolCall?: ToolCallRecord;
    width: number;
}) {
    if (props.approval === undefined) {
        return (
            <Box borderColor="yellow" borderStyle="round" paddingX={1}>
                <Text color="yellow">
                    Approval is no longer pending. Close this overlay to return.
                </Text>
            </Box>
        );
    }

    const body = tuiApprovalFields(props.approval, props.toolCall)
        .map(([label, value]) => `${label}: ${value}`).join("\n");
    const layout = tuiOverlayBodyLayout(body, props.width, props.viewportRows, props.scrollOffset);

    return (
        <Box
            borderColor="cyan"
            borderStyle="round"
            flexDirection="column"
            paddingX={1}
            width={props.width}
        >
            <Text bold>Approval</Text>
            <Box flexDirection="column" height={layout.rows} flexShrink={0}>
                {layout.lines.map((line, index) => <Text key={index}>{line}</Text>)}
            </Box>
            <Text dimColor>{`PgUp/PgDn scroll · ${layout.offset + 1}-${layout.offset + layout.rows}/${layout.total}`}</Text>
            <Box flexShrink={0}>
                {tuiApprovalActions.map((action) => (
                    <Text
                        backgroundColor={
                            props.selectedAction === action ? "cyan" : undefined
                        }
                        key={action}
                    >
                        {tuiApprovalActionText(action)}
                    </Text>
                ))}
            </Box>
        </Box>
    );
}
