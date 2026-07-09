import { TuiActionDispatcher } from "./TuiActionDispatcher.js";
import { TuiFocusManager } from "./TuiFocusManager.js";
import { TuiKeymapRegistry } from "./TuiKeymap.js";

export interface TuiFormOptions<T> {
    onRefresh?: () => Promise<void> | void;
    onSubmit: (draft: T) => Promise<T> | T;
    validate?: (draft: T) => Record<string, string>;
}

export interface TuiConfirmModalState {
    cancelLabel: string;
    confirmActionId: string;
    confirmLabel: string;
    description: string;
    open: boolean;
    title: string;
}

export class TuiFormState<T extends Record<string, unknown>> {
    readonly #onRefresh?: () => Promise<void> | void;
    readonly #onSubmit: (draft: T) => Promise<T> | T;
    readonly #validate?: (draft: T) => Record<string, string>;
    #draft: T;
    #editing = false;
    #source: T;
    #submitError?: string;
    #submitting = false;
    #validationErrors: Record<string, string> = {};

    constructor(initialValue: T, options: TuiFormOptions<T>) {
        this.#source = cloneRecord(initialValue);
        this.#draft = cloneRecord(initialValue);
        this.#onSubmit = options.onSubmit;
        this.#onRefresh = options.onRefresh;
        this.#validate = options.validate;
        this.#validationErrors = this.#readValidationErrors(this.#draft);
    }

    beginEdit(): void {
        this.#editing = true;
        this.#submitError = undefined;
    }

    update<K extends keyof T>(key: K, value: T[K]): void {
        this.#editing = true;
        this.#submitError = undefined;
        this.#draft = {
            ...this.#draft,
            [key]: value
        };
        this.#validationErrors = this.#readValidationErrors(this.#draft);
    }

    canSave(): boolean {
        return this.#editing && this.dirty() && !this.#submitting && Object.keys(this.#validationErrors).length === 0;
    }

    canCancel(): boolean {
        return this.#editing || this.dirty();
    }

    dirty(): boolean {
        return stableStringify(this.#draft) !== stableStringify(this.#source);
    }

    isEditing(): boolean {
        return this.#editing;
    }

    isSubmitting(): boolean {
        return this.#submitting;
    }

    draft(): T {
        return cloneRecord(this.#draft);
    }

    source(): T {
        return cloneRecord(this.#source);
    }

    validationErrors(): Record<string, string> {
        return { ...this.#validationErrors };
    }

    submitError(): string | undefined {
        return this.#submitError;
    }

    async save(): Promise<boolean> {
        if (!this.canSave()) {
            return false;
        }

        this.#submitting = true;
        this.#submitError = undefined;

        try {
            const committed = await this.#onSubmit(cloneRecord(this.#draft));
            this.#source = cloneRecord(committed);
            this.#draft = cloneRecord(committed);
            this.#editing = false;
            this.#validationErrors = this.#readValidationErrors(this.#draft);
            await this.#onRefresh?.();
            return true;
        } catch (error) {
            this.#submitError = error instanceof Error ? error.message : String(error);
            return false;
        } finally {
            this.#submitting = false;
        }
    }

    cancel(): boolean {
        if (!this.canCancel()) {
            return false;
        }

        this.#draft = cloneRecord(this.#source);
        this.#editing = false;
        this.#submitError = undefined;
        this.#validationErrors = this.#readValidationErrors(this.#draft);
        return true;
    }

    #readValidationErrors(draft: T): Record<string, string> {
        return this.#validate?.(cloneRecord(draft)) ?? {};
    }
}

export class TuiModalState {
    #state: TuiConfirmModalState = {
        cancelLabel: "Cancel",
        confirmActionId: "",
        confirmLabel: "Confirm",
        description: "",
        open: false,
        title: ""
    };

    open(input: Omit<TuiConfirmModalState, "open">): void {
        this.#state = {
            ...input,
            open: true
        };
    }

    close(): boolean {
        if (!this.#state.open) {
            return false;
        }

        this.#state = {
            ...this.#state,
            open: false
        };
        return true;
    }

    state(): TuiConfirmModalState {
        return { ...this.#state };
    }
}

export interface TuiInteractionControllerOptions<T extends Record<string, unknown>> {
    form: TuiFormState<T>;
    modal: TuiModalState;
}

export class TuiInteractionController<T extends Record<string, unknown>> {
    readonly dispatcher = new TuiActionDispatcher();
    readonly focusManager = new TuiFocusManager();
    readonly keymap = new TuiKeymapRegistry();
    readonly #form: TuiFormState<T>;
    readonly #modal: TuiModalState;
    #errorMessage?: string;
    #quitRequested = false;

    constructor(options: TuiInteractionControllerOptions<T>) {
        this.#form = options.form;
        this.#modal = options.modal;
        this.#registerDefaultActions();
    }

    errorMessage(): string | undefined {
        return this.#errorMessage ?? this.#form.submitError();
    }

    quitRequested(): boolean {
        return this.#quitRequested;
    }

    modalState(): TuiConfirmModalState {
        return this.#modal.state();
    }

    modal(): TuiModalState {
        return this.#modal;
    }

    formState(): TuiFormState<T> {
        return this.#form;
    }

    async handleKey(key: string): Promise<boolean> {
        const actionId = this.keymap.resolve(key);

        if (actionId === undefined) {
            return false;
        }

        return await this.dispatcher.dispatch(actionId);
    }

    #registerDefaultActions(): void {
        this.dispatcher.register("focus.next", () => this.focusManager.focusNext());
        this.dispatcher.register("focus.previous", () => this.focusManager.focusPrevious());
        this.dispatcher.register("focus.direction.up", () => this.focusManager.focusDirectional("up"));
        this.dispatcher.register("focus.direction.down", () => this.focusManager.focusDirectional("down"));
        this.dispatcher.register("focus.direction.left", () => this.focusManager.focusDirectional("left"));
        this.dispatcher.register("focus.direction.right", () => this.focusManager.focusDirectional("right"));
        this.dispatcher.register("focus.activate", async () => await this.#activateFocused());
        this.dispatcher.register("interaction.escape", () => this.#escape());
        this.dispatcher.register("app.quit", () => {
            this.#quitRequested = true;
            return true;
        });
        this.dispatcher.register("form.save", async () => {
            const saved = await this.#form.save();
            this.#errorMessage = this.#form.submitError();
            return saved;
        });
        this.dispatcher.register("form.cancel", () => {
            const cancelled = this.#form.cancel();
            this.#errorMessage = undefined;
            if (cancelled) {
                this.focusManager.exitScope();
            }
            return cancelled;
        });
        this.dispatcher.register("modal.close", () => {
            const closed = this.#modal.close();
            if (closed) {
                this.focusManager.exitScope();
            }
            return closed;
        });
    }

    async #activateFocused(): Promise<boolean> {
        const actionId = this.focusManager.currentEntry()?.actionId;

        if (actionId === undefined) {
            return false;
        }

        const dispatched = await this.dispatcher.dispatch(actionId);
        this.#errorMessage = this.#form.submitError();
        return dispatched;
    }

    #escape(): boolean {
        if (this.#modal.close()) {
            this.focusManager.exitScope();
            return true;
        }

        if (this.#form.isEditing()) {
            const cancelled = this.#form.cancel();
            if (cancelled) {
                this.focusManager.exitScope();
            }
            return cancelled;
        }

        return this.focusManager.exitScope();
    }
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
    return { ...value };
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
            .join(",")}}`;
    }

    return JSON.stringify(value);
}
