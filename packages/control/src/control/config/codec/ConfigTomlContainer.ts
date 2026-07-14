import type {
    InstanceContainerComposeConfig,
    InstanceContainerConfig,
    InstanceContainerDockerfileConfig,
    InstanceContainerExistingImageConfig,
    InstanceContainerMountConfig,
    InstanceContainerPresetConfig
} from "@portable-devshell/shared";

import {
    asMountMode,
    asOptionalArray,
    asOptionalBoolean,
    asOptionalMountSelinuxMode,
    asOptionalRecord,
    asOptionalString,
    asRecord,
    asString,
    asStringRecord,
    assertNever,
    type TomlRecord,
    withoutUndefined
} from "./ConfigTomlValue.js";

export function encodeContainer(container: InstanceContainerConfig): TomlRecord {
    switch (container.mode) {
        case "preset":
            return {
                ...encodeManagedContainerFields(container),
                image: container.image,
                mode: container.mode,
                preset: container.preset
            };
        case "dockerfile":
            return {
                ...encodeManagedContainerFields(container),
                build: withoutUndefined(container.build),
                mode: container.mode
            };
        case "compose":
            return {
                compose: withoutUndefined(container.compose),
                mode: container.mode,
            };
        case "existingImage":
            return {
                ...encodeManagedContainerFields(container),
                image: container.image,
                mode: container.mode
            };
        case "existingStoppedContainer":
            return {
                ...(container.adoptLifecycle === undefined ? {} : { adoptLifecycle: container.adoptLifecycle }),
                containerName: container.containerName,
                mode: container.mode
            };
        default:
            return assertNever(container);
    }
}

export function parseContainerConfig(container: TomlRecord): InstanceContainerConfig {
    const mode = asString(container.mode, "container.mode");

    switch (mode) {
        case "preset":
            return {
                ...parseManagedContainerFields(container, "container"),
                image: asString((container as TomlRecord).image, "container.image"),
                mode,
                preset: asString((container as TomlRecord).preset, "container.preset")
            };
        case "dockerfile":
            return {
                ...parseManagedContainerFields(container, "container"),
                build: parseDockerfileBuildConfig(asRecord((container as TomlRecord).build, "container.build"), "container.build"),
                mode
            };
        case "compose":
            return {
                compose: parseComposeConfig(asRecord((container as TomlRecord).compose, "container.compose"), "container.compose"),
                mode,
            };
        case "existingImage":
            return {
                ...parseManagedContainerFields(container, "container"),
                image: asString((container as TomlRecord).image, "container.image"),
                mode
            };
        case "existingStoppedContainer":
            return {
                adoptLifecycle: asOptionalBoolean(
                    (container as TomlRecord).adoptLifecycle,
                    "container.adoptLifecycle"
                ),
                containerName: asString(
                    (container as TomlRecord).containerName,
                    "container.containerName"
                ),
                mode
            };
        default:
            throw new Error("container.mode must be one of preset, dockerfile, compose, existingImage, existingStoppedContainer");
    }
}

function encodeManagedContainerFields(
    container: InstanceContainerPresetConfig | InstanceContainerDockerfileConfig | InstanceContainerExistingImageConfig
): TomlRecord {
    return {
        containerName: container.containerName,
        ...(container.env === undefined || Object.keys(container.env).length === 0 ? {} : { env: container.env }),
        ...(container.mounts === undefined || container.mounts.length === 0 ? {} : { mounts: container.mounts.map(encodeMount) }),
        ...(container.network === undefined ? {} : { network: container.network }),
        ...(container.user === undefined ? {} : { user: container.user })
    };
}

function encodeMount(mount: InstanceContainerMountConfig): TomlRecord {
    return {
        mode: mount.mode,
        ...(mount.selinux === undefined ? {} : { selinux: mount.selinux }),
        source: mount.source,
        target: mount.target
    };
}

function parseManagedContainerFields(
    container: TomlRecord,
    fieldName: string
): Pick<InstanceContainerPresetConfig, "containerName" | "env" | "mounts" | "network" | "user"> {
    const env = asOptionalRecord(container.env, `${fieldName}.env`);
    const mounts = asOptionalArray(container.mounts, `${fieldName}.mounts`);

    return {
        containerName: asString(container.containerName, `${fieldName}.containerName`),
        env: env === undefined ? undefined : asStringRecord(env, `${fieldName}.env`),
        mounts: mounts === undefined ? undefined : mounts.map((entry, index) => parseMount(entry, `${fieldName}.mounts[${index}]`)),
        network: asOptionalString(container.network, `${fieldName}.network`),
        user: asOptionalString(container.user, `${fieldName}.user`)
    };
}

function parseDockerfileBuildConfig(container: TomlRecord, fieldName: string): InstanceContainerDockerfileConfig["build"] {
    return {
        context: asString(container.context, `${fieldName}.context`),
        dockerfile: asOptionalString(container.dockerfile, `${fieldName}.dockerfile`),
        tag: asOptionalString(container.tag, `${fieldName}.tag`)
    };
}

function parseComposeConfig(container: TomlRecord, fieldName: string): InstanceContainerComposeConfig["compose"] {
    return {
        file: asString(container.file, `${fieldName}.file`),
        projectName: asOptionalString(container.projectName, `${fieldName}.projectName`),
        service: asString(container.service, `${fieldName}.service`)
    };
}

function parseMount(mount: unknown, fieldName: string): InstanceContainerMountConfig {
    const record = asRecord(mount, fieldName);

    return {
        mode: asMountMode(asString(record.mode, `${fieldName}.mode`)),
        selinux: asOptionalMountSelinuxMode(record.selinux, `${fieldName}.selinux`),
        source: asString(record.source, `${fieldName}.source`),
        target: asString(record.target, `${fieldName}.target`)
    };
}
