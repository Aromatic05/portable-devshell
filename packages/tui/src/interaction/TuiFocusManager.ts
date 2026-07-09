export interface TuiFocusEntry {
    actionId?: string;
    id: string;
    visible?: boolean;
}

export interface TuiFocusScope {
    id: string;
    parentId?: string;
}

export class TuiFocusManager {
    readonly #entries = new Map<string, TuiFocusEntry[]>();
    readonly #scopes = new Map<string, TuiFocusScope>();
    readonly #stack: string[] = [];
    readonly #lastFocusedByScope = new Map<string, string>();
    #focusedId?: string;

    registerScope(scope: TuiFocusScope): void {
        this.#scopes.set(scope.id, { ...scope });

        if (this.#stack.length === 0) {
            this.#stack.push(scope.id);
        }
    }

    setScopeEntries(scopeId: string, entries: ReadonlyArray<TuiFocusEntry>): void {
        this.#entries.set(
            scopeId,
            entries.map((entry) => ({
                ...entry,
                visible: entry.visible !== false
            }))
        );

        if (this.#currentScopeId() === scopeId && !this.#isVisible(this.#focusedId)) {
            this.focusFirstVisible(scopeId);
        }
    }

    enterScope(scopeId: string, focusedId?: string): void {
        if (!this.#scopes.has(scopeId)) {
            throw new Error(`Unknown focus scope: ${scopeId}`);
        }

        if (this.#currentScopeId() !== scopeId) {
            this.#stack.push(scopeId);
        }

        if (focusedId !== undefined && this.focus(scopeId, focusedId)) {
            return;
        }

        this.focusFirstVisible(scopeId);
    }

    exitScope(): boolean {
        if (this.#stack.length <= 1) {
            return false;
        }

        this.#stack.pop();
        this.focusFirstVisible(this.#currentScopeId());
        return true;
    }

    focus(scopeId: string, entryId: string): boolean {
        const entry = this.#visibleEntries(scopeId).find((candidate) => candidate.id === entryId);

        if (entry === undefined) {
            return false;
        }

        this.#focusedId = entry.id;
        this.#lastFocusedByScope.set(scopeId, entry.id);
        return true;
    }

    focusFirstVisible(scopeId = this.#currentScopeId()): boolean {
        const rememberedId = this.#lastFocusedByScope.get(scopeId);

        if (rememberedId !== undefined && this.focus(scopeId, rememberedId)) {
            return true;
        }

        const entry = this.#visibleEntries(scopeId)[0];

        if (entry === undefined) {
            this.#focusedId = undefined;
            return false;
        }

        this.#focusedId = entry.id;
        this.#lastFocusedByScope.set(scopeId, entry.id);
        return true;
    }

    focusNext(): boolean {
        return this.#move(1);
    }

    focusPrevious(): boolean {
        return this.#move(-1);
    }

    focusDirectional(direction: "down" | "left" | "right" | "up"): boolean {
        return direction === "left" || direction === "up" ? this.focusPrevious() : this.focusNext();
    }

    currentScopeId(): string {
        return this.#currentScopeId();
    }

    currentFocusId(): string | undefined {
        return this.#focusedId;
    }

    currentEntry(): TuiFocusEntry | undefined {
        return this.#visibleEntries(this.#currentScopeId()).find((entry) => entry.id === this.#focusedId);
    }

    visibleEntries(scopeId = this.#currentScopeId()): TuiFocusEntry[] {
        return this.#visibleEntries(scopeId).map((entry) => ({ ...entry }));
    }

    #move(offset: 1 | -1): boolean {
        const entries = this.#visibleEntries(this.#currentScopeId());

        if (entries.length === 0) {
            this.#focusedId = undefined;
            return false;
        }

        const currentIndex = this.#focusedId === undefined ? -1 : entries.findIndex((entry) => entry.id === this.#focusedId);
        const baseIndex = currentIndex === -1 ? (offset === 1 ? -1 : 0) : currentIndex;
        const nextIndex = (baseIndex + offset + entries.length) % entries.length;
        this.#focusedId = entries[nextIndex]?.id;
        if (this.#focusedId !== undefined) {
            this.#lastFocusedByScope.set(this.#currentScopeId(), this.#focusedId);
        }
        return this.#focusedId !== undefined;
    }

    #currentScopeId(): string {
        const scopeId = this.#stack.at(-1);

        if (scopeId === undefined) {
            throw new Error("Focus manager has no active scope.");
        }

        return scopeId;
    }

    #visibleEntries(scopeId: string): TuiFocusEntry[] {
        return (this.#entries.get(scopeId) ?? []).filter((entry) => entry.visible !== false);
    }

    #isVisible(entryId: string | undefined): boolean {
        if (entryId === undefined) {
            return false;
        }

        return this.#visibleEntries(this.#currentScopeId()).some((entry) => entry.id === entryId);
    }
}
