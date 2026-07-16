import type { JsonValue } from "@portable-devshell/shared";

import type { AuditDatabase } from "../../audit/AuditDatabase.js";
import type { InstanceEventInput } from "../../instance/event/InstanceEventBuffer.js";
import type { WorkerProtocolClient } from "../protocol/WorkerProtocolClient.js";
import { toEventData } from "./WorkerInstanceEvent.js";

interface WorkerInstanceAuditOptions {
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    auditDatabase: AuditDatabase;
    isReady(): boolean;
    protocolClient: WorkerProtocolClient;
}

export class WorkerInstanceAudit {
    readonly #appendEvent: WorkerInstanceAuditOptions["appendEvent"];
    readonly #auditDatabase: AuditDatabase;
    readonly #isReady: WorkerInstanceAuditOptions["isReady"];
    readonly #protocolClient: WorkerProtocolClient;

    constructor(options: WorkerInstanceAuditOptions) {
        this.#appendEvent = options.appendEvent;
        this.#auditDatabase = options.auditDatabase;
        this.#isReady = options.isReady;
        this.#protocolClient = options.protocolClient;
    }

    async appendMcpSessionOpened(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionOpened", toEventData({ sessionId }));
    }

    async appendMcpSessionClosed(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionClosed", toEventData({ sessionId }));
    }

    async appendMcpToolCalled(toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void> {
        await this.#appendEvent(
            "mcp.toolCalled",
            toEventData({
                requestId: context.requestId,
                ctxId: context.ctxId,
                source: "mcp",
                toolName
            })
        );
    }

    async releaseToolSession(sessionId: string): Promise<void> {
        if (this.#isReady()) {
            await this.#protocolClient.closeToolSession(sessionId).catch(() => undefined);
        }
    }

    close(): void {
        this.#auditDatabase.close();
    }
}
