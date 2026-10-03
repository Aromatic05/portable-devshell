import type { WorkspaceAction, WorkspaceActionRequest, WorkspaceItem, WorkspaceQuestionItem, WorkspaceSnapshot } from "../../model/Contract.js";
import { actionKey, bindWorkspaceCards, renderWorkspace, type WorkspaceCardEvents } from "./Cards.js";

export class WorkspaceView {
    readonly #root: HTMLElement;
    readonly #cleanup: () => void;
    readonly #busy = new Set<string>();
    readonly #drafts = new Map<string, string>();
    readonly #expanded = new Set<string>();
    readonly #events: WorkspaceCardEvents;
    #pending?: WorkspaceActionRequest;
    #snapshot?: WorkspaceSnapshot;
    #displayMode = "inline";
    constructor(root: HTMLElement, events: WorkspaceCardEvents) {
        this.#root = root;
        this.#events = events;
        this.#cleanup = bindWorkspaceCards(root, {
            action: request => this.#requestAction(request),
            displayMode: events.displayMode,
            input: request => { this.#drafts.set(actionKey(request.itemId, request.actionId), request.input ?? ""); },
            expandChoices: request => {
                if (!this.#findChoiceQuestion(request)) return;
                this.#expanded.add(actionKey(request.itemId, request.actionId));
                this.render();
            },
            confirm: () => {
                const pending = this.#pending;
                if (!pending || !this.#findAction(pending)?.confirmation || this.#busy.has(pending.actionId)) return;
                this.#pending = undefined;
                this.#events.action(pending);
                this.render();
            },
            cancelConfirmation: () => { this.#pending = undefined; this.render(); },
        });
    }
    get snapshot(): WorkspaceSnapshot | undefined { return this.#snapshot; }
    setBusy(actionId: string, busy: boolean): void { if (busy) this.#busy.add(actionId); else this.#busy.delete(actionId); this.render(); }
    setDisplayMode(mode: string): void { this.#displayMode = mode; this.render(); }
    setSnapshot(snapshot: WorkspaceSnapshot): void { if (this.#snapshot?.ctxId !== snapshot.ctxId) this.clear(); this.#snapshot = snapshot; this.render(); }
    clear(): void { this.#snapshot = undefined; this.#pending = undefined; this.#drafts.clear(); this.#expanded.clear(); this.#busy.clear(); this.#root.innerHTML = ""; }
    destroy(): void { this.#cleanup(); }
    render(): void {
        if (!this.#snapshot) return;
        const inputs = Array.from(this.#root.querySelectorAll<HTMLInputElement>('input[name="input"]'));
        const active = inputs.find(input => input === this.#root.ownerDocument.activeElement);
        const activeForm = active?.closest<HTMLFormElement>("[data-action-item]");
        const focusedKey = activeForm ? actionKey(activeForm.dataset.actionItem!, activeForm.dataset.actionId!) : undefined;
        const selection = active ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : undefined;
        for (const input of inputs) {
            const form = input.closest<HTMLFormElement>("[data-action-item]");
            if (form) this.#drafts.set(actionKey(form.dataset.actionItem!, form.dataset.actionId!), input.value);
        }
        const items = [...(this.#snapshot.presentation.primary ? [this.#snapshot.presentation.primary] : []), ...this.#snapshot.presentation.work, ...this.#snapshot.presentation.background];
        const keys = new Set(items.flatMap(item => item.actions.map(action => actionKey(item.id, action.id))));
        for (const key of this.#drafts.keys()) if (!keys.has(key)) this.#drafts.delete(key);
        const choiceKeys = new Set(items.flatMap(item => item.kind === "question" && item.input.kind === "choice" ? item.actions.map(action => actionKey(item.id, action.id)) : []));
        for (const key of this.#expanded) if (!choiceKeys.has(key)) this.#expanded.delete(key);
        if (this.#pending && !this.#findAction(this.#pending)?.confirmation) this.#pending = undefined;
        this.#root.innerHTML = renderWorkspace(this.#snapshot, this.#busy, this.#displayMode, { drafts: this.#drafts, pending: this.#pending, expanded: this.#expanded });
        for (const input of Array.from(this.#root.querySelectorAll<HTMLInputElement>('input[name="input"]'))) {
            const form = input.closest<HTMLFormElement>("[data-action-item]");
            if (form && focusedKey === actionKey(form.dataset.actionItem!, form.dataset.actionId!)) {
                input.focus();
                if (selection?.start !== null && selection?.start !== undefined && selection.end !== null) input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
            }
        }
    }

    #findAction(request: WorkspaceActionRequest): WorkspaceAction | undefined {
        return this.#findItem(request.itemId)?.actions.find(action => action.id === request.actionId);
    }

    #findChoiceQuestion(request: WorkspaceActionRequest): WorkspaceQuestionItem | undefined {
        const item = this.#findItem(request.itemId);
        return item?.kind === "question" && item.input.kind === "choice" && item.actions[0]?.id === request.actionId ? item : undefined;
    }

    #requestAction(request: WorkspaceActionRequest): void {
        const action = this.#findAction(request);
        if (!action || this.#busy.has(request.actionId)) return;
        if (action.confirmation) { this.#pending = request; this.render(); }
        else this.#events.action(request);
    }

    #findItem(itemId: string): WorkspaceItem | undefined {
        const presentation = this.#snapshot?.presentation;
        const items = presentation ? [...(presentation.primary ? [presentation.primary] : []), ...presentation.work, ...presentation.background] : [];
        return items.find(item => item.id === itemId);
    }
}
