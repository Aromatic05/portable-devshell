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
        const { extensionId, lease, registration } = await this.#extensions.acquireRegistration(streams.id, id);
        const controller = new AbortController();
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const checkGeneration = () => {
            const current = this.#extensions.listDeclarations(streams.id).find((entry) => entry.id === id);
            if (current?.extensionId !== extensionId || current.generation !== lease.generation)
                controller.abort(new Error("Extension stream generation retired."));
        };
        const offChange = this.#extensions.onChange(checkGeneration);
        checkGeneration();
        const active = { instance: context.host, controller, done: Promise.resolve() };
        this.#activeStreams.add(active);
        // Own the stream lifetime here; the host route lease only covers admission.
        active.done = (async () => {
            try {
                signal.throwIfAborted();
                if (typeof registration.binding !== "function")
                    throw new TypeError(`Control stream ${id} has an invalid binding.`);
                await (registration.binding as ControlStreamBinding)(
                    {
                        send: async (message) => await stream.send(message),
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
                await stream.close();
            } catch (error) {
                if (signal.aborted) await stream.close();
                else await stream.cancel(toRemoteErrorBody(error) ?? { message: String(error) });
            } finally {
                offChange();
                this.#activeStreams.delete(active);
                lease.release();
            }
        })();
        void active.done.catch((error: unknown) => console.error("Extension stream cleanup failed.", error));
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
