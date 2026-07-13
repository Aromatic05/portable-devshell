import type { ReverseDeviceCodeResult } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";

export class CliCommandInstanceDeviceCode {
    async execute(client: CliControlClientLike, instance: string): Promise<ReverseDeviceCodeResult> {
        return await client.createReverseDeviceCode(instance);
    }
}

export class CliCommandInstanceRotateToken {
    async execute(
        client: CliControlClientLike,
        instance: string
    ): Promise<{ deviceToken: string; instance: string }> {
        return await client.rotateReverseDeviceToken(instance);
    }
}

export class CliCommandInstanceRevokeToken {
    async execute(
        client: CliControlClientLike,
        instance: string
    ): Promise<{ instance: string; revoked: true }> {
        return await client.revokeReverseDeviceToken(instance);
    }
}
