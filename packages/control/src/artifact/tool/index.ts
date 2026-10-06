import type { InstanceRegistry } from "../../instance/Registry.js";
import { presentToolCallResult } from "@portable-devshell/shared";
import type { JsonValue } from "@portable-devshell/shared";

import {
    type ToolCallDefinitionRegistration,
    type ToolCallRegistry,
} from "../../toolcall/Api.js";
import type { ArtifactImageApi } from "../Api.js";
import { artifactViewImageDefinition } from "./Definition.js";
import { readArtifactViewImageInput } from "./Input.js";

export function installArtifactTools(
    artifact: ArtifactImageApi,
    instances: InstanceRegistry,
    changes: { onChange(listener: () => void): () => void },
    hooks: ToolCallRegistry,
): () => void {
    const registrations = new Map<string, ToolCallDefinitionRegistration>();
    const definition = artifactViewImageDefinition();

    const sync = () => {
        const exposed = new Set(
            instances
                .list()
                .filter((instance) => instance.config.mcpEnabled)
                .map((instance) => instance.config.name),
        );
        for (const [instance, registration] of registrations) {
            if (exposed.has(instance)) continue;
            registration.dispose();
            registrations.delete(instance);
        }
        for (const instance of exposed) {
            if (registrations.has(instance)) continue;
            registrations.set(
                instance,
                hooks.register(instance, [definition]),
            );
        }
    };

    sync();
    const stopSync = changes.onChange(sync);
    const unregisterExecute = hooks.registerExecute(
        definition.name,
        async (_callId, input, value, signal) => {
            signal?.throwIfAborted();
            const image = await artifact.viewImage(
                readArtifactViewImageInput(input, value.context.workspace),
                value.context.instance,
                signal,
            );
            signal?.throwIfAborted();
            return presentToolCallResult(
                {
                    blake3: image.blake3,
                    bytes: image.bytes,
                    imageRef: image.imageRef,
                    mediaType: image.mediaType,
                    name: image.name,
                    source: image.source,
                } as unknown as JsonValue,
                {
                    content: [
                        {
                            data: image.content,
                            mediaType: image.mediaType,
                            type: "image",
                        },
                    ],
                },
            );
        },
    );

    return () => {
        unregisterExecute();
        stopSync();
        for (const registration of registrations.values()) registration.dispose();
        registrations.clear();
    };
}
