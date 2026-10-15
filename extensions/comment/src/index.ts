import type { ExtensionDatabaseCapability } from "@portable-devshell/extension/database";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ExtensionError,
    type ExtensionContext,
    type ExtensionJsonValue,
} from "@portable-devshell/extension";
import {
    routes as controlRoutes,
    streams as controlStreams,
    type ControlRouteBinding,
    type ControlRouteScope,
} from "@portable-devshell/extension/control";
import type { ExtensionContextEnvironmentRetiredEvent } from "@portable-devshell/extension/context";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceGenerationRetiredEvent,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";
import {
    tools as mcpTools,
    type McpToolBinding,
} from "@portable-devshell/extension/mcp";
import {
    review,
    rewrite,
    type ToolCallReviewBinding,
    type ToolCallReviewInvocation,
    type ToolCallReviewResult,
    type ToolCallRewriteBinding,
    type ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";
import type {
    ContextMessageReadResult,
    ContextMessageRecord,
    MessageEntry,
    MessageListInput,
    JsonValue,
    ControlPortDefinition,
    MessageEventType,
} from "@portable-devshell/shared";

import {
    CommentService,
    createCommentRouteModule,
} from "./comment/CommentService.js";
import {
    MessageService,
    createMessageHistoryRouteModule,
} from "./message/MessageService.js";
import { createMessagePreferenceRouteModule } from "./message/preference/Route.js";
import { MessagePreferenceStore } from "./message/preference/Store.js";
import { MessageStore } from "./message/store/MessageStore.js";
import { migrateMessageDatabase } from "./message/migration/index.js";
import { createMessageSubscriptionBinding } from "./message/Route.js";
import { resolveToolCallHints } from "./hint/Resolver.js";
import { mergeComments } from "./comment/Merge.js";
import { CommentReportService } from "./comment/report/Service.js";
import { createMailingService, registerMailing, type MailingRuntime } from "./mailing/index.js";

export type CommentControlDecision =
    | { readonly kind: "allow" }
    | {
          readonly comment: string;
          readonly commentId: string;
          readonly kind: "push";
          readonly toolCallBudget: number;
      }
    | {
          readonly comment: string;
          readonly commentId: string;
          readonly kind: "resume";
      }
    | {
          readonly comment?: string;
          readonly commentId: string;
          readonly kind: "stop";
      };

export interface CommentExtensionInstance {
    appendEvent(
        type: Extract<MessageEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    messageDatabaseFile: string;
    enabled: boolean;
    key: object;
    name: string;
}

export interface CommentInstanceSource {
    list(): readonly CommentExtensionInstance[];
    onChange(listener: () => void): () => void;
}

export interface CommentPort {
    queue(instance: string, ctxId: string, text: string): Promise<void>;
    beforeTodoToolCall(
        instance: string,
        ctxId: string,
        toolName: string,
    ): Promise<void>;
    consumePending(
        instance: string,
        ctxId: string,
        callId: string,
    ): Promise<ContextMessageReadResult>;
    failPending(
        instance: string,
        ctxId: string,
        reason: string,
    ): Promise<ContextMessageRecord[]>;
    pendingReport(
        instance: string,
        ctxId: string,
    ): Promise<{
        push?: { commentId: string; message: string };
        replyCommentId?: string;
    }>;
    recordTodoInvalid(instance: string, ctxId: string): void;
    reportTodo(
        instance: string,
        ctxId: string,
        message: string,
        callId: string,
    ): Promise<void>;
    reviewToolCall(
        instance: string,
        ctxId: string,
        toolName: string,
        requestId?: string,
    ): Promise<CommentControlDecision>;
}

export interface MessageHistoryPort {
    list(instance: string, input?: MessageListInput): Promise<MessageEntry[]>;
    recordReport(
        instance: string,
        input: {
            callId: string;
            createdAt?: string;
            ctxId: string;
            push?: { commentId: string; message: string };
            replyCommentId?: string;
            text: string;
        },
    ): Promise<void>;
}

export interface CommentRoutePort {
    control(): readonly ControlPortDefinition[];
    instance(instance: string): readonly ControlPortDefinition[];
}

interface CommentExtensionInstanceState {
    readonly comment: CommentService;
    readonly messageHistory: MessageService;
    enabled: boolean;
    readonly key: object;
    readonly report: CommentReportService;
    retirement?: Promise<void>;
}

export class CommentExtension {
    readonly comment: CommentPort;
    readonly messageHistory: MessageHistoryPort;
    readonly routes: CommentRoutePort;
    readonly #database: ExtensionDatabaseCapability;
    readonly #preferences: MessagePreferenceStore;
    readonly #instances = new Map<string, CommentExtensionInstanceState>();
    readonly #retirements = new Set<Promise<void>>();
    readonly #source: CommentInstanceSource;
    readonly #unsubscribe: () => void;

    constructor(options: {
        instances: CommentInstanceSource;
        preferencesFile: string;
        database: ExtensionDatabaseCapability;
    }) {
        this.#source = options.instances;
        this.#database = options.database;
        const preferences = new MessagePreferenceStore(
            options.preferencesFile,
            options.database,
        );
        this.#preferences = preferences;
        const comment: CommentPort = {
            queue: async (instance, ctxId, text) => {
                await this.#require(instance).comment.queue({ ctxId, text });
            },
            beforeTodoToolCall: async (instance, ctxId, toolName) =>
                await this.#require(instance).report.beforeTodoToolCall(
                    ctxId,
                    toolName,
                ),
            consumePending: async (instance, ctxId, callId) =>
                await this.#require(instance).comment.consumePending(
                    ctxId,
                    callId,
                ),
            failPending: async (instance, ctxId, reason) =>
                await this.#require(instance).comment.failPending(
                    ctxId,
                    reason,
                ),
            pendingReport: async (instance, ctxId) =>
                await this.#require(instance).comment.pendingReport(ctxId),
            recordTodoInvalid: (instance, ctxId) =>
                this.#require(instance).report.recordTodoInvalid(ctxId),
            reportTodo: async (instance, ctxId, message, callId) =>
                await this.#require(instance).report.report(
                    ctxId,
                    message,
                    callId,
                ),
            reviewToolCall: async (instance, ctxId, toolName, requestId) =>
                await this.#require(instance).comment.reviewToolCall(
                    ctxId,
                    toolName,
                    requestId,
                ),
        };
        this.comment = Object.freeze(comment);
        const messageHistory: MessageHistoryPort = {
            list: async (instance, input = {}) =>
                await this.#require(instance).messageHistory.list(input),
            recordReport: async (instance, input) =>
                await this.#require(instance).messageHistory.recordReport(
                    input,
                ),
        };
        this.messageHistory = Object.freeze(messageHistory);
        const routes: CommentRoutePort = {
            control: () => [createMessagePreferenceRouteModule(preferences)],
            instance: (instance) => {
                const state = this.#instances.get(instance);
                if (state === undefined || !state.enabled) return [];
                const contextMessages = createCommentRouteModule({
                    list: async (input) =>
                        await this.#require(instance).comment.list(input),
                    queue: async (input) =>
                        await this.#require(instance).comment.queue(input),
                });
                const history = createMessageHistoryRouteModule({
                    list: async (input) =>
                        await this.#require(instance).messageHistory.list(
                            input,
                        ),
                });
                return [
                    {
                        name: "message",
                        operations: [
                            ...contextMessages.operations,
                            ...history.operations,
                        ],
                    },
                ];
            },
        };
        this.routes = Object.freeze(routes);
        this.#sync();
        this.#unsubscribe = this.#source.onChange(() => this.#sync());
    }

    async retireInstance(instance: string, reason: string): Promise<void> {
        const state = this.#instances.get(instance);
        if (state === undefined) return;
        state.enabled = false;
        if (this.#instances.get(instance) === state)
            this.#instances.delete(instance);
        await this.#retireState(state, reason);
    }

    async close(): Promise<void> {
        this.#unsubscribe();
        const states = [...this.#instances.values()];
        for (const state of states) state.enabled = false;
        this.#instances.clear();
        for (const state of states) this.#retireState(state);
        const settled = await Promise.allSettled([
            ...this.#retirements,
            this.#preferences.close(),
        ]);
        const failures = settled
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            )
            .map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(
                failures,
                "Comment shutdown was incomplete.",
            );
    }

    #sync(): void {
        const instances = this.#source.list();
        const names = new Set(instances.map((instance) => instance.name));
        for (const instance of instances) {
            const current = this.#instances.get(instance.name);
            if (current?.key === instance.key) {
                current.enabled = instance.enabled;
                continue;
            }
            if (!instance.enabled) {
                if (current !== undefined) current.enabled = false;
                continue;
            }
            const store = new MessageStore({
                filePath: instance.messageDatabaseFile,
                openDatabase: () =>
                    this.#database.open(
                        "instances/" +
                            encodeURIComponent(instance.name) +
                            "/message",
                    ),
                instanceName: instance.name,
            });
            const commentService = new CommentService({
                appendEvent: instance.appendEvent,
                instanceName: instance.name,
                store,
            });
            const messageService = new MessageService({
                instanceName: instance.name,
                store,
            });
            const next: CommentExtensionInstanceState = {
                comment: commentService,
                messageHistory: messageService,
                enabled: true,
                key: instance.key,
                report: new CommentReportService({
                    comment: commentService,
                    messageHistory: messageService,
                }),
            };
            this.#instances.set(instance.name, next);
            if (current !== undefined) {
                current.enabled = false;
                void this.#retireState(current).catch(reportBackgroundError);
            }
        }
        for (const name of [...this.#instances.keys()]) {
            if (names.has(name)) continue;
            const state = this.#instances.get(name);
            if (state !== undefined) state.enabled = false;
            void this.retireInstance(
                name,
                `Instance ${name} was removed before Comment delivery.`,
            ).catch(reportBackgroundError);
        }
    }

    #require(instance: string): CommentExtensionInstanceState {
        const state = this.#instances.get(instance);
        if (state !== undefined && state.enabled) return state;
        throw new ExtensionError({
            code: "control.instanceNotFound",
            details: { instance },
            message: `Instance ${instance} was not found or is disabled.`,
            retryable: false,
        });
    }

    #retireState(
        state: CommentExtensionInstanceState,
        reason?: string,
    ): Promise<void> {
        if (state.retirement !== undefined) return state.retirement;
        state.enabled = false;
        const comment = state.comment.retire(reason);
        const messageHistory = state.messageHistory.retire();
        const retirement = (async () => {
            const settled = await Promise.allSettled([comment, messageHistory]);
            const failures = settled
                .filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected",
                )
                .map((result) => result.reason);
            try {
                await state.messageHistory.close();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(
                    failures,
                    "Comment instance retirement was incomplete.",
                );
        })();
        state.retirement = retirement;
        this.#retirements.add(retirement);
        void retirement.then(
            () => this.#retirements.delete(retirement),
            () => this.#retirements.delete(retirement),
        );
        return retirement;
    }
}

