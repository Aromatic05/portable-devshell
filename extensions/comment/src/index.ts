import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ExtensionError,
    type ExtensionContext,
    type ExtensionJsonValue,
} from "@portable-devshell/extension";
import type { ExtensionInstanceRuntimeCapability } from "@portable-devshell/extension/instance";
import {
    review,
    type ToolCallReviewBinding,
    type ToolCallReviewInvocation,
    type ToolCallReviewResult,
} from "@portable-devshell/extension/toolcall";
import type {
    ContextMessageReadResult,
    ContextMessageRecord,
    ConversationEntry,
    ConversationListInput,
    InstanceEventType,
    JsonValue,
    PrefixRouteModuleDefinition,
    ToolCallRecord,
} from "@portable-devshell/shared";

import {
    CommentService,
    createCommentRouteModule,
} from "./comment/CommentService.js";
import {
    ConversationService,
    createConversationRouteModule,
} from "./conversation/ConversationService.js";
import { createConversationPreferenceRouteModule } from "./conversation/preference/Route.js";
import { ConversationPreferenceStore } from "./conversation/preference/Store.js";
import { ConversationStore } from "./conversation/store/ConversationStore.js";
import { resolveToolCallFeedback } from "./hint/Feedback.js";
import { CommentReportService } from "./comment/report/Service.js";

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
        type: Extract<InstanceEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    conversationDatabaseFile: string;
    enabled: boolean;
    key: object;
    /**
     * @compat comment-legacy-migration-inputs
     * @removeAt 0.7.10
     */
    legacyContextMessagesFile?: string;
    legacyReports?: () => Promise<ToolCallRecord[]>;
    name: string;
}

export interface CommentInstanceSource {
    list(): readonly CommentExtensionInstance[];
    onChange(listener: () => void): () => void;
}

export interface CommentPort {
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
    feedback(input: ToolCallReviewInvocation): readonly string[];
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

export interface ConversationPort {
    list(
        instance: string,
        input?: ConversationListInput,
    ): Promise<ConversationEntry[]>;
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
    control(): readonly PrefixRouteModuleDefinition[];
    instance(instance: string): readonly PrefixRouteModuleDefinition[];
}

interface CommentExtensionInstanceState {
    readonly comment: CommentService;
    readonly conversation: ConversationService;
    enabled: boolean;
    readonly key: object;
    readonly report: CommentReportService;
    retirement?: Promise<void>;
}

export class CommentExtension {
    readonly comment: CommentPort;
    readonly conversation: ConversationPort;
    readonly routes: CommentRoutePort;
    readonly #instances = new Map<string, CommentExtensionInstanceState>();
    readonly #retirements = new Set<Promise<void>>();
    readonly #source: CommentInstanceSource;
    readonly #unsubscribe: () => void;

