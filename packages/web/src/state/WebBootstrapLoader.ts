import {
    CONTROL_PROTOCOL_VERSION,
    type InstanceListEntry,
    type OAuthApprovalRequest,
    type OperationalOverview,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { ApprovalDecisionGuard } from "./ApprovalDecisionGuard.js";
import {
    type InitialInstanceReadModels,
    InstanceReadModelCoordinator,
} from "./InstanceReadModelCoordinator.js";
import { withWebRequestTimeout } from "./WebRequestTimeout.js";

export interface WebBootstrapResult {
    instanceModels: InitialInstanceReadModels;
    instances: InstanceListEntry[];
    oauthApprovals: OAuthApprovalRequest[];
    overview?: OperationalOverview;
    partialFailures: Record<string, string>;
    service: { instanceCount: number; ok: boolean; pid?: number };
}

export class WebBootstrapLoader {
    constructor(
        private readonly clients: WebClients,
        private readonly instanceModels: InstanceReadModelCoordinator,
        private readonly approvalGuard: ApprovalDecisionGuard,
        private readonly timeoutMs: number,
    ) {}

    async load(): Promise<WebBootstrapResult> {
        const hello = await this.request(
            this.clients.service.hello(),
            "service.hello",
        );
        if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
            throw new Error(
                `Incompatible control protocol version: ${hello.protocolVersion}.`,
            );
        }
        const [service, instances] = await Promise.all([
            this.request(this.clients.service.status(), "service.status"),
            this.request(this.clients.instance.list(), "instance.list"),
        ]);
        const partialFailures: Record<string, string> = {};
        const [mcpStatus, overview] = await Promise.allSettled([
            this.request(this.clients.mcp.status(), "mcp.status"),
            this.request(this.clients.overview.get(), "overview"),
        ]);
        if (overview.status === "rejected") {
            partialFailures.overview = errorMessage(overview.reason);
        }
        const oauthApprovals = await this.loadOAuthApprovals(
            mcpStatus,
            partialFailures,
        );
        const instanceModels = await this.instanceModels.loadInitial(
            instances.map(({ name }) => name),
        );
        Object.assign(partialFailures, instanceModels.failures);
        return {
            instanceModels,
            instances,
            oauthApprovals,
            ...(overview.status === "fulfilled"
                ? { overview: overview.value }
                : {}),
            partialFailures,
            service,
        };
    }

    private async loadOAuthApprovals(
        status: PromiseSettledResult<{
            authMode?: "none" | "oauth2" | "token";
            oauthReady?: boolean;
            running: boolean;
        }>,
        partialFailures: Record<string, string>,
    ): Promise<OAuthApprovalRequest[]> {
        if (status.status === "rejected") {
            partialFailures.mcp = errorMessage(status.reason);
            return [];
        }
        if (
            status.value.authMode !== "oauth2" ||
            status.value.oauthReady !== true
        ) return [];
        try {
            return this.approvalGuard.filterOAuth(
                await this.request(
                    this.clients.mcp.listApprovals(),
                    "mcp.listApprovals",
                ),
            );
        } catch (error) {
            partialFailures.oauthApprovals = errorMessage(error);
            return [];
        }
    }

    private async request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withWebRequestTimeout(request, this.timeoutMs, label);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