interface BuiltinCommentRuntime {
    readonly comment: CommentExtension;
    readonly mailing: MailingRuntime;
    readonly source: BuiltinCommentInstanceSource;
}

let builtinRuntime: BuiltinCommentRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (builtinRuntime !== undefined)
        throw new Error("Comment Extension is already active.");
    const database = context.capabilities.database;
    if (database === undefined) {
        throw new Error("Comment Extension requires the database capability.");
    }
    const instanceObserve = context.capabilities.instanceObserve;
    if (instanceObserve === undefined) {
        throw new Error(
            "Comment Extension requires the instanceObserve capability.",
        );
    }
    const instanceEventPublish = context.capabilities.instanceEventPublish;
    if (instanceEventPublish === undefined) {
        throw new Error(
            "Comment Extension requires the instanceEventPublish capability.",
        );
    }
    const source = new BuiltinCommentInstanceSource(
        instanceObserve,
        instanceEventPublish,
        context.paths.dataDirectory,
    );
    await source.refresh();
    const comment = new CommentExtension({
        instances: source,
        database,
        preferencesFile: join(
            context.paths.stateDirectory,
            "message-preferences.json",
        ),
    });
    const mailing = createMailingService(context, {
        queue: async (instance, ctxId, text) => await comment.comment.queue(instance, ctxId, text),
    });
    const gate = createCommentToolCallGate(comment.comment);
    const todoAccess = createCommentTodoAccess(comment.comment);
    const delivery = createCommentDelivery(comment.comment);
    const advice = createCommentAdvice();
    const todoInvalid = createCommentTodoInvalid(comment.comment);
    context.register(review, "toolcall-gate", async (input, invocation) => {
        await source.refresh();
        return await gate(input, invocation);
    });
    context.register(rewrite, "todo-access", async (input, invocation) => {
        await source.refresh();
        return await todoAccess(input, invocation);
    });
    context.register(rewrite, "comment-delivery", async (input, invocation) => {
        await source.refresh();
        return await delivery(input, invocation);
    });
    context.register(rewrite, "tool-advice", async (input, invocation) => {
        await source.refresh();
        return await advice(input, invocation);
    });
    context.register(rewrite, "todo-invalid", async (input, invocation) => {
        await source.refresh();
        return await todoInvalid(input, invocation);
    });
    registerMailing(context, mailing);
    registerCommentRoutes(context, source, comment);
    context.register(
        mcpTools,
        "todo_report",
        createTodoReportTool(source, comment.comment),
    );
    builtinRuntime = { comment, mailing, source };
    // Resume pre-existing Context workspaces immediately; periodic polling
    // will also recover from temporarily unavailable Workers.
    void mailing.poll().catch((error) =>
        context.logger.warn("Initial Mailing reconciliation failed", {
            message: error instanceof Error ? error.message : String(error),
        }),
    );
}

