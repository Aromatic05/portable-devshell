import type { ApprovalPolicy } from "@portable-devshell/shared";

import type { ControlInstanceConfig } from "../config/codec/ConfigTomlCodec.js";

export function resolveSecurityMode(mode: string | undefined): "disabled" | "workspace" {
    return mode === "workspace" ? "workspace" : "disabled";
}

export function cloneApprovalPolicy(policy: ApprovalPolicy): ApprovalPolicy {
    return {
        mode: policy.mode,
        rules: policy.rules?.map((rule) => ({ ...rule }))
    };
}

export function cloneInstanceConfig(instance: ControlInstanceConfig): ControlInstanceConfig {
    return {
        ...instance,
        approvalPolicy: instance.approvalPolicy === undefined ? undefined : cloneApprovalPolicy(instance.approvalPolicy),
        env: instance.env === undefined ? undefined : { ...instance.env },
        logs: instance.logs === undefined ? undefined : { ...instance.logs },
        mcp: {
            ...instance.mcp,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        security: instance.security === undefined ? undefined : { ...instance.security },
        ssh: instance.ssh === undefined ? undefined : { ...instance.ssh },
        tools: instance.tools === undefined ? undefined : cloneToolsConfig(instance.tools)
    };
}

export function cloneToolsConfig(tools: NonNullable<ControlInstanceConfig["tools"]>): NonNullable<ControlInstanceConfig["tools"]> {
    return {
        fileEdit: tools.fileEdit === undefined ? undefined : { ...tools.fileEdit },
        scheduler:
            tools.scheduler === undefined
                ? undefined
                : {
                      ...tools.scheduler,
                      byTool:
                          tools.scheduler.byTool === undefined
                              ? undefined
                              : Object.fromEntries(
                                    Object.entries(tools.scheduler.byTool).map(([toolName, limits]) => [toolName, { ...limits }])
                                )
                  }
    };
}
