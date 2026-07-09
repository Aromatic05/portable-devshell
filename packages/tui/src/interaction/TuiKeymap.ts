export type TuiActionId =
    | "app.quit"
    | "focus.next"
    | "focus.previous"
    | "focus.direction.up"
    | "focus.direction.down"
    | "focus.direction.left"
    | "focus.direction.right"
    | "focus.activate"
    | "interaction.escape";

export class TuiKeymapRegistry {
    readonly #bindings = new Map<string, TuiActionId>();

    constructor() {
        this.bind("tab", "focus.next");
        this.bind("shift+tab", "focus.previous");
        this.bind("up", "focus.direction.up");
        this.bind("down", "focus.direction.down");
        this.bind("left", "focus.direction.left");
        this.bind("right", "focus.direction.right");
        this.bind("enter", "focus.activate");
        this.bind("esc", "interaction.escape");
        this.bind("ctrl+c", "app.quit");
    }

    bind(key: string, actionId: TuiActionId): void {
        this.#bindings.set(normalizeKey(key), actionId);
    }

    resolve(key: string): TuiActionId | undefined {
        return this.#bindings.get(normalizeKey(key));
    }
}

function normalizeKey(key: string): string {
    return key.trim().toLowerCase();
}
