import type { JsonValue } from "@portable-devshell/shared";

import type { ControlConfig } from "../config/codec/ConfigTomlCodec.js";
import { cloneApprovalPolicy, cloneToolsConfig, resolveSecurityMode } from "./ConfigEditorValue.js";

export function toConfigView(config: ControlConfig): Record<string, JsonValue> {
    return {
        control: {
            logLevel: config.control.logLevel
        },
        instances: config.instances.map((instance) => ({
            ...(instance.approvalPolicy === undefined
                ? {}
                : {
                      approvalPolicy: cloneApprovalPolicy(instance.approvalPolicy)
                  }),
            ...(instance.container === undefined ? {} : { container: instance.container }),
            ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
            enabled: instance.enabled,
            ...(instance.env === undefined ? {} : { env: { ...instance.env } }),
            ...(instance.logs === undefined ? {} : { logs: { ...instance.logs } }),
            ...(instance.tools === undefined ? {} : { tools: cloneToolsConfig(instance.tools) }),
            mcp: {
                enabled: instance.mcp.enabled,
                ...(instance.mcp.path === undefined ? {} : { path: instance.mcp.path }),
                tools: {
                    capabilities: [...instance.mcp.tools.capabilities],
                    groups: [...instance.mcp.tools.groups]
                }
            },
            name: instance.name,
            ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
            provider: instance.provider,
            security: {
                effectiveMode: resolveSecurityMode(instance.security?.mode),
                mode: resolveSecurityMode(instance.security?.mode)
            },
            ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
            ...(instance.workspace === undefined ? {} : { workspace: instance.workspace })
        })),
        mcp: {
            auth: {
                mode: config.mcp.auth.mode,
                ...(config.mcp.auth.oauth2 === undefined ? {} : { oauth2: { ...config.mcp.auth.oauth2 } })
            },
            enabled: config.mcp.enabled,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            ...(config.mcp.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.mcp.publicBaseUrl })
        },
        version: config.version
    } as unknown as Record<string, JsonValue>;
}
