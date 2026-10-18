import { type RemoteError } from "@portable-devshell/shared";

import type { TuiEditorState } from "../Interaction.js";
import type { TuiOverlay } from "../Overlay.js";
import type { TuiRoute } from "../route/Model.js";
import { currentTuiRouteStack } from "../route/State.js";
import type {
    TuiFocusScope,
    TuiMessageScope,
    TuiPageId,
    TuiSidebarCursor,
    TuiSidebarFocus,
    TuiUiState,
} from "../Ui.js";
import { createInitialTuiAppState } from "./Initial.js";
import { tuiAppReducer } from "./reducer/Reducer.js";
import type { TuiDomainReader } from "../../app/control/Reader.js";
import {
    type TuiAppAction,
    type TuiAppState,
    type TuiCommandRecord,
    type TuiConnectionStatus,
} from "./Model.js";

export interface TuiAppStoreOptions {
    domains?: TuiDomainReader;
    initialState?: TuiAppState;
    maxRawEvents?: number;
}

export class TuiAppStore {
    readonly #domains?: TuiDomainReader;
    readonly #listeners = new Set<() => void>();
    readonly #maxRawEvents: number;
    #state: TuiAppState;

    constructor(options: TuiAppStoreOptions = {}) {
        this.#domains = options.domains;
        this.#maxRawEvents = options.maxRawEvents ?? 100;
        this.#state = options.initialState ?? createInitialTuiAppState();
    }

    getState(): TuiAppState {
        return this.#state;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    dispatch(action: TuiAppAction): void {
        const nextState =
            action.type === "event.append"
                ? tuiAppReducer(
                      this.#state,
                      {
                          ...action,
                          maxEvents: this.#maxRawEvents,
                      },
                      this.#domains,
                  )
                : tuiAppReducer(this.#state, action, this.#domains);

        if (nextState === this.#state) {
            return;
        }

        this.#state = nextState;
        for (const listener of this.#listeners) {
            listener();
        }
    }

    setControlRestartRequired(required: boolean): void {
        this.dispatch({ required, type: "control.setRestartRequired" });
    }

    setConnectionState(
        status: TuiConnectionStatus,
        error?: { code?: string; message?: string },
    ): void {
        this.dispatch({
            errorCode: error?.code,
            errorMessage: error?.message,
            status,
            type: "control.setConnectionState",
        });
    }

    setFocusScope(focusScope: TuiFocusScope): void {
        this.dispatch({
            focusScope,
            type: "focus.scope.set",
        });
    }

    setSidebarFocus(sidebarFocus: TuiSidebarFocus): void {
        this.dispatch({
            sidebarFocus,
            type: "sidebar.focus.set",
        });
    }

    setSidebarLevel(level: TuiUiState["sidebarLevel"]): void {
        this.dispatch({ level, type: "sidebar.level.set" });
    }

    setMainFocusId(mainFocusId?: string): void {
        this.dispatch({
            mainFocusId,
            type: "mainFocus.set",
        });
    }

    setMessageScope(scope: TuiMessageScope): void {
        this.dispatch({ scope, type: "messages.scope.set" });
    }

    toggleMessageProject(workspaceKey: string): void {
        this.dispatch({ type: "messages.project.toggle", workspaceKey });
    }

    setSelectedPage(page: TuiPageId): void {
        this.dispatch({
            page,
            type: "ui.selectPage",
        });
    }

    setSelectedInstance(instance?: string): void {
        this.dispatch({
            instance,
            type: "ui.selectInstance",
        });
    }

    pushOverlay(overlay: TuiOverlay): void {
        this.dispatch({ overlay, type: "overlay.push" });
    }

    replaceTopOverlay(overlay: TuiOverlay): void {
        this.dispatch({ overlay, type: "overlay.replaceTop" });
    }

    popOverlay(): boolean {
        if (this.#state.interaction.overlays.length === 0) return false;
        this.dispatch({ type: "overlay.pop" });
        return true;
    }

    pushRoute(route: TuiRoute): void {
        this.dispatch({ route, type: "route.push" });
    }

    popRoute(): boolean {
        if (currentTuiRouteStack(this.#state).length <= 1) {
            return false;
        }
        this.dispatch({ type: "route.pop" });
        return true;
    }

    replaceRoute(route: TuiRoute): void {
        this.dispatch({ route, type: "route.replace" });
    }

    resetRoute(): void {
        this.dispatch({ type: "route.reset" });
    }

    setSelectedDetailLine(key: string, lineId?: string): void {
        this.dispatch({
            key,
            lineId,
            type: "detailLine.select",
        });
    }

    setSidebarCursor(cursor?: TuiSidebarCursor): void {
        this.dispatch({
            cursor,
            type: "sidebar.cursor.set",
        });
    }

    setSearchQuery(page: TuiPageId, query: string): void {
        this.dispatch({
            page,
            query,
            type: "search.setQuery",
        });
    }

    setScreenStatus(page: TuiPageId, status?: string): void {
        this.dispatch({
            page,
            status,
            type: "screen.setStatus",
        });
    }

    setPanelError(key: string, error?: RemoteError): void {
        this.dispatch({
            error,
            key,
            type: "panelError.set",
        });
    }

    setEditor(editor?: TuiEditorState): void {
        this.dispatch({ editor, type: "editor.set" });
    }

    setFormDraft(key: string, value: unknown, dirty = true): void {
        this.dispatch({ dirty, key, type: "formDraft.set", value });
    }

    clearFormDraft(key: string): void {
        this.dispatch({ key, type: "formDraft.clear" });
    }

    toggleExpanded(key: string): void {
        this.dispatch({
            key,
            type: "ui.toggleExpanded",
        });
    }

    setScrollOffset(key: string, offset: number): void {
        this.dispatch({
            key,
            offset,
            type: "ui.setScrollOffset",
        });
    }

    bumpRedrawNonce(): void {
        this.dispatch({
            type: "ui.bumpRedrawNonce",
        });
    }

    upsertCommand(command: TuiCommandRecord): void {
        this.dispatch({
            command,
            type: "command.upsert",
        });
    }

    appendRelayOutput(commandId: string, chunk: string): void {
        this.dispatch({
            chunk,
            commandId,
            type: "relay.appendOutput",
        });
    }

    setRelayMetadata(
        commandId: string,
        input: { provider?: string; requestId?: string },
    ): void {
        this.dispatch({
            commandId,
            ...input,
            type: "relay.setMetadata",
        });
    }
}
