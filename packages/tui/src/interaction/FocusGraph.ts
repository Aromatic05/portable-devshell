import { focusItemKey, isSameFocusItem, type FocusItem } from "./TuiInteractionTypes.js";

export type FocusDirection = "next" | "previous" | "up" | "down" | "left" | "right";

export interface FocusNode {
    down?: FocusItem;
    item: FocusItem;
    left?: FocusItem;
    next?: FocusItem;
    previous?: FocusItem;
    right?: FocusItem;
    up?: FocusItem;
}

export class FocusGraph {
    readonly #nodes = new Map<string, FocusNode>();
    readonly #order: FocusItem[] = [];

    constructor(nodes: ReadonlyArray<FocusNode>) {
        for (const node of nodes) {
            this.#nodes.set(focusItemKey(node.item), node);
            this.#order.push(node.item);
        }
    }

    first(): FocusItem | undefined {
        return this.#order[0];
    }

    last(): FocusItem | undefined {
        return this.#order.at(-1);
    }

    includes(item: FocusItem | undefined): boolean {
        if (item === undefined) {
            return false;
        }

        return this.#nodes.has(focusItemKey(item));
    }

    move(current: FocusItem | undefined, direction: FocusDirection): FocusItem | undefined {
        if (this.#order.length === 0) {
            return undefined;
        }

        if (current === undefined || !this.includes(current)) {
            return direction === "previous" ? this.#order.at(-1) : this.#order[0];
        }

        const node = this.#nodes.get(focusItemKey(current));

        if (node === undefined) {
            return this.#order[0];
        }

        const explicit = node[direction];

        if (explicit !== undefined && this.includes(explicit)) {
            return explicit;
        }

        if (direction === "next" || direction === "previous") {
            return this.#moveSequential(current, direction === "next" ? 1 : -1);
        }

        return current;
    }

    #moveSequential(current: FocusItem, offset: 1 | -1): FocusItem {
        const currentIndex = this.#order.findIndex((item) => isSameFocusItem(item, current));

        if (currentIndex === -1) {
            return this.#order[0] ?? current;
        }

        const nextIndex = (currentIndex + offset + this.#order.length) % this.#order.length;
        return this.#order[nextIndex] ?? current;
    }
}
