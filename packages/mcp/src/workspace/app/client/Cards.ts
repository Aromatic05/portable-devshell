import type { WorkspaceAction, WorkspaceActionInput, WorkspaceActionRequest, WorkspaceItem, WorkspaceSnapshot } from "../../model/Contract.js";

export interface WorkspaceCardEvents {
    action(request: { itemId: string; actionId: string; input?: string }): void;
    displayMode(mode: "inline" | "pip" | "fullscreen"): void;
}

export interface WorkspaceCardBindings extends WorkspaceCardEvents {
    input(request: WorkspaceActionRequest): void;
    expandChoices(request: WorkspaceActionRequest): void;
    confirm(): void;
    cancelConfirmation(): void;
}

export interface WorkspaceCardState { drafts: ReadonlyMap<string, string>; pending?: WorkspaceActionRequest; expanded?: ReadonlySet<string>; }
export function actionKey(itemId: string, actionId: string): string { return JSON.stringify([itemId, actionId]); }

export function renderWorkspace(snapshot: WorkspaceSnapshot, busy: ReadonlySet<string>, displayMode: string, state?: WorkspaceCardState): string {
    const items: WorkspaceItem[] = [...(snapshot.presentation.primary ? [snapshot.presentation.primary] : []), ...snapshot.presentation.work, ...snapshot.presentation.background];
    if (items.length === 0) return `<section class="card"><div class="head"><strong>Workspace</strong><span class="badge">${snapshot.agentBusy ? "Working" : "Ready"}</span></div><div class="body muted">Nothing needs attention right now.</div></section>${renderDisplayControls(displayMode)}`;
    return items.map(item => {
        const details = item.kind === "work" ? [item.detail, item.current, item.note] : [item.summary, item.detail];
        const detail = details.filter(Boolean).map(text => `<div>${escapeHtml(text!).replaceAll("\n", "<br>")}</div>`).join("");
        const actionRows = item.actions.map(action => renderAction(item.id, action, busy.has(action.id), state)).join("");
        const actions = item.kind === "work" ? `<div class="work-actions">${actionRows}</div>` : item.kind === "background" ? "" : actionRows;
        const pending = state?.pending;
        const confirmation = pending?.itemId === item.id ? item.actions.find(action => action.id === pending.actionId)?.confirmation : undefined;
        const confirm = confirmation ? `<div class="body">${escapeHtml(confirmation.message)}</div><div class="row"><button data-confirm-action${busy.has(pending!.actionId) ? " disabled" : ""}>Confirm</button><button data-cancel-confirmation>Cancel</button></div>` : "";
        const progress = item.kind === "work" && item.progress ? `<span class="muted">${item.progress.current} / ${item.progress.total}</span>` : "";
        const badge = item.badge;
        return `<section class="card" data-kind="${item.kind}"><div class="head"><strong>${escapeHtml(item.title)}</strong><span class="row">${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ""}${progress}${item.kind === "background" ? `<span class="background-controls">${actionRows}</span>` : ""}</span></div>${detail ? `<div class="body">${detail}</div>` : ""}${actions}${confirm}</section>`;
    }).join("") + renderDisplayControls(displayMode);
}

function renderDisplayControls(displayMode: string): string {
    const options = (["inline", "pip", "fullscreen"] as const).map(mode => `<button data-mode="${mode}"${displayMode === mode ? " disabled" : ""}>${mode === "pip" ? "Picture in picture" : mode === "fullscreen" ? "Fullscreen" : "Inline"}</button>`).join("");
    return `<div class="row">${options}</div>`;
}

function renderAction(itemId: string, action: WorkspaceAction, disabled: boolean, state?: WorkspaceCardState): string {
    const input = action.input;
    if (input?.kind === "text") return `<form class="question-input" data-action-item="${escapeHtml(itemId)}" data-action-id="${escapeHtml(action.id)}"><input name="input" value="${escapeHtml(state?.drafts.get(actionKey(itemId, action.id)) ?? "")}" placeholder="${escapeHtml(input.placeholder ?? "")}" required><button class="action" data-tone="${action.tone ?? "default"}"${disabled ? " disabled" : ""}>${escapeHtml(action.label)}</button></form>`;
    if (input?.kind === "choice") return renderChoices(itemId, action, input, disabled);
    return `<button class="action" data-item="${escapeHtml(itemId)}" data-action="${escapeHtml(action.id)}" data-tone="${action.tone ?? "default"}"${disabled ? " disabled" : ""}>${escapeHtml(action.label)}</button>`;
}

function renderChoices(itemId: string, action: WorkspaceAction, input: Extract<WorkspaceActionInput, { kind: "choice" }>, disabled: boolean): string {
    return input.choices.map(choice => `<button class="action" data-item="${escapeHtml(itemId)}" data-action="${escapeHtml(action.id)}" data-value="${escapeHtml(choice.id)}"${disabled ? " disabled" : ""}>${escapeHtml(choice.label)}</button>`).join("");
}

export function bindWorkspaceCards(root: HTMLElement, events: WorkspaceCardBindings): () => void {
    const click = (event: Event) => {
        const choice = (event.target as HTMLElement).closest<HTMLElement>("[data-choice], [data-choice-expand]");
        if (choice) {
            if (choice.hasAttribute("disabled")) return;
            const request = { itemId: choice.dataset.item!, actionId: choice.dataset.action ?? choice.dataset.actionId!, ...(choice.dataset.value === undefined ? {} : { input: choice.dataset.value }) };
            if (choice.hasAttribute("data-choice-expand")) events.expandChoices(request);
            else events.action(request);
            return;
        }
        const confirmation = (event.target as HTMLElement).closest<HTMLElement>("[data-confirm-action], [data-cancel-confirmation]");
        if (confirmation) {
            if (!confirmation.hasAttribute("disabled")) {
                if (confirmation.hasAttribute("data-confirm-action")) events.confirm();
                else events.cancelConfirmation();
            }
            return;
        }
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
        if (target && !target.hasAttribute("disabled")) {
            events.action({ itemId: target.dataset.item!, actionId: target.dataset.action!, ...(target.dataset.value === undefined ? {} : { input: target.dataset.value }) });
            return;
        }
        const mode = (event.target as HTMLElement).closest<HTMLElement>("[data-mode]")?.dataset.mode;
        if (mode === "inline" || mode === "pip" || mode === "fullscreen") events.displayMode(mode);
    };
    const submit = (event: Event) => {
        const form = event.target as HTMLFormElement;
        if (!form.matches("[data-action-item]")) return;
        event.preventDefault();
        const input = form.querySelector<HTMLInputElement>('input[name="input"]')?.value;
        if (!form.querySelector<HTMLButtonElement>("button")?.disabled && input?.trim()) events.action({ itemId: form.dataset.actionItem!, actionId: form.dataset.actionId!, input: input.trim() });
    };
    const input = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const form = target.closest<HTMLFormElement>("[data-action-item]");
        if (target.matches('input[name="input"]') && form) events.input({ itemId: form.dataset.actionItem!, actionId: form.dataset.actionId!, input: target.value });
    };
    root.addEventListener("click", click);
    root.addEventListener("submit", submit);
    root.addEventListener("input", input);
    return () => { root.removeEventListener("click", click); root.removeEventListener("submit", submit); root.removeEventListener("input", input); };
}

function escapeHtml(value: unknown): string { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
