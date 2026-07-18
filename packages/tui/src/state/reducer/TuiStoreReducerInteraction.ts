import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerInteraction(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
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
                        image: action.image,
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
