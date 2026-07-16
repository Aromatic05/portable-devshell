import type { InstanceCreateDraft, InstanceCreateSchema, InstanceCreateSummary, JsonValue } from "@portable-devshell/shared";

import { createDefaultInstanceDraft } from "../../modules/instance/InstanceCreateDraft.js";
import { editableProviderChoices } from "../../platform/TuiProviderAvailability.js";
import type { TuiAppStore } from "../../store/TuiAppStore.js";
import { asRecord, cloneRecord, editorDraft, normalizeDraftForSave, readPath, setPath } from "../../store/page/EditorSupport.js";
import { selectMainScreenModel } from "../../store/TuiSelectors.js";
import type { TuiEditorState, TuiUiIntent } from "../TuiInteractionTypes.js";

interface CommandEditorOptions {
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    onApplyConfig(): Promise<JsonValue>;
    onCreateInstance(draft: InstanceCreateDraft): Promise<string | undefined>;
    onGetInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    onInstanceAction(action: "refresh" | "restart" | "start" | "stop", instance: string): Promise<void>;
    onInstanceConfigUpdate(instanceName: string, patch: Record<string, JsonValue>): Promise<void>;
    onMcpConfigUpdate(mcp: Record<string, JsonValue>): Promise<void>;
    onValidateConfigDraft(draft: Record<string, JsonValue>): Promise<void>;
    onValidateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    store: TuiAppStore;
    syncMainFocus(): void;
}

export class CommandDispatcherEditor {
    readonly #options: CommandEditorOptions;
    readonly #store: TuiAppStore;

    constructor(options: CommandEditorOptions) {
        this.#options = options;
        this.#store = options.store;
    }