export async function instanceGenerationRetired(
    event: ExtensionInstanceGenerationRetiredEvent,
): Promise<void> {
    const runtime = builtinRuntime;
    if (runtime === undefined) return;
    await runtime.mailing.retireInstance(event.instance);
    await runtime.comment.retireInstance(
        event.instance,
        `Instance ${event.instance} runtime generation was retired before Comment delivery.`,
    );
    await runtime.source.refresh(event.instance);
}

export async function contextEnvironmentRetired(
    input: ExtensionContextEnvironmentRetiredEvent,
): Promise<void> {
    const runtime = builtinRuntime;
    if (runtime === undefined) return;
    await runtime.mailing.retireContext(input.ctxId);
    await runtime.source.refresh();
    if (!runtime.source.has(input.instance)) return;
    await runtime.comment.comment.failPending(
        input.instance,
        input.ctxId,
        "Context " +
            input.ctxId +
            " was " +
            input.reason +
            " before Comment delivery.",
    );
}

export async function deactivate(): Promise<void> {
    const runtime = builtinRuntime;
    builtinRuntime = undefined;
    await runtime?.mailing.close();
    await runtime?.comment.close();
}

export function createCommentToolCallGate(
    comment: Pick<CommentPort, "reviewToolCall">,
): ToolCallReviewBinding {
    return async (
        input: ToolCallReviewInvocation,
    ): Promise<ToolCallReviewResult> => {
        if (
            input.direction !== "inbound" ||
            input.value.kind !== "call" ||
            input.value.context.source !== "mcp" ||
            input.value.context.ctxId === undefined
        ) {
            return { decision: "continue" };
        }
        const decision = await comment.reviewToolCall(
            input.value.context.instance,
            input.value.context.ctxId,
            input.value.toolName,
            input.callId,
        );
        return reviewDecision(decision);
    };
}

