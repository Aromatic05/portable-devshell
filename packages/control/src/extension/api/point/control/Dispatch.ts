import {
    routeModule,
    mergeControlPortsByName,
    toRemoteErrorBody,
    type MessageStream,
    type JsonValue,
    type ControlPortContext,
    type ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    routes,
    streams,
    type ControlStreamBinding,
    type ControlRouteBinding,
    type ControlRouteDeclaration,
    type ControlRouteScope,
} from "@portable-devshell/extension/control";

import type { ExtensionHost } from "../../../host/index.js";
import type { ExtensionRegistrationLease } from "../../../Api.js";

export class ControlExtensionRouteService {
    readonly #activeStreams = new Set<{
        instance: string;
        controller: AbortController;
        done: Promise<void>;
    }>();
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations" | "onChange"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations" | "onChange"
        >,
    ) {
        this.#extensions = extensions;
    }

    modules(scope: ControlRouteScope): readonly ControlPortDefinition[] {
        const grouped = new Map<
            string,
            Map<string, { declaration: ControlRouteDeclaration; id: string }>
        >();
        for (const registration of this.#extensions.listDeclarations(
            routes.id,
        )) {
            const declaration =
                registration.declaration as ControlRouteDeclaration;
            if (declaration.scope !== scope) continue;
            const operations =
                grouped.get(declaration.module) ??
                new Map<
                    string,
                    { declaration: ControlRouteDeclaration; id: string }
                >();
            if (operations.has(declaration.operation)) {
                throw new TypeError(
                    `Control route ${scope}/${declaration.module}/${declaration.operation} is registered more than once.`,
                );
            }
            operations.set(declaration.operation, {
                declaration,
                id: declaration.id,
            });
            grouped.set(declaration.module, operations);
        }
        const ports = [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([module, operations]) =>
                routeModule(
                    module,
                    Object.fromEntries(
                        [...operations.entries()]
                            .sort(([left], [right]) =>
                                left.localeCompare(right),
                            )
                            .map(([operation, entry]) => [
                                operation,
                                async (request, context) =>
                                    await this.#invoke(
                                        entry.id,
                                        request,
                                        context,
                                    ),
                            ]),
                    ),
                ),
            );
        for (const registration of this.#extensions.listDeclarations(streams.id)) {
            const declaration = registration.declaration as ControlRouteDeclaration;
            if (declaration.scope !== scope) continue;
            ports.push({
                name: declaration.module,
                operations: [],
                streams: [{
                    name: declaration.operation,
                    handle: async (stream, request, context) =>
                        await this.#invokeStream(registration.id, stream, request, context),
                }],
            });
        }
        return mergeControlPortsByName(ports);
    }

    onChange(listener: () => void): () => void {
        return this.#extensions.onChange(listener);
    }

    async retireInstance(instance: string): Promise<void> {
        const active = [...this.#activeStreams].filter((entry) => entry.instance === instance);
        for (const entry of active) entry.controller.abort(new Error("Instance generation retired."));
        await Promise.all(active.map((entry) => entry.done));
    }

    async #invokeStream(
        id: string,
        stream: MessageStream,
        request: { payload?: JsonValue },
        context: ControlPortContext,
    ): Promise<void> {
        const controller = new AbortController();
        let signal = AbortSignal.any([context.signal, controller.signal]);
        let admitted!: () => void;
        let rejectAdmission!: (error: unknown) => void;
        const admission = new Promise<void>((resolve, reject) => {
            admitted = resolve;
            rejectAdmission = reject;
        });
        const active = { instance: context.host, controller, done: Promise.resolve() };
        // Pending lazy activation belongs to this admission too. Track it before
        // calling the Host, and publish done before extension code can reenter.
        this.#activeStreams.add(active);
        active.done = Promise.resolve().then(async () => {
            let lease: ExtensionRegistrationLease["lease"] | undefined;
            let offChange: (() => void) | undefined;
            try {
                const acquired = await this.#acquireStreamRegistration(id, signal);
                if (acquired === undefined) {
                    await stream.close();
                    return;
                }
                const { extensionId, registration } = acquired;
                lease = acquired.lease;
                // Same-hash reloads share content, but have different lifetimes.
                signal = AbortSignal.any([signal, lease.retirementSignal]);
                const checkGeneration = () => {
                    const current = this.#extensions.listDeclarations(streams.id).find((entry) => entry.id === id);
                    if (current?.extensionId !== extensionId || current.generation !== acquired.lease.generation)
                        controller.abort(new Error("Extension stream generation retired."));
                };
                offChange = this.#extensions.onChange(checkGeneration);
                checkGeneration();
                signal.throwIfAborted();
                if (typeof registration.binding !== "function")
                    throw new TypeError(`Control stream ${id} has an invalid binding.`);
                const running = (registration.binding as ControlStreamBinding)(
                    {
                        send: async (message) => {
                            signal.throwIfAborted();
                            await stream.send(message);
                        },
                        close: async (payload) => await stream.close(payload),
                    },
                    { ...(request.payload === undefined ? {} : { payload: request.payload }) },
                    {
                        destination: context.host,
                        peer: context.peer,
                        requestId: context.requestId,
                        signal,
                        ...(context.protocolVersion === undefined ? {} : { protocolVersion: context.protocolVersion }),
                        ...(context.subject === undefined ? {} : { subject: { ...context.subject } }),
                    },
                );
                admitted();
                await running;
                await stream.close();
            } catch (error) {
                if (lease === undefined && !signal.aborted) rejectAdmission(error);
                else if (signal.aborted) await stream.close();
                else await stream.cancel(toRemoteErrorBody(error) ?? { message: String(error) });
            } finally {
                offChange?.();
                this.#activeStreams.delete(active);
                lease?.release();
                admitted();
            }
        });
        void active.done.catch((error: unknown) => console.error("Extension stream cleanup failed.", error));
        await admission;
    }

    #acquireStreamRegistration(
        id: string,
        signal: AbortSignal,
    ): Promise<ExtensionRegistrationLease | undefined> {
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener("abort", onAbort);
                resolve(undefined);
            };
            if (signal.aborted) resolve(undefined);
            else signal.addEventListener("abort", onAbort, { once: true });
            void this.#extensions.acquireRegistration(streams.id, id).then(
                (acquired) => {
                    signal.removeEventListener("abort", onAbort);
                    if (signal.aborted) {
                        acquired.lease.release();
                        resolve(undefined);
                    } else {
                        resolve(acquired);
                    }
                },
                (error: unknown) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                },
            );
        });
    }

    async #invoke(
        id: string,
        request: { payload?: JsonValue; seq?: number },
        context: ControlPortContext,
    ): Promise<JsonValue | undefined> {
        const { lease, registration } =
            await this.#extensions.acquireRegistration(routes.id, id);
        try {
            if (typeof registration.binding !== "function") {
                throw new TypeError(
                    `Control route ${id} has an invalid binding.`,
                );
            }
            return (await (registration.binding as ControlRouteBinding)(
                Object.freeze({
                    ...(request.payload === undefined
                        ? {}
                        : {
                              payload: request.payload as unknown as import("@portable-devshell/extension").ExtensionJsonValue,
                          }),
                    ...(request.seq === undefined ? {} : { seq: request.seq }),
                }),
                Object.freeze({
                    destination: context.host,
                    peer: context.peer,
                    ...(context.protocolVersion === undefined
                        ? {}
                        : { protocolVersion: context.protocolVersion }),
                    requestId: context.requestId,
                    signal: context.signal,
                    ...(context.subject === undefined
                        ? {}
                        : { subject: { ...context.subject } }),
                }),
            )) as JsonValue | undefined;
        } finally {
            lease.release();
        }
    }
}
