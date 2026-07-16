import { withDerivedState } from "./TuiStoreReducerSupport.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerControl(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
        case "approval.replace":
            return withDerivedState({
                ...state,
                approvalsByInstance: {
                    ...state.approvalsByInstance,
                    [action.instance]: [...action.approvals].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                }
            });
        case "oauthApproval.replace":
            return withDerivedState({
                ...state,
                oauthApprovals: [...action.approvals].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            });
        case "command.upsert": {
            const without = state.commandRecords.filter((command) => command.commandId !== action.command.commandId);
            return {
                ...state,
                commandRecords: [...without, action.command].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
            };
        }
        case "panelError.set": {
            const panelErrors = { ...state.panelErrors };

            if (action.error === undefined) {
                delete panelErrors[action.key];
            } else {
                panelErrors[action.key] = action.error;
            }

            return {
                ...state,
                panelErrors
            };
        }
        case "relay.appendOutput": {
            const current = state.relayByCommand[action.commandId] ?? { commandId: action.commandId, output: [] };
            return {
                ...state,
                relayByCommand: {
                    ...state.relayByCommand,
                    [action.commandId]: {
                        ...current,
                        output: [...current.output, action.chunk]
                    }
                }
            };
        }
        case "relay.setMetadata": {
            const current = state.relayByCommand[action.commandId] ?? { commandId: action.commandId, output: [] };
            return {
                ...state,
                relayByCommand: {
                    ...state.relayByCommand,
                    [action.commandId]: {
                        ...current,
                        ...(action.provider === undefined ? {} : { provider: action.provider }),
                        ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
                        ...(action.workspace === undefined ? {} : { workspace: action.workspace })
                    }
                }
            };
        }
        case "control.setConfigView":
            return {
                ...state,
                configView: action.configView
            };
        case "control.setMcpStatus":
            return {
                ...state,
                mcpStatus: action.mcpStatus
            };
        case "control.setConnectionState":
            return {
                ...state,
                connection: {
                    errorCode: action.errorCode,
                    errorMessage: action.errorMessage,
                    status: action.status
                }
            };
        case "control.setRestartRequired":
            return {
                ...state,
                ui: { ...state.ui, controlRestartRequired: action.required }
            };
    }
}
