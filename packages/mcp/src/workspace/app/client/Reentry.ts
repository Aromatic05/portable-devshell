import type {
    WorkspaceReentryDirective,
    WorkspaceSnapshot,
} from "../../model/Contract.js";
import type { WorkspaceConnection } from "./Connection.js";
import type { WorkspaceHost } from "./Host.js";

export function directiveKey(directive: WorkspaceReentryDirective): string {
    return directive.id
        ? `id:${directive.id}`
        : JSON.stringify([
              directive.kind,
              directive.intent,
              directive.sourceId ?? "",
          ]);
}

export function pendingDirectives(
    snapshot: WorkspaceSnapshot,
    effect?: WorkspaceReentryDirective,
): WorkspaceReentryDirective[] {
    const combined = [...(snapshot.reentry.directives ?? [])];
    if (
        effect &&
        !combined.some((item) => item.id !== undefined && item.id === effect.id)
    )
        combined.push(effect);
    const seen = new Set<string>();
    return combined.filter((item) => {
        const key = directiveKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export class WorkspaceReentry {
    readonly #connection: WorkspaceConnection;
    readonly #host: WorkspaceHost;
    readonly #running = new Set<string>();
    readonly #attempted = new Set<string>();
    constructor(connection: WorkspaceConnection, host: WorkspaceHost) {
        this.#connection = connection;
        this.#host = host;
    }

    async deliver(
        directive: WorkspaceReentryDirective,
        refresh: () => Promise<WorkspaceSnapshot>,
    ): Promise<WorkspaceSnapshot> {
        const fence = this.#connection.fence();
        this.#connection.assertCurrent(fence);
        const key = directiveKey(directive);
        if (this.#running.has(key) || this.#attempted.has(key))
            return await refresh();
        this.#running.add(key);
        const claimId = directive.id
            ? "workspace-action-" + directive.id
            : "workspace-reentry-" + crypto.randomUUID();
        const directiveId = directive.id;
        let claimed = false;
        let attempted = false;
        let attemptSubmitted = false;
        let duplicateAttempt = false;
        let outcome: "accepted" | "rejected" | "uncertain" = "uncertain";
        try {
            const claim = await this.#connection.reentry(
                {
                    action: "claim",
                    claimId,
                    ...(directiveId ? { directiveId } : {}),
                    intent: directive.intent,
                    ...(directive.sourceId
                        ? { sourceId: directive.sourceId }
                        : {}),
                },
                undefined,
                fence,
            );
            if (claim.claimed !== true || !claim.delivery)
                return await refresh();
            claimed = true;
            const validation = await this.#connection.reentry(
                {
                    action: "validate",
                    claimId,
                    ...(directiveId ? { directiveId } : {}),
                },
                undefined,
                fence,
            );
            if (validation.valid !== true) return await refresh();
            this.#connection.assertCurrent(fence);
            await this.#host.updateModelContext(claim.delivery.modelContext);
            this.#connection.assertCurrent(fence);
            attemptSubmitted = true;
            const marked = await this.#connection.reentry(
                {
                    action: "attempt",
                    claimId,
                    ...(directiveId ? { directiveId } : {}),
                },
                undefined,
                fence,
            );
            if (marked.attempted !== true) {
                attemptSubmitted = false;
                if (marked.duplicate === true) {
                    claimed = false;
                    duplicateAttempt = true;
                }
                return await refresh();
            }
            attempted = true;
            attemptSubmitted = false;
            if (directive.id) this.#attempted.add(key);
            this.#connection.assertCurrent(fence);
            const result = await this.#host.sendMessage({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: String(claim.delivery.message ?? ""),
                    },
                ],
            });
            outcome = result?.isError ? "rejected" : "accepted";
            this.#connection.assertCurrent(fence);
        } catch {
            if (attempted || attemptSubmitted) {
                attempted = true;
                outcome = "uncertain";
                if (directive.id) this.#attempted.add(key);
            }
        } finally {
            if (claimed && !duplicateAttempt) {
                try {
                    if (attempted)
                        await this.#connection.reentry(
                            {
                                action: "report",
                                claimId,
                                ...(directiveId ? { directiveId } : {}),
                                outcome,
                            },
                            undefined,
                            fence,
                        );
                    else
                        await this.#connection.reentry(
                            {
                                action: "release",
                                claimId,
                                ...(directiveId ? { directiveId } : {}),
                            },
                            undefined,
                            fence,
                        );
                } catch {}
            }
            this.#running.delete(key);
        }
        return await refresh();
    }
}