    async openCreateWizard(): Promise<boolean> {
        try {
            const schema = await this.#options.onGetInstanceCreateSchema();
            const key = "create";
            if (this.#store.getState().ui.formDrafts[key] === undefined) {
                this.#store.setFormDraft(key, {
                    enabled: schema.defaultEnabled,
                    mcp: {
                        enabled: schema.defaultMcpEnabled,
                        tools: {
                            capabilities: [...schema.defaultMcpCapabilities],
                            groups: [...schema.defaultMcpGroups]
                        }
                    },
                    name: "",
                    provider: schema.defaultProvider,
                    security: { mode: schema.defaultSecurityMode },
                    workspace: ""
                }, false);
            }
            this.#store.setMainFocusId("create-wizard");
            if (this.#store.getState().ui.expandedBoxes["instances:all:create-wizard"] !== true) {
                this.#store.toggleExpanded("instances:all:create-wizard");
            }
            await this.#options.dispatch({ key, kind: "create", schema, type: "editor.open" });
            this.#selectFirstEditorItem();
            return true;
        } catch (error) {
            this.#store.setScreenStatus("instances", `Create setup failed: ${readErrorMessage(error)}`);
            return false;
        }
    }

    openPageEditor(kind: "config" | "connector", boxId: string): boolean {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance;
        if (instance === undefined) {
            return false;
        }
        const key = kind === "config" ? `config:${instance}` : `connector:${instance}`;
        if (state.ui.formDrafts[key] === undefined) {
            const source = kind === "config" ? this.#instanceDraft(instance) : this.#mcpDraft();
            this.#store.setFormDraft(key, source, false);
        }
        const box = selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        if (box !== undefined && !box.expanded) {
            this.#store.toggleExpanded(box.expandedKey);
        }
        this.#store.setMainFocusId(boxId);
        this.#store.setEditor({ editing: false, key, kind });
        this.#store.setFocusScope("form");
        this.#selectFirstEditorItem();
        return true;
    }

    async activate(): Promise<boolean> {
        const state = this.#store.getState();
        const editor = state.interaction.editor;
        const boxId = state.ui.mainFocusId;
        if (editor === undefined || boxId === undefined) {
            return false;
        }
        const lineId = state.interaction.selectedDetailLineIds[this.#expandedKey(boxId)];
        const action = lineId?.slice(`${boxId}:`.length);
        if (action?.startsWith("button:")) {
            switch (action.slice("button:".length)) {
                case "save":
                    return await this.save(false);
                case "save-restart":
                    return await this.save(true);
                case "reload":
                    return await this.reload(false);
                case "cancel":
                    return await this.discard();
                case "validate":
                    return await this.validate();
                case "create":
                    return await this.#createFromWizard();
                case "back":
                    return this.changeStep("previous");
                case "next":
                    return this.changeStep("next");
                case "delete": {
                    const instance = state.ui.selectedInstance;
                    if (instance === undefined) {
                        return false;
                    }
                    return await this.#options.dispatch({
                        body: `Delete ${instance}?`,
                        confirmIntent: { instance, type: "instance.delete" },
                        confirmLabel: "Delete",
                        title: "Confirm Delete",
                        type: "overlay.openConfirm"
                    });
                }
                default:
                    return false;
            }
        }
        if (action?.startsWith("field:")) {
            const field = action.slice("field:".length);
            const target = this.#draftTarget(field);
            const draft = this.#editorDraft(target.key, target.fallback);
            const current = readPath(draft, target.path);
            if (this.#choiceValues(editor, field) !== undefined) {
                this.#store.setEditor({ ...editor, editing: false, error: undefined });
                return true;
            }
            if (typeof current === "boolean") {
                this.#store.setFormDraft(target.key, setPath(draft, target.path, !current));
                return true;
            }
            this.#store.setEditor({ ...editor, cursor: inputText(current).length, editing: true, error: undefined });
            return true;
        }
        return false;
    }

    editFocusedField(input: string, backspace: boolean): boolean {
        const editor = this.#store.getState().interaction.editor;
        const boxId = this.#store.getState().ui.mainFocusId;
        if (editor === undefined || boxId === undefined) {
            return false;
        }
        const lineId = this.#store.getState().interaction.selectedDetailLineIds[this.#expandedKey(boxId)];
        const action = lineId?.slice(`${boxId}:`.length);
        if (!editor.editing || action?.startsWith("field:") !== true) {
            return false;
        }
        const target = this.#draftTarget(action.slice("field:".length));
        const draft = this.#editorDraft(target.key, target.fallback);
        const current = readPath(draft, target.path);
        const text = inputText(current);
        const cursor = Math.min(Math.max(editor.cursor ?? text.length, 0), text.length);
        const next = backspace ? `${text.slice(0, Math.max(0, cursor - 1))}${text.slice(cursor)}` : `${text.slice(0, cursor)}${input}${text.slice(cursor)}`;
        this.#store.setFormDraft(target.key, setPath(draft, target.path, next));
        this.#store.setEditor({ ...editor, cursor: backspace ? Math.max(0, cursor - 1) : cursor + input.length });
        return true;
    }

    moveCursor(direction: "left" | "right"): boolean {
        const editor = this.#store.getState().interaction.editor;
        const boxId = this.#store.getState().ui.mainFocusId;
        if (editor === undefined || boxId === undefined) {
            return false;
        }
        const lineId = this.#store.getState().interaction.selectedDetailLineIds[this.#expandedKey(boxId)];
        const action = lineId?.slice(`${boxId}:`.length);
        if (action?.startsWith("field:") !== true) {
            return false;
        }
        const field = action.slice("field:".length);
        const target = this.#draftTarget(field);
        const choices = this.#choiceValues(editor, field);
        if (choices !== undefined) {
            const draft = this.#editorDraft(target.key, target.fallback);
            const current = readPath(draft, target.path);
            const currentIndex = choices.findIndex((choice) => choice === current);
            const nextIndex = direction === "left"
                ? (currentIndex - 1 + choices.length) % choices.length
                : (currentIndex + 1) % choices.length;
            this.#store.setFormDraft(target.key, setPath(draft, target.path, choices[currentIndex === -1 ? 0 : nextIndex]!));
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            return true;
        }
        if (!editor.editing) {
            return false;
        }
        const text = inputText(readPath(this.#editorDraft(target.key, target.fallback), target.path));
        const cursor = Math.min(Math.max(editor.cursor ?? text.length, 0), text.length);
        this.#store.setEditor({ ...editor, cursor: direction === "left" ? Math.max(0, cursor - 1) : Math.min(text.length, cursor + 1) });
        return true;
    }

    #choiceValues(editor: TuiEditorState, field: string): readonly JsonValue[] | undefined {
        if (editor.kind === "create") {
            if (field === "provider") {
                return editor.schema?.providers;
            }
            if (field === "container.mode") {
                return editor.schema?.container.modes;
            }
            return undefined;
        }
        if (editor.kind !== "config") {
            return undefined;
        }
        switch (field) {
            case "provider":
                return editableProviderChoices();
            case "enabled":
            case "mcp.enabled":
                return [true, false];
            case "container.mode":
                return ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"];
            case "security.mode":
                return ["disabled", "workspace"];
            case "approvalPolicy.mode":
                return ["disabled", "allow", "ask", "deny"];
            default:
                return undefined;
        }
    }

    async validate(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor === undefined) {
            return false;
        }
        try {
            if (editor.kind === "create") {
                const draft = normalizeDraftForSave(this.#editorDraft(editor.key, createDefaultInstanceDraft()));
                const summary = await this.#options.onValidateInstanceCreateDraft(draft as unknown as InstanceCreateDraft);
                this.#store.setFormDraft(editor.key, draft);
                this.#store.setEditor({ ...editor, editing: false, error: undefined, summary: summary as unknown as JsonValue });
                return true;
            }
            const draft = this.#fullConfigDraft(editor.kind === "connector");
            this.#assertPublicAuth(draft);
            await this.#options.onValidateConfigDraft(draft);
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, editing: false, error: readErrorMessage(error) });
            return false;
        }
    }

    async save(restartInstance: boolean): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        const instance = this.#store.getState().ui.selectedInstance;
        if (editor === undefined) {
            return false;
        }
        if (editor.kind === "create") {
            return await this.#createFromWizard();
        }
        if (instance === undefined) {
            return false;
        }
        if (!(await this.validate())) {
            return false;
        }
        try {
            const state = this.#store.getState();
            const wasRunning = state.snapshotsByInstance[instance]?.daemonState === "running" || state.snapshotsByInstance[instance]?.ready === true;
            if (restartInstance && wasRunning) {
                await this.#options.onInstanceAction("stop", instance);
            }
            const instanceKey = `config:${instance}`;
            const globalKey = `connector:${instance}`;
            const instanceDraft = normalizeDraftForSave(this.#editorDraft(instanceKey, this.#instanceDraft(instance)));
            const globalDraft = normalizeDraftForSave(this.#editorDraft(globalKey, this.#mcpDraft()));
            const instanceDirty = state.ui.dirtyForms[instanceKey] === true;
            const globalDirty = editor.kind === "connector" && state.ui.dirtyForms[globalKey] === true;
            if (instanceDirty) {
                await this.#options.onInstanceConfigUpdate(instance, toInstancePatch(instanceDraft));
            }
            if (globalDirty) {
                await this.#options.onMcpConfigUpdate(globalDraft);
            }
            const applyResult = instanceDirty || globalDirty ? await this.#options.onApplyConfig() : {};
            if (asRecord(applyResult)?.restartControlRequired === true) {
                this.#store.setControlRestartRequired(true);
            }
            if (restartInstance && wasRunning) {
                await this.#options.onInstanceAction("start", instance);
            }
            this.#store.setFormDraft(`config:${instance}`, instanceDraft, false);
            if (editor.kind === "connector") {
                this.#store.setFormDraft(globalKey, globalDraft, false);
            }
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                describeApplyResult(applyResult, restartInstance && wasRunning)
            );
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, editing: false, error: readErrorMessage(error) });
            return false;
        }
    }

    async reload(confirmed: boolean): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor === undefined) {
            return false;
        }
        const dirty = this.#editorDraftKeys(editor).some((key) => this.#store.getState().ui.dirtyForms[key] === true);
        if (dirty && !confirmed) {
            return await this.#options.dispatch({
                body: "Discard local changes and reload from control?",
                confirmIntent: { type: "editor.reloadConfirmed" },
                confirmLabel: "Reload",
                title: "Reload Configuration",
                type: "overlay.openConfirm"
            });
        }
        for (const key of this.#editorDraftKeys(editor)) {
            this.#store.clearFormDraft(key);
        }
        this.#store.setEditor(undefined);
        this.#store.setFocusScope("mainBoxes");
        await this.#options.dispatch({ type: "page.reload" });
        return true;
    }

    async #createFromWizard(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor?.kind !== "create") {
            return false;
        }
        if (!(await this.validate())) {
            return false;
        }
        try {
            const status = await this.#options.onCreateInstance(
                normalizeDraftForSave(this.#editorDraft(editor.key, createDefaultInstanceDraft())) as unknown as InstanceCreateDraft
            );
            this.#store.clearFormDraft(editor.key);
            this.close();
            this.#store.setScreenStatus("instances", status ?? "Created through control RPC.");
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, error: readErrorMessage(error) });
            return false;
        }
    }

    async discard(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor === undefined) {
            return false;
        }
        if (this.#editorDraftKeys(editor).some((key) => this.#store.getState().ui.dirtyForms[key] === true)) {
            return await this.#options.dispatch({
                body: "Discard unsaved changes?",
                confirmIntent: { type: "editor.close" },
                confirmLabel: "Discard",
                title: "Discard Unsaved Changes",
                type: "overlay.openConfirm"
            });
        }
        this.close();
        return true;
    }

    close(): void {
        const editor = this.#store.getState().interaction.editor;
        if (editor !== undefined) {
            for (const key of this.#editorDraftKeys(editor)) {
                this.#store.clearFormDraft(key);
            }
        }
        this.#store.setEditor(undefined);
        this.#store.setFocusScope("mainBoxes");
        this.#options.syncMainFocus();
    }

    changeStep(direction: "next" | "previous"): boolean {
        const editor = this.#store.getState().interaction.editor;
        if (editor?.kind !== "create") {
            return false;
        }
        const step = Math.min(5, Math.max(1, (editor.step ?? 1) + (direction === "next" ? 1 : -1)));
        this.#store.setEditor({ ...editor, editing: false, step });
        this.#selectFirstEditorItem();
        return true;
    }

    #selectFirstEditorItem(): void {
        const boxId = this.#store.getState().ui.mainFocusId;
        const box = boxId === undefined ? undefined : selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        const line = box?.expandedLines.find((candidate) => candidate.id?.includes(":field:") === true || candidate.id?.includes(":button:") === true);
        if (box !== undefined && line?.id !== undefined) {
            this.#store.setSelectedDetailLine(box.expandedKey, line.id);
        }
    }

    #draftTarget(field: string): { fallback: Record<string, JsonValue>; key: string; path: string } {
        const editor = this.#store.getState().interaction.editor!;
        const instance = this.#store.getState().ui.selectedInstance;
        if (editor.kind === "create") {
            return { fallback: createDefaultInstanceDraft(), key: editor.key, path: field };
        }
        if (editor.kind === "connector" && field.startsWith("instance.")) {
            const name = instance!;
            return { fallback: this.#instanceDraft(name), key: `config:${name}`, path: field.slice("instance.".length) };
        }
        return {
            fallback: editor.kind === "connector" ? this.#mcpDraft() : this.#instanceDraft(instance!),
            key: editor.key,
            path: field
        };
    }

    #editorDraft(key: string, fallback: Record<string, JsonValue>): Record<string, JsonValue> {
        return editorDraft(this.#store.getState(), key, fallback);
    }

    #editorDraftKeys(editor: TuiEditorState): string[] {
        if (editor.kind !== "connector") {
            return [editor.key];
        }

        const instance = this.#store.getState().ui.selectedInstance;
        return instance === undefined ? [editor.key] : [editor.key, `config:${instance}`];
    }

    #instanceDraft(instanceName: string): Record<string, JsonValue> {
        const configView = this.#store.getState().configView;
        const entries = configView?.instances;
        const entry = Array.isArray(entries)
            ? entries.find((value) => asRecord(value)?.name === instanceName)
            : undefined;
        return toInstanceDraft(
            cloneRecord(asRecord(entry) ?? { enabled: true, mcp: { enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact", "tmux", "todo"] } }, name: instanceName, provider: "local", security: { mode: "disabled" }, workspace: "" })
        );
    }

    #mcpDraft(): Record<string, JsonValue> {
        return cloneRecord(asRecord(this.#store.getState().configView?.mcp) ?? { auth: { mode: "none" }, enabled: false, listenHost: "127.0.0.1", listenPort: 0 });
    }

    #fullConfigDraft(includeMcp: boolean): Record<string, JsonValue> {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance!;
        const config = cloneRecord(state.configView ?? { control: {}, instances: [], mcp: this.#mcpDraft() });
        const rawInstances = config.instances;
        const instances = Array.isArray(rawInstances)
            ? rawInstances.map((entry) => {
                  const record = asRecord(entry);
                  return record?.name === instance
                      ? normalizeDraftForSave(this.#editorDraft(`config:${instance}`, this.#instanceDraft(instance)))
                      : record === undefined
                        ? entry
                        : toInstanceDraft(cloneRecord(record));
              })
            : [];
        config.instances = instances;
        if (includeMcp) {
            config.mcp = normalizeDraftForSave(this.#editorDraft(`connector:${instance}`, this.#mcpDraft()));
        }
        return config;
    }

    #assertPublicAuth(config: Record<string, JsonValue>): void {
        const mcp = asRecord(config.mcp);
        const auth = asRecord(mcp?.auth);
        const baseUrl = mcp?.publicBaseUrl;
        const publicHost = mcp?.listenHost === "0.0.0.0";
        const publicUrl = typeof baseUrl === "string" && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(baseUrl);
        if ((publicHost || publicUrl) && auth?.mode === "none") {
            throw new Error("auth.mode=none cannot expose a non-local endpoint.");
        }
    }


    #expandedKey(boxId: string): string {
        const state = this.#store.getState();
        return selectMainScreenModel(state).boxes.find((box) => box.id === boxId)?.expandedKey ?? `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
    }
}

function inputText(value: JsonValue | undefined): string {
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function toInstanceDraft(value: Record<string, JsonValue>): Record<string, JsonValue> {
    const draft = cloneRecord(value);
    const security = asRecord(draft.security);
    if (security !== undefined) {
        const { effectiveMode: _effectiveMode, ...persistedSecurity } = security;
        draft.security = persistedSecurity;
    }
    return draft;
}

function toInstancePatch(value: Record<string, JsonValue>): Record<string, JsonValue> {
    const draft = toInstanceDraft(value);
    const { name: _name, ...patch } = draft;
    return patch;
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function describeApplyResult(result: JsonValue, restarted: boolean): string {
    const record = asRecord(result);
    const controlRestart = record?.restartControlRequired === true;
    if (restarted) {
        return controlRestart ? "Saved and instance restarted. Control restart is still required for MCP changes." : "Saved and instance restarted.";
    }
    if (controlRestart) {
        return "Saved. Control restart is required for MCP changes.";
    }
    return record?.reloadRequired === true ? "Saved and hot-applied to future instance operations." : "Saved.";
}