    constructor(options: {
        instances: CommentInstanceSource;
        preferencesFile: string;
    }) {
        this.#source = options.instances;
        const preferences = new ConversationPreferenceStore(
            options.preferencesFile,
        );
        const comment: CommentPort = {
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
            feedback: (input) => resolveToolCallFeedback(input),
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
        const conversation: ConversationPort = {
            list: async (instance, input = {}) =>
                await this.#require(instance).conversation.list(input),
            recordReport: async (instance, input) =>
                await this.#require(instance).conversation.recordReport(input),
        };
        this.conversation = Object.freeze(conversation);
        const routes: CommentRoutePort = {
            control: () => [
                createConversationPreferenceRouteModule(preferences),
            ],
            instance: (instance) => {
                const state = this.#instances.get(instance);
                return state === undefined || !state.enabled
                    ? []
                    : [
                          createCommentRouteModule({
                              list: async (input) =>
                                  await this.#require(instance).comment.list(
                                      input,
                                  ),
                              queue: async (input) =>
                                  await this.#require(instance).comment.queue(
                                      input,
                                  ),
                          }),
                          createConversationRouteModule({
                              list: async (input) =>
                                  await this.#require(
                                      instance,
                                  ).conversation.list(input),
                          }),
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
        const settled = await Promise.allSettled([...this.#retirements]);
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
            const store = new ConversationStore({
                filePath: instance.conversationDatabaseFile,
                instanceName: instance.name,
                ...(instance.legacyContextMessagesFile === undefined
                    ? {}
                    : {
                          legacyContextMessagesFile:
                              instance.legacyContextMessagesFile,
                      }),
            });
            const commentService = new CommentService({
                appendEvent: instance.appendEvent,
                instanceName: instance.name,
                store,
            });
            const conversationService = new ConversationService({
                instanceName: instance.name,
                legacyReports: instance.legacyReports,
                store,
            });
            const next: CommentExtensionInstanceState = {
                comment: commentService,
                conversation: conversationService,
                enabled: true,
                key: instance.key,
                report: new CommentReportService({
                    comment: commentService,
                    conversation: conversationService,
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
        const conversation = state.conversation.retire();
        const retirement = (async () => {
            const settled = await Promise.allSettled([comment, conversation]);
            const failures = settled
                .filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected",
                )
                .map((result) => result.reason);
            try {
                state.conversation.close();
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
    readonly source: BuiltinCommentInstanceSource;
}

let builtinRuntime: BuiltinCommentRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (builtinRuntime !== undefined)
        throw new Error("Comment Extension is already active.");
    const instanceRuntime = context.capabilities.instanceRuntime;
    if (instanceRuntime === undefined) {
        throw new Error(
            "Comment Extension requires the instanceRuntime capability.",
        );
    }
    const source = new BuiltinCommentInstanceSource(instanceRuntime);
    await source.refresh();
    const comment = new CommentExtension({
        instances: source,
        preferencesFile: legacyConversationPreferencesFile(
            context.paths.stateDirectory,
        ),
    });
    const binding = createCommentReview(comment.comment);
    context.register(review, "comment", async (input, invocation) => {
        await source.refresh();
        return await binding(input, invocation);
    });
    builtinRuntime = { comment, source };
}

export async function retireInstance(instance: string): Promise<void> {
    const runtime = builtinRuntime;
    if (runtime === undefined) return;
    await runtime.comment.retireInstance(
        instance,
        `Instance ${instance} was retired before Comment delivery.`,
    );
    await runtime.source.refresh(instance);
}

export async function deactivate(): Promise<void> {
    const runtime = builtinRuntime;
    builtinRuntime = undefined;
    await runtime?.comment.close();
}

export function createCommentReview(
    comment: Pick<
        CommentPort,
        | "beforeTodoToolCall"
        | "consumePending"
        | "feedback"
        | "recordTodoInvalid"
        | "reviewToolCall"
    >,
): ToolCallReviewBinding {
    return async (
        input: ToolCallReviewInvocation,
    ): Promise<ToolCallReviewResult> => {
        if (
            input.direction === "outbound" &&
            (input.kind === "result" || input.kind === "error")
        ) {
            if (
                input.kind === "error" &&
                input.toolName === "todo_write" &&
                input.context.ctxId !== undefined &&
                readToolErrorCode(input.payload) === "todo.invalid"
            ) {
                comment.recordTodoInvalid(
                    input.context.instance,
                    input.context.ctxId,
                );
            }
            const feedback = [...comment.feedback(input)];
            if (
                input.kind === "result" &&
                input.context.ctxId !== undefined &&
                input.callId !== undefined
            ) {
                const delivered = await comment.consumePending(
                    input.context.instance,
                    input.context.ctxId,
                    input.callId,
                );
                if (delivered.comment !== undefined)
                    feedback.unshift(delivered.comment);
            }
            const unique = [...new Set(feedback)];
            return {
                decision: "accept",
                ...(unique.length === 0 ? {} : { feedback: unique }),
            };
        }
        if (
            input.direction !== "inbound" ||
            input.kind !== "call" ||
            input.context.source !== "mcp" ||
            input.context.ctxId === undefined
        ) {
            return { decision: "accept" };
        }
        const decision = await comment.reviewToolCall(
            input.context.instance,
            input.context.ctxId,
            input.toolName,
            input.callId ?? input.context.requestId,
        );
        const result = reviewDecision(decision);
        if (result.decision === "accept") {
            await comment.beforeTodoToolCall(
                input.context.instance,
                input.context.ctxId,
                input.toolName,
            );
        }
        return result;
    };
}

class BuiltinCommentInstanceSource implements CommentInstanceSource {
    readonly #instanceRuntime: ExtensionInstanceRuntimeCapability;
    readonly #keys = new Map<string, object>();
    readonly #listeners = new Set<() => void>();
    #records: readonly { enabled: boolean; name: string }[] = [];

    constructor(instanceRuntime: ExtensionInstanceRuntimeCapability) {
        this.#instanceRuntime = instanceRuntime;
    }

    list(): readonly CommentExtensionInstance[] {
        const homeDirectory = resolveWorkerHomeDirectory();
        return this.#records.map((record) => {
            const root = join(
                homeDirectory,
                ".devshell",
                record.name,
                "control-worker",
            );
            return {
                appendEvent: async (type, data) =>
                    await this.#instanceRuntime.appendEvent(
                        record.name,
                        type,
                        data as unknown as ExtensionJsonValue,
                    ),
                conversationDatabaseFile: join(
                    root,
                    "conversation.sqlite3",
                ),
                enabled: record.enabled,
                key: this.#requireKey(record.name),
                legacyContextMessagesFile: join(
                    root,
                    "context-messages.json",
                ),
                legacyReports: async () =>
                    (await this.#instanceRuntime.readToolCalls(record.name, {
                        includeInput: true,
                        includeOutput: false,
                        toolName: "todo_report",
                    })) as unknown as ToolCallRecord[],
                name: record.name,
            };
        });
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async refresh(renewInstance?: string): Promise<void> {
        const next = [...(await this.#instanceRuntime.list())];
        const previousSignature = instanceSignature(this.#records);
        const nextNames = new Set(next.map((record) => record.name));
        for (const name of [...this.#keys.keys()]) {
            if (!nextNames.has(name)) this.#keys.delete(name);
        }
        if (
            renewInstance !== undefined &&
            nextNames.has(renewInstance)
        ) {
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
            return { decision: "accept" };
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

/**
 * @compat comment-control-storage-v1
 * @removeAt 0.7.10
 */
function legacyConversationPreferencesFile(stateDirectory: string): string {
    return resolve(stateDirectory, "../../..", "conversation-preferences.json");
}

/**
 * @compat comment-instance-storage-v1
 * @removeAt 0.7.10
 */
function resolveWorkerHomeDirectory(): string {
    const environment = process.env;
    const configured =
        process.platform === "win32"
            ? firstNonEmpty(
                  environment.USERPROFILE,
                  environment.HOMEDRIVE !== undefined &&
                      environment.HOMEPATH !== undefined
                      ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
                      : undefined,
                  environment.HOME,
              )
            : firstNonEmpty(environment.HOME, environment.USERPROFILE);
    const resolved = configured ?? homedir();
    if (resolved.length === 0)
        throw new Error("the current user home directory is unavailable");
    return resolved;
}

function firstNonEmpty(
    ...values: readonly (string | undefined)[]
): string | undefined {
    return values.find(
        (value): value is string => value !== undefined && value.length > 0,
    );
}

export function commentExtensionDirectory(): string {
    return dirname(fileURLToPath(import.meta.url));
}

function reportBackgroundError(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}
