import type {
    ApprovalRequest,
    ToolCallRecord,
} from "@portable-devshell/shared";
import { Box, Text } from "ink";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { topTuiOverlay } from "../../state/overlay/TuiOverlay.js";
import { TuiComponentConfirmDialog } from "../component/TuiComponentConfirmDialog.js";
import { TuiComponentTextDetail } from "../component/TuiComponentTextDetail.js";

export interface TuiOverlayViewProps {
    onTextDetailImageVisibility?(visible: boolean): void;
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
                    body={overlay.body}
                    cancelFocused={overlay.selectedAction === "cancel"}
                    cancelLabel={overlay.cancelLabel}
                    confirmFocused={overlay.selectedAction === "confirm"}
                    confirmLabel={overlay.confirmLabel}
                    open={true}
                    title={overlay.title}
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
            const approval = (
                props.state.readModel.instanceState[overlay.instance]?.approvals ?? []
            ).find((candidate) => candidate.approvalId === overlay.approvalId);
            const toolCall =
                approval === undefined
                    ? undefined
                    : (
                          props.state.readModel.instanceState[overlay.instance]?.toolCalls ??
                          []
                      ).find(
                          (candidate) => candidate.callId === approval.callId,
                      );
            return (
                <ApprovalOverlay
                    approval={approval}
                    selectedAction={overlay.selectedAction}
                    toolCall={toolCall}
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
    selectedAction: "back" | "input" | "deny" | "approve";
    toolCall?: ToolCallRecord;
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

    const fields = [
        ["instance", props.approval.instance],
        ["approval", props.approval.approvalId],
        ["call", props.approval.callId],
        ["source", props.approval.source],
        ["tool", props.approval.toolName],
        ["risk", props.approval.riskLevel],
        ["policy reason", props.approval.reason],
        ["requested", props.approval.createdAt],
        ["expires", props.approval.expiresAt],
        [
            "input summary",
            props.toolCall?.inputSummary ?? props.approval.inputSummary,
        ],
    ] as const;
    const actions = ["back", "input", "deny", "approve"] as const;

    return (
        <Box
            borderColor="cyan"
            borderStyle="round"
            flexDirection="column"
            paddingX={1}
        >
            <Text bold>Approval</Text>
            {fields.map(([label, value]) => (
                <Text key={label}>{`${label}: ${value}`}</Text>
            ))}
            <Box marginTop={1}>
                {actions.map((action) => (
                    <Text
                        backgroundColor={
                            props.selectedAction === action ? "cyan" : undefined
                        }
                        key={action}
                    >{` ${action[0]!.toUpperCase()}${action.slice(1)} `}</Text>
                ))}
            </Box>
        </Box>
    );
}
