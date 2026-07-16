import { tuiFocusItemKey, isSameTuiFocusItem, type TuiFocusItem } from "./TuiFocusItem.js";

export type TuiFocusDirection = "next" | "previous" | "up" | "down" | "left" | "right";

export interface TuiFocusNode {
    down?: TuiFocusItem;
    item: TuiFocusItem;
    left?: TuiFocusItem;
    next?: TuiFocusItem;
    previous?: TuiFocusItem;
    right?: TuiFocusItem;
    up?: TuiFocusItem;
}

export class TuiFocusGraph {
    readonly #nodes = new Map<string, TuiFocusNode>();
    readonly #order: TuiFocusItem[] = [];

    constructor(nodes: ReadonlyArray<TuiFocusNode>) {
        for (const node of nodes) {
            this.#nodes.set(tuiFocusItemKey(node.item), node);
            this.#order.push(node.item);
        }
    }

    first(): TuiFocusItem | undefined {
        return this.#order[0];
    }

    last(): TuiFocusItem | undefined {
        return this.#order.at(-1);
    }

    includes(item: TuiFocusItem | undefined): boolean {
        if (item === undefined) {
            return false;
        }

        return this.#nodes.has(tuiFocusItemKey(item));
    }

    move(current: TuiFocusItem | undefined, direction: TuiFocusDirection): TuiFocusItem | undefined {
        if (this.#order.length === 0) {
            return undefined;
        }

        if (current === undefined || !this.includes(current)) {
            return direction === "previous" ? this.#order.at(-1) : this.#order[0];
        }

        const node = this.#nodes.get(tuiFocusItemKey(current));

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

    #moveSequential(current: TuiFocusItem, offset: 1 | -1): TuiFocusItem {
        const currentIndex = this.#order.findIndex((item) => isSameTuiFocusItem(item, current));

        if (currentIndex === -1) {
            return this.#order[0] ?? current;
        }

        const nextIndex = (currentIndex + offset + this.#order.length) % this.#order.length;
        return this.#order[nextIndex] ?? current;
    }
}
