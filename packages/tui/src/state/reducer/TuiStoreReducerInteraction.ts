import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerInteraction(
    state: TuiAppState,
    action: TuiAppAction,
): TuiAppState | undefined {
    switch (action.type) {
        case "focus.scope.set":
            if (state.interaction.focusScope === action.focusScope) return state;
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    focusScope: action.focusScope,
                },
            };
        case "mainFocus.set":
            if (state.ui.mainFocusId === action.mainFocusId) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    mainFocusId: action.mainFocusId,
                },
            };
        case "messages.scope.set":
            if (state.ui.messageScope === action.scope) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    messageScope: action.scope,
                },
            };
        case "detailLine.select": {
            if (
                state.interaction.selectedDetailLineIds[action.key] ===
                action.lineId
            ) {
                return state;
            }
            const selectedDetailLineIds = {
                ...state.interaction.selectedDetailLineIds,
            };

            if (action.lineId === undefined) {
                delete selectedDetailLineIds[action.key];
            } else {
                selectedDetailLineIds[action.key] = action.lineId;
            }

            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    selectedDetailLineIds,
                },
            };
        }
        case "sidebar.cursor.set":
            if (sameSidebarCursor(state.interaction.sidebarCursor, action.cursor)) {
                return state;
            }
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    sidebarCursor: action.cursor,
                },
            };
        case "sidebar.focus.set":
            if (state.ui.sidebarFocus === action.sidebarFocus) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sidebarFocus: action.sidebarFocus,
                },
            };
        case "sidebar.level.set":
            if (state.ui.sidebarLevel === action.level) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sidebarLevel: action.level,
                },
            };
        case "search.setQuery":
            if ((state.ui.searchQueries[action.page] ?? "") === action.query) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    searchQueries: {
                        ...state.ui.searchQueries,
                        [action.page]: action.query,
                    },
                },
            };
        case "editor.set":
            if (state.interaction.editor === action.editor) return state;
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    editor: action.editor,
                },
            };
        case "formDraft.set":
            if (
                Object.is(state.ui.formDrafts[action.key], action.value) &&
                state.ui.dirtyForms[action.key] === action.dirty
            ) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    dirtyForms: {
                        ...state.ui.dirtyForms,
                        [action.key]: action.dirty,
                    },
                    formDrafts: {
                        ...state.ui.formDrafts,
                        [action.key]: action.value,
                    },
                },
            };
        case "formDraft.clear": {
            if (
                !Object.hasOwn(state.ui.formDrafts, action.key) &&
                !Object.hasOwn(state.ui.dirtyForms, action.key)
            ) {
                return state;
            }
            const { [action.key]: _removedDraft, ...formDrafts } =
                state.ui.formDrafts;
            const { [action.key]: _removedDirty, ...dirtyForms } =
                state.ui.dirtyForms;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    dirtyForms,
                    formDrafts,
                },
            };
        }
        case "screen.setStatus":
            if (
                state.interaction.screenStatusByPage[action.page] ===
                action.status
            ) {
                return state;
            }
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    screenStatusByPage: {
                        ...state.interaction.screenStatusByPage,
                        [action.page]: action.status,
                    },
                },
            };
        case "ui.selectInstance":
            if (state.ui.selectedInstance === action.instance) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedInstance: action.instance,
                },
            };
        case "ui.selectPage":
            if (state.ui.selectedPage === action.page) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedPage: action.page,
                },
            };
        case "ui.toggleExpanded":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    expandedBoxes: {
                        ...state.ui.expandedBoxes,
                        [action.key]:
                            state.ui.expandedBoxes[action.key] !== true,
                    },
                },
            };
        case "ui.setScrollOffset":
            if (state.ui.scrollOffsets[action.key] === action.offset) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    scrollOffsets: {
                        ...state.ui.scrollOffsets,
                        [action.key]: action.offset,
                    },
                },
            };
        case "logs.setFollow":
            if (state.ui.logsFollowByInstance[action.instance] === action.follow) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    logsFollowByInstance: {
                        ...state.ui.logsFollowByInstance,
                        [action.instance]: action.follow,
                    },
                },
            };
        case "logs.setPausedAtSeq":
            if (
                state.ui.logsPausedAtSeqByInstance[action.instance] === action.seq
            ) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    logsPausedAtSeqByInstance: {
                        ...state.ui.logsPausedAtSeqByInstance,
                        [action.instance]: action.seq,
                    },
                },
            };
        case "ui.bumpRedrawNonce":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    redrawNonce: state.interaction.redrawNonce + 1,
                },
            };
    }
}

function sameSidebarCursor(
    left: TuiAppState["interaction"]["sidebarCursor"],
    right: TuiAppState["interaction"]["sidebarCursor"],
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return left.kind === right.kind && left.id === right.id;
}