export function createCommentTodoAccess(
    comment: Pick<CommentPort, "beforeTodoToolCall">,
): ToolCallRewriteBinding {
    return async (input: ToolCallRewriteInvocation) => {
        if (
            input.direction !== "inbound" ||
            input.value.kind !== "call" ||
            input.value.context.source !== "mcp" ||
            input.value.context.ctxId === undefined
        ) {
            return input.value;
        }
        await comment.beforeTodoToolCall(
            input.value.context.instance,
            input.value.context.ctxId,
            input.value.toolName,
        );
        return input.value;
    };
}

export function createCommentDelivery(
    comment: Pick<CommentPort, "consumePending">,
): ToolCallRewriteBinding {
    return async (input: ToolCallRewriteInvocation) => {
        if (
            input.direction !== "outbound" ||
            input.value.kind !== "result" ||
            input.value.context.ctxId === undefined
        ) {
            return input.value;
        }
        const delivered = await comment.consumePending(
            input.value.context.instance,
            input.value.context.ctxId,
            input.callId,
        );
        return delivered.comment === undefined
            ? input.value
            : {
                  ...input.value,
                  payload: appendOutputComments(input.value.payload, [
                      delivered.comment,
                  ]),
              };
    };
}

export function createCommentAdvice(): ToolCallRewriteBinding {
    return (input: ToolCallRewriteInvocation) => {
        const comments = mergeComments([], resolveToolCallHints(input));
        return comments.length === 0
            ? input.value
            : {
                  ...input.value,
                  payload: appendOutputComments(input.value.payload, comments),
              };
    };
}

