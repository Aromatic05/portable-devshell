import type {
    GoalActivityKind,
    GoalContinuationInput,
    GoalManageInput,
    GoalRecord,
    GoalSnapshot,
    InstanceEventType,
    JsonValue,
} from "@portable-devshell/shared";

import { GoalState, type GoalDocument, type GoalTransition } from "./GoalState.js";
import { GoalStore } from "./GoalStore.js";

export class GoalService {
    readonly #appendEvent: (type: Extract<InstanceEventType, `goal.${string}`>, data: JsonValue) => Promise<void>;
    readonly #state: GoalState;
    readonly #store: GoalStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: {
        appendEvent(type: Extract<InstanceEventType, `goal.${string}`>, data: JsonValue): Promise<void>;
        filePath: string;
        instanceName: string;
        state?: GoalState;
    }) {
        this.#appendEvent = options.appendEvent;
        this.#state = options.state ?? new GoalState();
        this.#store = new GoalStore({
            filePath: options.filePath,
            instanceName: options.instanceName,
            state: this.#state,
        });
    }

    async read(ctxId: string): Promise<GoalSnapshot | undefined> {
        await this.#operation;
        return this.#state.read(this.#store.read(ctxId), ctxId);
    }

    async list(): Promise<GoalSnapshot[]> {
        await this.#operation;
        return this.#state.list(this.#store.read());
    }

    async manage(ctxId: string, input: GoalManageInput): Promise<GoalSnapshot | undefined> {
        return await this.#runExclusive(async () => {
            const before = this.#store.read(ctxId);
            const transition = this.#state.manage(before, input, ctxId);
            await this.#persist(before, transition, ctxId);
            return transition.result;
        });
    }

    async stopAll(): Promise<GoalSnapshot[]> {
        return await this.#runExclusive(async () => {
            let document = this.#store.read();
            const stopped: GoalSnapshot[] = [];
            for (const goal of [...document.goals]) {
                if (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "paused") continue;
                const transition = this.#state.manage(document, { action: "stop" }, goal.createdByCtxId);
                await this.#persist(document, transition, goal.createdByCtxId);
                document = transition.document;
                if (transition.result !== undefined) stopped.push(transition.result);
            }
            return stopped;
        });
    }

    async recordReentry(ctxId: string, progressEpoch?: number): Promise<void> {
        await this.#runExclusive(async () => {
            const before = this.#store.read(ctxId);
            const transition = this.#state.reentry(before, ctxId, progressEpoch);
            await this.#persist(before, transition, ctxId);
        });
    }

    async touch(ctxId: string, kind: GoalActivityKind = "execution"): Promise<void> {
        await this.#runExclusive(async () => {
            let current: GoalRecord | undefined;
            try {
                current = this.#store.readRecord(ctxId);
            } catch {
                await this.#persistStructuralTouch(ctxId, kind, this.#store.readStructural());
                return;
            }
            if (current === undefined || current.status !== "active") return;
            if (requiresStructuralTouch(current)) {
                await this.#persistStructuralTouch(ctxId, kind, this.#store.read(ctxId));
                return;
            }
            const transition = this.#state.touch({ goals: [current], version: 1 }, ctxId, kind);
            const next = transition.document.goals[0];
            if (next === undefined) return;
            try {
                this.#store.writeActivity(next);
                await this.#appendGoalEvent(ctxId, next.goalId, next.status);
            } catch {
                await this.#persistStructuralTouch(ctxId, kind, this.#store.readStructural());
            }
        });
    }

    async continuation(ctxId: string, input: GoalContinuationInput): Promise<JsonValue> {
        return await this.#runExclusive(async () => {
            const before = this.#store.read(ctxId);
            const transition = this.#state.continuation(before, input, ctxId);
            await this.#persist(before, transition, ctxId);
            return transition.result as JsonValue;
        });
    }

    async #persist<T>(before: GoalDocument, transition: GoalTransition<T>, ctxId: string): Promise<void> {
        if (transition.document === before) return;
        await this.#store.write(transition.document);
        const goal = this.#state.read(transition.document, ctxId);
        await this.#appendGoalEvent(ctxId, goal?.goalId, goal?.status);
    }

    async #persistStructuralTouch(ctxId: string, kind: GoalActivityKind, before: GoalDocument): Promise<void> {
        const transition = this.#state.touch(before, ctxId, kind);
        await this.#persist(before, transition, ctxId);
    }

    async #appendGoalEvent(ctxId: string, goalId?: string, status?: GoalRecord["status"]): Promise<void> {
        await this.#appendEvent("goal.updated", {
            ctxId,
            ...(goalId === undefined || status === undefined ? {} : { goalId, status }),
        }).catch(() => undefined);
    }

    async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function requiresStructuralTouch(goal: GoalRecord): boolean {
    return goal.continuationPending ||
        goal.continuationAttemptedAt !== undefined ||
        goal.continuationClaimedAt !== undefined ||
        goal.continuationClaimId !== undefined;
}
