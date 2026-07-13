import { applyEventRecord } from "./eventReducer.js";
import { compareToolCallRecord, dedupeLogs, mergeLogEntry, pruneByInstanceNames, pruneByInstances, selectInstanceAfterListReplace, withDerivedState } from "./helpers.js";
import type { TuiAppAction, TuiAppState } from "./types.js";

export function tuiAppReducer(state: TuiAppState, action: TuiAppAction): TuiAppState {
    switch (action.type) {
        case "artifact.share.replace":
            return {
                ...state,
                artifactShares: [...action.shares].sort((left, right) => right.expiresAtMs - left.expiresAtMs)
            };
        case "artifact.share.upsert":
            return {
                ...state,
                artifactShares: [
                    action.share,
                    ...state.artifactShares.filter((share) => share.shareId !== action.share.shareId)
                ].sort((left, right) => right.expiresAtMs - left.expiresAtMs)
            };
        case "artifact.transfer.replace":
            return {
                ...state,
                artifactTransfers: [...action.transfers].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            };
        case "artifact.transfer.upsert":
            return {
                ...state,
                artifactTransfers: [
                    action.transfer,
                    ...state.artifactTransfers.filter((transfer) => transfer.transferId !== action.transfer.transferId)
                ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            };
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
        case "focus.scope.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    focusScope: action.focusScope
                },
                ui: {
                    ...state.ui,
                    focusScope: action.focusScope
                }
            };
        case "auditPage.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    auditPage: action.auditPage
                }
            };
        case "mainFocus.set":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    mainFocusId: action.mainFocusId
                }
            };
        case "confirm.focus":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    selectedConfirmButton: action.button
                }
            };
        case "detailLine.select": {
            const selectedDetailLineIds = { ...state.interaction.selectedDetailLineIds };

            if (action.lineId === undefined) {
                delete selectedDetailLineIds[action.key];
            } else {
                selectedDetailLineIds[action.key] = action.lineId;
            }

            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    selectedDetailLineIds
                }
            };
        }
        case "sidebar.cursor.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    sidebarCursor: action.cursor
                }
            };
        case "sidebar.focus.set":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sidebarFocus: action.sidebarFocus
                }
            };
        case "instance.replaceList":
            return withDerivedState(selectInstanceAfterListReplace({
                ...state,
                approvalsByInstance: pruneByInstances(state.approvalsByInstance, action.instances),
                instances: [...action.instances],
                lastSeqByInstance: pruneByInstanceNames(state.lastSeqByInstance, action.instances),
                lastStatusChangeAtByInstance: pruneByInstanceNames(state.lastStatusChangeAtByInstance, action.instances),
                logsByInstance: pruneByInstances(state.logsByInstance, action.instances),
                snapshotsByInstance: pruneByInstances(state.snapshotsByInstance, action.instances),
                todoByInstance: pruneByInstances(state.todoByInstance, action.instances),
                toolCallsByInstance: pruneByInstances(state.toolCallsByInstance, action.instances)
            }));
        case "log.append": {
            const current = state.logsByInstance[action.entry.instance] ?? [];
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.entry.instance]: mergeLogEntry(current, action.entry)
                }
            });
        }
        case "log.replace":
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.instance]: dedupeLogs(action.logs)
                }
            });
        case "log.clearBuffer":
            return withDerivedState({
                ...state,
                logsByInstance: {}
            });
        case "overlay.setConfirmDialog":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    confirmDialog: {
                        body: action.body,
                        cancelLabel: action.cancelLabel,
                        confirmIntent: action.confirmIntent,
                        confirmLabel: action.confirmLabel,
                        open: action.open,
                        title: action.title
                    },
                    selectedConfirmButton: "cancel"
                }
            };
        case "search.setOpen":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    search: {
                        ...state.interaction.search,
                        open: action.value
                    }
                }
            };
        case "search.setQuery":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    searchQueries: {
                        ...state.ui.searchQueries,
                        [action.page]: action.query
                    }
                }
            };
        case "toolForm.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    toolForm: {
                        input: action.input,
                        instance: action.instance,
                        open: true,
                        toolName: action.toolName
                    }
                }
            };
        case "toolForm.clear":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    toolForm: undefined
                }
            };
        case "textDetail.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    textDetail: {
                        body: action.body,
                        open: action.open,
                        scrollOffset: action.scrollOffset,
                        title: action.title
                    }
                }
            };
        case "editor.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    editor: action.editor
                }
            };
        case "formDraft.set":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    dirtyForms: {
                        ...state.ui.dirtyForms,
                        [action.key]: action.dirty
                    },
                    formDrafts: {
                        ...state.ui.formDrafts,
                        [action.key]: action.value
                    }
                }
            };
        case "formDraft.clear": {
            const { [action.key]: _removedDraft, ...formDrafts } = state.ui.formDrafts;
            const { [action.key]: _removedDirty, ...dirtyForms } = state.ui.dirtyForms;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    dirtyForms,
                    formDrafts
                }
            };
        }
        case "screen.setStatus":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    screenStatusByPage: {
                        ...state.interaction.screenStatusByPage,
                        [action.page]: action.status
                    }
                }
            };
        case "ui.selectInstance":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedInstance: action.instance
                }
            };
        case "ui.selectPage":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedPage: action.page
                }
            };
        case "ui.toggleExpanded":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    expandedBoxes: {
                        ...state.ui.expandedBoxes,
                        [action.key]: state.ui.expandedBoxes[action.key] !== true
                    }
                }
            };
        case "ui.setScrollOffset":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    scrollOffsets: {
                        ...state.ui.scrollOffsets,
                        [action.key]: action.offset
                    }
                }
            };
        case "control.setRestartRequired":
            return {
                ...state,
                ui: { ...state.ui, controlRestartRequired: action.required }
            };
        case "logs.setFollow":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    logsFollowByInstance: {
                        ...state.ui.logsFollowByInstance,
                        [action.instance]: action.follow
                    }
                }
            };
        case "logs.setPausedAtSeq":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    logsPausedAtSeqByInstance: {
                        ...state.ui.logsPausedAtSeqByInstance,
                        [action.instance]: action.seq
                    }
                }
            };
        case "ui.bumpRedrawNonce":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    redrawNonce: state.interaction.redrawNonce + 1
                }
            };
        case "snapshot.replace":
            return withDerivedState({
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.snapshot.name]: action.snapshot.lastSeq
                },
                snapshotsByInstance: {
                    ...state.snapshotsByInstance,
                    [action.snapshot.name]: action.snapshot
                }
            });
        case "todo.replace":
            return {
                ...state,
                todoByInstance: {
                    ...state.todoByInstance,
                    [action.instance]: action.todo
                }
            };
        case "toolCall.replace":
            return withDerivedState({
                ...state,
                toolCallsByInstance: {
                    ...state.toolCallsByInstance,
                    [action.instance]: [...action.records].sort(compareToolCallRecord)
                }
            });
        case "instance.setLastSeq":
            if ((state.lastSeqByInstance[action.instance] ?? 0) >= action.seq) {
                return state;
            }

            return {
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.instance]: action.seq
                }
            };
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            const nextState = {
                ...state,
                lastSeqByInstance:
                    (state.lastSeqByInstance[action.rawEvent.instance] ?? 0) >= action.rawEvent.seq
                        ? state.lastSeqByInstance
                        : {
                              ...state.lastSeqByInstance,
                              [action.rawEvent.instance]: action.rawEvent.seq
                          },
                rawEvents: rawEvents.slice(Math.max(0, rawEvents.length - maxEvents))
            };
            return withDerivedState(applyEventRecord(nextState, action.rawEvent));
        }
        case "restore.push":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    restoreStack: [
                        ...state.interaction.restoreStack,
                        {
                            focusScope: action.focusScope,
                            mainFocusId: action.mainFocusId,
                            sidebarFocus: action.sidebarFocus
                        }
                    ]
                }
            };
        case "restore.pop":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    restoreStack: state.interaction.restoreStack.slice(0, -1)
                }
            };
    }
}