export function createCommentTodoInvalid(
    comment: Pick<CommentPort, "recordTodoInvalid">,
): ToolCallRewriteBinding {
    return (input: ToolCallRewriteInvocation) => {
        if (
            input.direction === "outbound" &&
            input.value.kind === "error" &&
            input.value.toolName === "todo_write" &&
            input.value.context.ctxId !== undefined &&
            readToolErrorCode(input.value.payload) === "todo.invalid"
        ) {
            comment.recordTodoInvalid(
                input.value.context.instance,
                input.value.context.ctxId,
            );
        }
        return input.value;
    };
}

function appendOutputComments(
    payload: ExtensionJsonValue,
    comments: readonly string[],
): ExtensionJsonValue {
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    ) {
        throw new TypeError(
            "ToolCall result must be an object when Comment delivery is pending.",
        );
    }
    const existing = Array.isArray(payload.comment)
        ? payload.comment.filter(
              (entry): entry is string =>
                  typeof entry === "string" && entry.length > 0,
          )
        : [];
    return {
        ...payload,
        comment: [...new Set([...existing, ...comments])],
    };
}

function registerCommentRoutes(
    context: ExtensionContext,
    source: BuiltinCommentInstanceSource,
    comment: CommentExtension,
): void {
    context.register(
        controlStreams,
        "message-subscribe",
        createMessageSubscriptionBinding(context.capabilities.instanceObserve!),
    );
    for (const route of [
        {
            id: "context-message-list",
            module: "message",
            operation: "listContextMessages",
            scope: "instance",
        },
        {
            id: "context-message-queue",
            module: "message",
            operation: "queueContextMessage",
            scope: "instance",
        },
        {
            id: "message-list",
            module: "message",
            operation: "listMessageEntries",
            scope: "instance",
        },
        {
            id: "message-preferences",
            module: "message",
            operation: "preferences",
            scope: "control",
        },
        {
            id: "message-update-preferences",
            module: "message",
            operation: "updatePreferences",
            scope: "control",
        },
    ] as const) {
        context.register(
            controlRoutes,
            route.id,
            createCommentRouteBinding(
                source,
                comment,
                context.capabilities.instanceObserve!,
                route,
            ),
        );
    }
}

