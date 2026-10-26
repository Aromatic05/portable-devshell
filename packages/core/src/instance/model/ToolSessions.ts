import { randomUUID } from "node:crypto";
import {
    routeModule, toRemoteErrorBody,
    type ControlPortContext, type ControlPortDefinition, type JsonValue,
    type OwnedToolSession, type ToolCallContext, type ToolSessionBinding, type ToolSessionOpenInput,
} from "@portable-devshell/shared";
import type { Instance } from "./Instance.js";

interface Session {
    input: ToolSessionOpenInput;
    owner: string;
    token: string;
    controller: AbortController;
    active: boolean;
    calls: number;
    drained: Set<() => void>;
    opening: Promise<unknown>;
    closing?: Promise<void>;
    released: boolean;
    onReleased(): Promise<void>;
}

/** Instance-owned resources, including release debts after their route is withdrawn. */
export class InstanceToolSessions {
    readonly #sessions = new Map<string, Session>();

    constructor(private readonly instance: Instance) {
        instance.lifecycle.onRetiring(() => {
            for (const session of this.#sessions.values())
                session.controller.abort(new Error("Extension Worker session closed."));
        });
    }

    route(controlHost: string): ControlPortDefinition {
        return routeModule("tool", {}, {
            ownedSession: async (stream, request, route) => {
                const lease = this.instance.lifecycle.acquireLease();
                let finish!: () => void;
                const lifetime = new Promise<void>((resolve) => { finish = resolve; });
                try {
                assertOwner(route, controlHost);
                route.signal.throwIfAborted();
                const input = readOpen(request.payload);
                if (input.generation !== this.instance.lifecycle.generation)
                    throw new Error("Worker session generation is retired.");
                if (this.#sessions.has(input.sessionId)) throw new Error("Worker session already exists.");
                const token = randomUUID();
                const session: Session = {
                    input, owner: route.connectionId, token,
                    active: false, calls: 0, drained: new Set(), controller: new AbortController(),
                    opening: Promise.resolve(), released: false,
                    onReleased: async () => { await stream.close({}); finish(); },
                };
                this.#sessions.set(input.sessionId, session);
                let disconnected = false;
                const disconnect = () => {
                    disconnected = true;
                    finish();
                    session.controller.abort(new Error("Extension Worker session disconnected."));
                    void this.#release(session).catch((error: unknown) => {
                        console.warn("Worker session disconnect cleanup remains owned by Instance:", error);
                    });
                };
                stream.onCancel(disconnect);
                stream.onClose(disconnect);
                const opening = this.instance.openToolSession(input.context.workspace, input.sessionId);
                session.opening = opening;
                let opened: Awaited<ReturnType<Instance["openToolSession"]>>;
                try {
                    opened = await opening;
                } catch (error) {
                    // openToolSession may itself have failed to release a prepared Workspace.
                    await this.#release(session);
                    throw error;
                }
                session.input.context.workspace = opened.workspace;
                stream.onData(async (message) => {
                    const operation = message as { name?: string; binding?: ToolSessionBinding } | undefined;
                    const name = operation?.name;
                    try {
                        if (operation?.binding?.generation !== input.generation ||
                            operation.binding.sessionId !== input.sessionId || operation.binding.token !== token)
                            throw new Error("Worker session operation has an invalid owner token.");
                        if (name === "close") {
                            await this.#release(session);
                            return;
                        }
                        if (name !== "activate") throw new Error("Invalid Worker session operation.");
                        route.signal.throwIfAborted();
                        if (!this.instance.lifecycle.active || session.released || session.closing !== undefined ||
                            session.controller.signal.aborted)
                            throw new Error("Worker session generation is retired.");
                        session.active = true;
                        await stream.send({});
                    } catch (error) {
                        await stream.send({ error: toRemoteErrorBody(error) } as unknown as JsonValue);
                    }
                });
                if (disconnected || route.signal.aborted) { await this.#release(session); return; }
                await stream.send({
                    ...opened,
                    binding: { generation: input.generation, sessionId: input.sessionId, token },
                } satisfies OwnedToolSession as unknown as JsonValue);
                } finally { lease.release(); }
                // Keep the owning stream alive without holding an admission lease.
                await lifetime;
            },
        });
    }

    validate(binding: unknown, context: ToolCallContext, recording: "host" | "caller", route: ControlPortContext): { signal: AbortSignal; release(): void } {
        const value = binding as { generation?: string; sessionId?: string; token?: string } | null;
        const session = typeof value?.sessionId === "string" ? this.#sessions.get(value.sessionId) : undefined;
        if (session === undefined || value?.generation !== this.instance.lifecycle.generation ||
            value.token !== session.token || route.connectionId !== session.owner ||
            !session.active || session.released || session.closing !== undefined || session.controller.signal.aborted)
            throw new Error("Worker session owner or generation is unavailable.");
        const expected = session.input.context;
        if (context.source !== "extension" || context.extensionId !== expected.extensionId ||
            context.ctxId !== expected.ctxId || context.workspace !== expected.workspace ||
            recording !== session.input.recording)
            throw new Error("Worker session Context or transcript owner does not match.");
        session.calls += 1;
        return { signal: session.controller.signal, release: () => {
            session.calls -= 1;
            if (session.calls === 0) {
                for (const done of session.drained) done();
                session.drained.clear();
            }
        } };
    }

    async retire(): Promise<void> {
        const results = await Promise.allSettled([...this.#sessions.values()].map((session) => this.#release(session)));
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Worker session release remains incomplete.");
    }

    #release(session: Session): Promise<void> {
        if (session.closing !== undefined) return session.closing;
        session.active = false;
        session.controller.abort(new Error("Extension Worker session closed."));
        session.closing = Promise.resolve().then(async () => {
            await session.opening.catch(() => undefined);
            if (session.calls > 0)
                await new Promise<void>((resolve) => session.drained.add(resolve));
            if (!session.released) await this.instance.closeToolSession(session.input.sessionId);
            session.released = true;
            await session.onReleased();
            this.#sessions.delete(session.input.sessionId);
        }).catch((error: unknown) => {
            session.closing = undefined;
            throw error;
        });
        return session.closing;
    }
}

function assertOwner(route: ControlPortContext, controlHost: string): void {
    if (route.sourceHost !== controlHost || route.peer !== "cli" || route.subject?.kind !== "local-owner")
        throw new Error("Worker sessions require the Control internal connection.");
}

function readOpen(value: unknown): ToolSessionOpenInput {
    const input = value as ToolSessionOpenInput | null;
    if (typeof input?.generation !== "string" || typeof input.sessionId !== "string" ||
        input.sessionId.length === 0 || input.context?.source !== "extension" ||
        typeof input.context.extensionId !== "string" || typeof input.context.workspace !== "string" ||
        (input.context.ctxId !== undefined && typeof input.context.ctxId !== "string") ||
        (input.recording !== "host" && input.recording !== "caller"))
        throw new TypeError("Invalid Worker session open request.");
    return input;
}
