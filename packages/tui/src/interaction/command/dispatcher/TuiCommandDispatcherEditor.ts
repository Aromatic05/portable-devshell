import { defaultMcpToolGroups, MASKED_CONFIG_TOKEN } from "@portable-devshell/shared";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue
} from "@portable-devshell/shared";

import { createDefaultInstanceDraft } from "../../../state/editor/TuiEditorInstanceCreateDraft.js";
import { editableProviderChoices } from "../../../state/editor/TuiEditorProviderChoices.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import { asRecord, cloneRecord, deletePath, editorDraft, readPath, setPath } from "../../../state/editor/TuiEditorDraft.js";
import { coerceTuiEditorRecord, parseTuiConfigDraft, parseTuiInstanceDraft, parseTuiInstancePatch, parseTuiMcpPatch, parseTuiWebPatch, toTuiInstanceEditorRecord, tuiEditorRecordsEqual } from "../../../state/editor/TuiEditorConfigAdapter.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import type { TuiEditorState, TuiUiIntent } from "../../../state/TuiInteractionState.js";

interface CommandEditorOptions {
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    onCreateInstance(draft: InstanceCreateDraft): Promise<string | undefined>;
    onGetInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    onInstanceAction(action: "refresh" | "restart" | "start" | "stop", instance: string): Promise<void>;
    onConfigUpdate(request: ConfigBatchUpdateRequest): Promise<JsonValue>;
    onValidateConfigDraft(draft: ConfigDraft): Promise<void>;
    onValidateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
    syncMainFocus(): void;
}