function createCommentRouteBinding(
    source: BuiltinCommentInstanceSource,
    comment: CommentExtension,
    observe: Pick<ExtensionInstanceObserveCapability, "snapshot">,
    route: {
        readonly module: string;
        readonly operation: string;
        readonly scope: ControlRouteScope;
    },
): ControlRouteBinding {
    return async (request, invocation) => {
        await source.refresh();
        const modules =
            route.scope === "control"
                ? comment.routes.control()
                : comment.routes.instance(invocation.destination);
        const module = modules.find(
            (candidate) => candidate.name === route.module,
        );
        const operation = module?.operations.find(
            (candidate) => candidate.name === route.operation,
        );
        if (operation === undefined) {
            throw new ExtensionError({
                code: "control.methodNotFound",
                details: {
                    destination: invocation.destination,
                    module: route.module,
                    operation: route.operation,
                },
                message: `Comment route ${route.module}.${route.operation} is unavailable for ${invocation.destination}.`,
                retryable: false,
            });
        }
        // Capture the Instance event cursor before the database read. Events
        // committed during the read will be replayed by subscribers from
        // lastSeq + 1, so ViewModels cannot miss delivered Comments.
        const listOperation =
            route.operation === "listContextMessages" ||
            route.operation === "listMessageEntries";
        const lastSeq = listOperation
            ? (await observe.snapshot(invocation.destination)).lastSeq
            : undefined;
        const result = (await operation.handle(
            {
                id: invocation.requestId,
                name: route.operation,
                ...(request.payload === undefined
                    ? {}
                    : { payload: request.payload as unknown as JsonValue }),
                ...(request.seq === undefined ? {} : { seq: request.seq }),
            },
            undefined as never,
        )) as unknown as ExtensionJsonValue | undefined;
        if (lastSeq === undefined) return result;
        if (!Array.isArray(result)) {
            throw new ExtensionError({
                code: "control.invalidTarget",
                message: `Comment ${route.operation} returned a non-list result.`,
                retryable: false,
            });
        }
        return route.operation === "listContextMessages"
            ? { lastSeq, messages: result }
            : { entries: result, lastSeq };
    };
}

function createTodoReportTool(
    source: BuiltinCommentInstanceSource,
    comment: Pick<CommentPort, "reportTodo">,
): McpToolBinding {
    return async (input, invocation) => {
        await source.refresh();
        const ctxId = invocation.ctxId;
        if (ctxId === undefined || ctxId.length === 0) {
            throw new ExtensionError({
                code: "mcp.contextInvalid",
                message: "todo_report requires a validated ctxId.",
                retryable: false,
            });
        }
        const message = readTodoReportMessage(input);
        await comment.reportTodo(
            invocation.instance,
            ctxId,
            message,
            invocation.callId,
        );
        return {
            content: [{ text: message, type: "text" }],
            structuredContent: { reported: true },
        };
    };
}

const COMMENT_REPORT_MAX_TEXT_LENGTH = 4_000;

function readTodoReportMessage(input: ExtensionJsonValue): string {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw invalidTodoReportInput("todo_report requires an object input.");
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "message")
        throw invalidTodoReportInput("todo_report accepts only message.");
    const value = input.message;
    if (typeof value !== "string" || value.trim().length === 0)
        throw invalidTodoReportInput(
            "todo_report message must be a non-empty string.",
        );
    const message = value.trim();
    if (message.length > COMMENT_REPORT_MAX_TEXT_LENGTH)
        throw invalidTodoReportInput(
            "todo_report message must be at most " +
                COMMENT_REPORT_MAX_TEXT_LENGTH +
                " characters.",
        );
    return message;
}

function invalidTodoReportInput(message: string): ExtensionError {
    return new ExtensionError({
        code: "control.invalidTarget",
        message,
        retryable: false,
    });
}

class BuiltinCommentInstanceSource implements CommentInstanceSource {
    readonly #instanceObserve: ExtensionInstanceObserveCapability;
    readonly #instanceEventPublish: ExtensionInstanceEventPublishCapability;
    readonly #dataDirectory: string;
    readonly #prepared = new Set<string>();
    readonly #keys = new Map<string, object>();
    readonly #listeners = new Set<() => void>();
    #records: readonly { enabled: boolean; name: string }[] = [];

    constructor(
        instanceObserve: ExtensionInstanceObserveCapability,
        instanceEventPublish: ExtensionInstanceEventPublishCapability,
        dataDirectory: string,
    ) {
        this.#instanceObserve = instanceObserve;
        this.#instanceEventPublish = instanceEventPublish;
        this.#dataDirectory = dataDirectory;
    }

