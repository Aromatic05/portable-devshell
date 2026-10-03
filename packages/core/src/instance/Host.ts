import {
    asInstanceName,
    type ControlHostDefinition,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../approval/Route.js";
import { createMessageRouteModule } from "../message/Route.js";
import { createProcessRouteModule } from "../process/Route.js";
import { ProcessSubscriptionManager } from "../process/Subscription.js";
import { createGoalTaskRouteModule } from "../task/goal/Route.js";
import { createTodoTaskRouteModule } from "../task/todo/Route.js";
import { createTerminalRouteModule } from "../terminal/Route.js";
import { TerminalSessionService } from "../terminal/Service.js";
import {
    createToolIngressRouteModule,
    createToolRouteModule,
    type ToolCallIngressPort,
} from "../tool/Route.js";
import type { ToolCallProvenanceStore } from "../tool/Provenance.js";
import type { InstanceDescriptor } from "./Descriptor.js";
import type { InstanceRegistry } from "./Registry.js";

export interface InstanceHostOptions {
    descriptor: InstanceDescriptor;
    extensionModules?: readonly ControlPortDefinition[];
    registry: InstanceRegistry;
    subscriptions: ProcessSubscriptionManager;
    terminalMaxUnackedBytes?: number;
    terminals: TerminalSessionService;
    toolCalls?: ToolCallIngressPort;
    toolProvenance?: ToolCallProvenanceStore;
}

export function createInstanceHost(
    options: InstanceHostOptions,
): ControlHostDefinition {
    const { descriptor } = options;
    const modules = mergePortDefinitionsByName([
        createProcessRouteModule(
            {
                enabled: descriptor.enabled,
                name: descriptor.name,
                todoSummaries: () => descriptor.todo.summaries(),
                worker: descriptor.worker,
            },
            options.registry,
            options.subscriptions,
        ),
        ...(options.extensionModules ?? []),
        createMessageRouteModule(descriptor, options.subscriptions),
        mergePortDefinitions(
            createGoalTaskRouteModule(descriptor),
            createTodoTaskRouteModule(descriptor, options.subscriptions),
        ),
        createApprovalRouteModule(descriptor, options.subscriptions),
        createToolRouteModule(
            descriptor,
            options.toolProvenance,
            options.toolCalls,
            options.subscriptions,
        ),
        ...(descriptor.terminal === undefined
            ? []
            : [
                  createTerminalRouteModule({
                      backend: descriptor.terminal,
                      instance: descriptor.name,
                      ...(options.terminalMaxUnackedBytes === undefined
                          ? {}
                          : {
                                maxUnackedBytes:
                                    options.terminalMaxUnackedBytes,
                            }),
                      sessions: options.terminals,
                  }),
              ]),
    ]);
    return {
        host: asInstanceName(descriptor.name),
        ports: fenceInstanceGeneration(modules, options.registry, descriptor),
    };
}

export function createInstanceToolIngressHost(
    ingress: ToolCallIngressPort,
): ControlHostDefinition {
    return {
        host: "*",
        ports: [createToolIngressRouteModule(ingress)],
    };
}

function mergePortDefinitions(
    ...definitions: readonly ControlPortDefinition[]
): ControlPortDefinition {
    const first = definitions[0];
    if (first === undefined)
        throw new Error("Cannot merge an empty port list.");
    if (definitions.some((definition) => definition.name !== first.name))
        throw new Error("Cannot merge ports with different names.");
    const operations = definitions.flatMap(
        (definition) => definition.operations,
    );
    const streams = definitions.flatMap(
        (definition) => definition.streams ?? [],
    );
    const names = new Set<string>();
    for (const operation of [...operations, ...streams]) {
        if (names.has(operation.name))
            throw new Error(
                `Duplicate ${first.name} operation: ${operation.name}`,
            );
        names.add(operation.name);
    }
    return {
        name: first.name,
        operations,
        ...(streams.length === 0 ? {} : { streams }),
    };
}

function mergePortDefinitionsByName(
    definitions: readonly ControlPortDefinition[],
): ControlPortDefinition[] {
    const groups = new Map<string, ControlPortDefinition[]>();
    for (const definition of definitions) {
        const group = groups.get(definition.name) ?? [];
        group.push(definition);
        groups.set(definition.name, group);
    }
    return [...groups.values()].map((group) => mergePortDefinitions(...group));
}

function fenceInstanceGeneration(
    modules: readonly ControlPortDefinition[],
    registry: InstanceRegistry,
    descriptor: InstanceDescriptor,
): ControlPortDefinition[] {
    return modules.map((module) => ({
        ...module,
        operations: module.operations.map((operation) => ({
            ...operation,
            handle: async (request, context) => {
                const generation = registry.acquireGeneration(
                    descriptor.name,
                    descriptor,
                );
                try {
                    return await operation.handle(request, context);
                } finally {
                    generation.release();
                }
            },
        })),
        ...(module.streams === undefined
            ? {}
            : {
                  streams: module.streams.map((operation) => ({
                      ...operation,
                      handle: async (stream, request, context) => {
                          const generation = registry.acquireGeneration(
                              descriptor.name,
                              descriptor,
                          );
                          try {
                              return await operation.handle(
                                  stream,
                                  request,
                                  context,
                              );
                          } finally {
                              generation.release();
                          }
                      },
                  })),
              }),
    }));
}