export class TuiCommandDispatcherEditor {
    readonly #options: CommandEditorOptions;
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: CommandEditorOptions) {
        this.#options = options;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    async openCreateWizard(): Promise<boolean> {
        try {
            const schema = await this.#options.onGetInstanceCreateSchema();
            const key = "create";
            if (this.#store.getState().ui.formDrafts[key] === undefined) {
                this.#store.setFormDraft(key, {
                    approvalPolicy: { mode: "disabled" },
                    enabled: schema.defaultEnabled,
                    mcp: {
                        auth: "none",
                        enabled: schema.defaultMcpEnabled,
                        tools: {
                            capabilities: [...schema.defaultMcpCapabilities],
                            groups: [...schema.defaultMcpGroups]
                        }
                    },
                    name: "",
                    provider: schema.defaultProvider,
                    security: { mode: schema.defaultSecurityMode }
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
        const key = kind === "config" ? `config:${instance}` : "connector";
        if (state.ui.formDrafts[key] === undefined) {
            const source = kind === "config" ? this.#instanceDraft(instance) : this.#mcpDraft();
            this.#store.setFormDraft(key, source, false);
        }
        if (kind === "connector" && state.ui.formDrafts["web"] === undefined) {
            this.#store.setFormDraft("web", this.#webDraft(), false);
        }
        const box = this.#projection.selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        if (box !== undefined && !box.expanded) {
            this.#store.toggleExpanded(box.expandedKey);
        }
        const actionBoxId = kind === "config" ? "configuration-actions" : "connector-actions";
        const actionBox = this.#projection
            .selectMainScreenModel(this.#store.getState())
            .boxes.find((candidate) => candidate.id === actionBoxId);
        if (actionBox !== undefined && !actionBox.expanded) {
            this.#store.toggleExpanded(actionBox.expandedKey);
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
                this.#store.setEditor({ ...editor, editing: true, error: undefined });
                return true;
            }
            if (typeof current === "boolean") {
                this.#setEditorDraft(target, setPath(draft, target.path, !current));
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
        this.#setEditorDraft(target, setPath(draft, target.path, next));
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
            const choice = choices[currentIndex === -1 ? 0 : nextIndex]!;
            const nextDraft = editor.kind === "create"
                ? applyCreateChoice(draft, field, choice, editor.schema)
                : editor.kind === "config" && (field === "provider" || field === "container.mode")
                    ? applyCreateChoice(draft, field, choice, undefined)
                    : editor.kind === "connector" && (field === "web.auth" || field === "mcp.auth")
                        ? applyAuthModeChoice(draft, target.path, choice)
                        : setPath(draft, target.path, choice);
            this.#setEditorDraft(target, nextDraft);
            this.#store.setEditor({ ...editor, editing: true, error: undefined });
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
            if (field === "enabled" || field === "mcp.enabled") {
                return [true, false];
            }
            if (field === "container.mode") {
                return editor.schema?.container.modes;
            }
            if (field === "container.preset") {
                return editor.schema?.container.presets.map((entry) => entry.preset);
            }
            if (field === "mcp.auth") {
                return ["none", "token", "oauth2"];
            }
            if (field === "security.mode") {
                return ["disabled", "workspace"];
            }
            if (field === "approvalPolicy.mode") {
                return ["disabled", "allow", "ask", "deny"];
            }
            return undefined;
        }
        if (editor.kind === "connector") {
            if (field === "web.auth" || field === "mcp.auth") {
                return ["none", "token", "oauth2"];
            }
            if (field === "instance.mcp.enabled" || field === "web.enabled") {
                return [true, false];
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
                const draft = parseTuiInstanceDraft(this.#editorDraft(editor.key, createDefaultInstanceDraft()));
                const summary = await this.#options.onValidateInstanceCreateDraft(draft);
                this.#store.setFormDraft(editor.key, draft);
                this.#store.setEditor({ ...editor, editing: false, error: undefined, summary });
                return true;
            }
            const draft = this.#fullConfigDraft(editor.kind === "connector");
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
        const state = this.#store.getState();
        const wasRunning = state.readModel.instanceState[instance]?.snapshot?.daemonState === "running" || state.readModel.instanceState[instance]?.snapshot?.ready === true;
        let stoppedForRestart = false;
        try {
            if (restartInstance && wasRunning) {
                await this.#options.onInstanceAction("stop", instance);
                stoppedForRestart = true;
            }
            const instanceKey = `config:${instance}`;
            const globalKey = "connector";
            const webKey = "web";
            const instanceDraft = coerceTuiEditorRecord(this.#editorDraft(instanceKey, this.#instanceDraft(instance)));
            const globalDraft = coerceTuiEditorRecord(this.#editorDraft(globalKey, this.#mcpDraft()));
            const webDraft = coerceTuiEditorRecord(this.#editorDraft(webKey, this.#webDraft()));
            const instanceDirty = state.ui.dirtyForms[instanceKey] === true;
            const globalDirty = editor.kind === "connector" && state.ui.dirtyForms[globalKey] === true;
            const webDirty = editor.kind === "connector" && state.ui.dirtyForms[webKey] === true;
            const request: ConfigBatchUpdateRequest = {
                ...(instanceDirty
                    ? { instance: { instanceName: instance, patch: parseTuiInstancePatch(instanceDraft) } }
                    : {}),
                ...(globalDirty ? { mcp: parseTuiMcpPatch(globalDraft) } : {}),
                ...(webDirty ? { web: parseTuiWebPatch(webDraft) } : {})
            };
            const applyResult = instanceDirty || globalDirty || webDirty
                ? await this.#options.onConfigUpdate(request)
                : {};
            if (asRecord(applyResult)?.restartControlRequired === true) {
                this.#store.setControlRestartRequired(true);
            }
            if (stoppedForRestart) {
                await this.#options.onInstanceAction("start", instance);
                stoppedForRestart = false;
            }
            this.#store.setFormDraft(`config:${instance}`, instanceDraft, false);
            if (editor.kind === "connector") {
                this.#store.setFormDraft(globalKey, globalDraft, false);
                this.#store.setFormDraft(webKey, webDraft, false);
            }
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                describeApplyResult(applyResult, restartInstance && wasRunning)
            );
            return true;
        } catch (error) {
            let reported = error;
            if (stoppedForRestart) {
                try {
                    await this.#options.onInstanceAction("start", instance);
                } catch (restoreError) {
                    reported = new AggregateError([error, restoreError], "Save failed and the previous instance state could not be restored.");
                }
            }
            this.#store.setEditor({ ...editor, editing: false, error: readErrorMessage(reported) });
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
                parseTuiInstanceDraft(this.#editorDraft(editor.key, createDefaultInstanceDraft()))
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
        const step = Math.min(6, Math.max(1, (editor.step ?? 1) + (direction === "next" ? 1 : -1)));
        this.#store.setEditor({ ...editor, editing: false, step });
        this.#selectFirstEditorItem();
        return true;
    }

    #selectFirstEditorItem(): void {
        const boxId = this.#store.getState().ui.mainFocusId;
        const box = boxId === undefined ? undefined : this.#projection.selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
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
        if (editor.kind === "connector" && field.startsWith("web.")) {
            return { fallback: this.#webDraft(), key: "web", path: field.slice("web.".length) };
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

    #setEditorDraft(
        target: { fallback: Record<string, JsonValue>; key: string },
        value: Record<string, JsonValue>,
    ): void {
        const editor = this.#store.getState().interaction.editor;
        const dirty = editor?.kind === "create"
            ? true
            : !tuiEditorRecordsEqual(
                  target.fallback,
                  value,
                  target.key.startsWith("config:"),
              );
        this.#store.setFormDraft(target.key, value, dirty);
    }

    #editorDraftKeys(editor: TuiEditorState): string[] {
        if (editor.kind !== "connector") {
            return [editor.key];
        }

        const instance = this.#store.getState().ui.selectedInstance;
        return instance === undefined ? [editor.key] : [editor.key, `config:${instance}`, "web"];
    }

    #instanceDraft(instanceName: string): Record<string, JsonValue> {
        const configView = this.#store.getState().readModel.configView;
        const entries = configView?.instances;
        const entry = Array.isArray(entries)
            ? entries.find((value) => asRecord(value)?.name === instanceName)
            : undefined;
        return toTuiInstanceEditorRecord(
            cloneRecord(asRecord(entry) ?? { enabled: true, mcp: { auth: "none", enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: [...defaultMcpToolGroups] } }, name: instanceName, provider: "local", security: { mode: "disabled" } })
        );
    }

    #mcpDraft(): Record<string, JsonValue> {
        return cloneRecord(asRecord(this.#store.getState().readModel.configView?.mcp) ?? { enabled: false, listenHost: "127.0.0.1", listenPort: 0 });
    }

    #webDraft(): Record<string, JsonValue> {
        const web = asRecord(this.#store.getState().readModel.configView?.web);
        if (web === undefined) {
            return { auth: "none", enabled: false, listenHost: "127.0.0.1", listenPort: 0 };
        }
        const draft = cloneRecord(web);
        if (draft.auth === "token" && typeof draft.token === "string") {
            draft.token = MASKED_CONFIG_TOKEN;
        }
        return draft;
    }

    #fullConfigDraft(includeGlobal: boolean): ConfigDraft {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance!;
        const config = cloneRecord(state.readModel.configView ?? { control: {}, instances: [], mcp: this.#mcpDraft() });
        const rawInstances = config.instances;
        const instances = Array.isArray(rawInstances)
            ? rawInstances.map((entry) => {
                  const record = asRecord(entry);
                  return record?.name === instance
                      ? toTuiInstanceEditorRecord(
                            coerceTuiEditorRecord(
                                this.#editorDraft(
                                    `config:${instance}`,
                                    this.#instanceDraft(instance),
                                ),
                            ),
                        )
                      : record === undefined
                        ? entry
                        : toTuiInstanceEditorRecord(cloneRecord(record));
              })
            : [];
        config.instances = instances;
        if (includeGlobal) {
            config.mcp = coerceTuiEditorRecord(this.#editorDraft("connector", this.#mcpDraft()));
            config.web = coerceTuiEditorRecord(this.#editorDraft("web", this.#webDraft()));
        }
        return parseTuiConfigDraft(config);
    }

    #expandedKey(boxId: string): string {
        const state = this.#store.getState();
        return this.#projection.selectMainScreenModel(state).boxes.find((box) => box.id === boxId)?.expandedKey ?? `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
    }
}

function inputText(value: JsonValue | undefined): string {
    if (Array.isArray(value)) {
        return value.every((entry) => typeof entry !== "object" || entry === null)
            ? value.join(", ")
            : JSON.stringify(value);
    }
    if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
    }
    return String(value ?? "");
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


function applyCreateChoice(
    draft: Record<string, JsonValue>,
    field: string,
    choice: JsonValue,
    schema: InstanceCreateSchema | undefined
): Record<string, JsonValue> {
    if (field === "mcp.auth") {
        return applyAuthModeChoice(draft, "mcp.auth", choice);
    }
    if (field === "provider" && typeof choice === "string") {
        let next = setPath(draft, "provider", choice);
        for (const path of ["container", "dockerBinary", "podmanBinary", "ssh"]) {
            next = deletePath(next, path);
        }
        if (choice === "ssh") {
            return setPath(next, "ssh", { command: "" });
        }
        if (choice === "docker" || choice === "podman") {
            const preset = schema?.container.presets[0];
            next = setPath(next, "container", schema === undefined
                ? {
                      containerName: defaultContainerName(draft),
                      image: "",
                      mode: "existingImage"
                  }
                : {
                      containerName: defaultContainerName(draft),
                      image: preset?.image ?? "",
                      mode: schema.container.defaultMode,
                      preset: preset?.preset ?? ""
                  });
        }
        return next;
    }
    if (field === "container.mode" && typeof choice === "string") {
        return setPath(draft, "container", defaultContainerDraft(choice, draft, schema));
    }
    if (field === "container.preset" && typeof choice === "string") {
        const preset = schema?.container.presets.find((entry) => entry.preset === choice);
        let next = setPath(draft, "container.preset", choice);
        if (preset !== undefined) {
            next = setPath(next, "container.image", preset.image);
        }
        return next;
    }
    return setPath(draft, field, choice);
}

function defaultContainerDraft(
    mode: string,
    draft: Record<string, JsonValue>,
    schema: InstanceCreateSchema | undefined
): Record<string, JsonValue> {
    const containerName = defaultContainerName(draft);
    switch (mode) {
        case "preset": {
            const preset = schema?.container.presets[0];
            return {
                containerName,
                image: preset?.image ?? "",
                mode,
                preset: preset?.preset ?? ""
            };
        }
        case "dockerfile":
            return { build: { context: "", tag: `${containerName}:latest` }, containerName, mode };
        case "compose":
            return { compose: { file: "", service: "" }, mode };
        case "existingImage":
            return { containerName, image: "", mode };
        case "existingStoppedContainer":
            return { adoptLifecycle: false, containerName, mode };
        default:
            return { mode };
    }
}

function defaultContainerName(draft: Record<string, JsonValue>): string {
    const name = readPath(draft, "name");
    return typeof name === "string" && name.length > 0 ? `devshell-${name}` : "devshell-instance";
}

function applyAuthModeChoice(
    draft: Record<string, JsonValue>,
    authPath: string,
    choice: JsonValue
): Record<string, JsonValue> {
    if (choice !== "none" && choice !== "token" && choice !== "oauth2") {
        return setPath(draft, authPath, choice);
    }

    const prefix = authPath === "auth" ? "" : authPath.slice(0, -".auth".length);
    const sibling = (name: string) => prefix.length === 0 ? name : `${prefix}.${name}`;
    let next = setPath(draft, authPath, choice);
    next = deletePath(next, sibling("token"));
    next = deletePath(next, sibling("oauth2"));
    if (choice === "token") {
        return setPath(next, sibling("token"), "");
    }
    if (choice === "oauth2") {
        return setPath(next, sibling("oauth2"), { requiredScopes: [], resourceName: "" });
    }
    return next;
}