    list(): readonly CommentExtensionInstance[] {
        return this.#records.map((record) => {
            return {
                appendEvent: async (type, data) =>
                    await this.#instanceEventPublish.appendEvent(
                        record.name,
                        type,
                        data as unknown as ExtensionJsonValue,
                    ),
                messageDatabaseFile: join(
                    this.#dataDirectory,
                    "instances",
                    encodeURIComponent(record.name),
                    "message.sqlite3",
                ),
                enabled: record.enabled,
                key: this.#requireKey(record.name),
                name: record.name,
            };
        });
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    has(name: string): boolean {
        return this.#records.some((record) => record.name === name);
    }

    async refresh(renewInstance?: string): Promise<void> {
        const next = (await this.#instanceObserve.list()).map((record) => ({
            enabled: record.enabled,
            name: record.name,
        }));
        for (const record of next) {
            if (this.#prepared.has(record.name)) continue;
            await migrateMessageDatabase({
                instance: record.name,
                targetFile: join(
                    this.#dataDirectory,
                    "instances",
                    encodeURIComponent(record.name),
                    "message.sqlite3",
                ),
            });
            this.#prepared.add(record.name);
        }
        const previousSignature = instanceSignature(this.#records);
        const nextNames = new Set(next.map((record) => record.name));
        for (const name of [...this.#keys.keys()]) {
            if (!nextNames.has(name)) this.#keys.delete(name);
        }
        if (renewInstance !== undefined && nextNames.has(renewInstance)) {
            this.#keys.set(renewInstance, {});
        }
        for (const record of next) this.#requireKey(record.name);
        this.#records = next;
        if (
            renewInstance !== undefined ||
            previousSignature !== instanceSignature(next)
        ) {
            for (const listener of [...this.#listeners]) listener();
        }
    }

    #requireKey(name: string): object {
        let key = this.#keys.get(name);
        if (key === undefined) {
            key = {};
            this.#keys.set(name, key);
        }
        return key;
    }
}

function reviewDecision(
    decision: CommentControlDecision,
): ToolCallReviewResult {
    switch (decision.kind) {
        case "allow":
            return { decision: "continue" };
        case "push":
            return {
                decision: "reject",
                error: {
                    code: "control.modelReplyRequired",
                    details: {
                        commentId: decision.commentId,
                        toolCallBudget: decision.toolCallBudget,
                    },
                },
                reason: [
                    "#push response deadline reached.",
                    "You must reply to the user's #push message before using more tools.",
                    `#push message: ${decision.comment}`,
                    "Call todo_report with a direct response to the #push message above.",
                ].join("\n\n"),
            };
        case "resume":
            return {
                decision: "reject",
                error: {
                    code: "control.modelResumed",
                    details: { commentId: decision.commentId },
                },
                reason: `The user sent #resume. This tool was not executed. Read the Comment before deciding the next action: ${decision.comment}`,
            };
        case "stop":
            return {
                decision: "reject",
                error: {
                    code: "control.modelStopped",
                    details: { commentId: decision.commentId },
                },
                reason:
                    decision.comment === undefined
                        ? "Stopped by user. Tool calls are disabled until the user sends #resume."
                        : `Stopped by user. Tool calls are disabled until the user sends #resume. User Comment: ${decision.comment}`,
            };
    }
}

function readToolErrorCode(value: ExtensionJsonValue): string | undefined {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof value.error !== "object" ||
        value.error === null ||
        Array.isArray(value.error)
    ) {
        return undefined;
    }
    return typeof value.error.code === "string" ? value.error.code : undefined;
}

function instanceSignature(
    records: readonly { enabled: boolean; name: string }[],
): string {
    return records
        .map((record) => `${record.name}\u0000${record.enabled ? "1" : "0"}`)
        .join("\u0001");
}

export function commentExtensionDirectory(): string {
    return dirname(fileURLToPath(import.meta.url));
}

function reportBackgroundError(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}
