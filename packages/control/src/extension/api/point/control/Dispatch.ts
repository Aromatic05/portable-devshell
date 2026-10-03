import type {
    JsonValue,
    ControlPortContext,
    ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    routes,
    type ControlRouteBinding,
    type ControlRouteDeclaration,
    type ControlRouteScope,
} from "@portable-devshell/extension/control";

import { routeModule } from "../../../../server/Route.js";
import type { ExtensionHost } from "../../../host/Host.js";

export class ControlExtensionRouteService {
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
        return [...grouped.entries()]
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
    }

    onChange(listener: () => void): () => void {
        return this.#extensions.onChange(listener);
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
