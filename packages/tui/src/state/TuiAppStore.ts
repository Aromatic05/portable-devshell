import {
    type ControlError,
    type ControlInstanceReadState,
    type ControlReadModelState,
    type InstanceEvent,
} from "@portable-devshell/shared";

import type { TuiEditorState } from "./TuiInteractionState.js";
import type { TuiOverlay } from "./overlay/TuiOverlay.js";
import type { TuiRoute } from "./route/TuiRoute.js";
import { currentTuiRouteStack } from "./route/TuiRouteState.js";
import type {
    TuiFocusScope,
    TuiPageId,
    TuiSidebarCursor,
    TuiSidebarFocus,
} from "./TuiUiState.js";
import { createInitialTuiAppState } from "./reducer/TuiStoreInitialState.js";
import { tuiAppReducer } from "./reducer/TuiStoreReducer.js";
import {
    toRawEventRecord,
    type TuiAppAction,
    type TuiAppState,
    type TuiCommandRecord,
    type TuiConnectionStatus,
    type TuiControlReadModelPatch,
    type TuiInstanceListEntry,
} from "./reducer/TuiStoreModel.js";

export interface TuiAppStoreOptions {
    initialState?: TuiAppState;
    maxRawEvents?: number;
}

export class TuiAppStore {
    readonly #listeners = new Set<() => void>();
    readonly #maxRawEvents: number;
    #state: TuiAppState;

    constructor(options: TuiAppStoreOptions = {}) {
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
                ? tuiAppReducer(this.#state, {
                      ...action,
                      maxEvents: this.#maxRawEvents,
                  })
                : tuiAppReducer(this.#state, action);

        if (nextState === this.#state) {
            return;
        }

        this.#state = nextState;
        for (const listener of this.#listeners) {
            listener();
        }
    }

    replaceControlReadModel(
        readModel: ControlReadModelState,
        instances: TuiInstanceListEntry[] = this.#state.instances,
    ): void {
        this.dispatch({ instances, readModel, type: "control.readModel.replace" });
    }

    patchControlReadModel(patch: TuiControlReadModelPatch): void {
        const { instanceState, instances, ...global } = patch;
        const current = this.#state.readModel;
        const nextInstanceState = instanceState === undefined
            ? current.instanceState
            : { ...current.instanceState };
        if (instanceState !== undefined) {
            for (const [name, value] of Object.entries(instanceState)) {
                nextInstanceState[name] = {
                    ...emptyInstanceReadState(),
                    ...current.instanceState[name],
                    ...value,
                };
            }
        }
        this.replaceControlReadModel(
            {
                ...current,
                ...global,
                instanceState: nextInstanceState,
            },
            instances ?? this.#state.instances,
        );
    }

    patchControlSnapshot(snapshot: NonNullable<ControlInstanceReadState["snapshot"]>): void {
        this.patchControlReadModel({
            instanceState: {
                [snapshot.name]: {
                    sequence: snapshot.lastSeq,
                    snapshot,
                },
            },
        });
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

    setMainFocusId(mainFocusId?: string): void {
        this.dispatch({
            mainFocusId,
            type: "mainFocus.set",
        });
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

    setPanelError(key: string, error?: ControlError): void {
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

    setLogsFollow(instance: string, follow: boolean): void {
        this.dispatch({ follow, instance, type: "logs.setFollow" });
    }

    setLogsPausedAtSeq(instance: string, seq: number | undefined): void {
        this.dispatch({
            instance,
            ...(seq === undefined ? {} : { seq }),
            type: "logs.setPausedAtSeq",
        });
    }

    setScrollOffset(key: string, offset: number): void {
        this.dispatch({
            key,
            offset,
            type: "ui.setScrollOffset",
        });
    }

    clearLogsBuffer(): void {
        this.dispatch({
            type: "log.clearBuffer",
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

    applyInstanceEvent(event: InstanceEvent): void {
        const lastSeq = this.#state.readModel.instanceState[event.instanceName]?.sequence ?? 0;
        if (event.seq <= lastSeq) return;
        this.dispatch({
            rawEvent: toRawEventRecord(event),
            type: "event.append",
        });
    }

}

function emptyInstanceReadState(): ControlInstanceReadState {
    return {
        approvals: [],
        commentCalls: [],
        contextMessages: [],
        logs: [],
        sequence: 0,
        toolCalls: [],
    };
}
