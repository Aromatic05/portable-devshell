// Container configuration vocabulary shared by Control config editing and
// instance creation. This is Control-owned because container settings are part
// of the control-plane instance definition, not worker runtime state.

export type InstanceContainerMode =
    | "preset"
    | "dockerfile"
    | "compose"
    | "existingImage"
    | "existingStoppedContainer";

export type InstanceContainerMountMode = "ro" | "rw";
export type InstanceContainerMountSelinuxMode = "private" | "shared";

export interface InstanceContainerMountConfig {
    mode: InstanceContainerMountMode;
    selinux?: InstanceContainerMountSelinuxMode;
    source: string;
    target: string;
}

export interface InstanceContainerPresetSchema {
    image: string;
    preset: string;
}

export interface InstanceContainerPresetConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "preset";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    preset: string;
    user?: string;
}

export interface InstanceContainerDockerfileConfig {
    build: {
        context: string;
        dockerfile?: string;
        tag?: string;
    };
    containerName: string;
    env?: Record<string, string>;
    mode: "dockerfile";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export interface InstanceContainerComposeConfig {
    compose: {
        file: string;
        projectName?: string;
        service: string;
    };
    mode: "compose";
}

export interface InstanceContainerExistingImageConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "existingImage";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export interface InstanceContainerExistingStoppedContainerConfig {
    adoptLifecycle?: boolean;
    containerName: string;
    mode: "existingStoppedContainer";
}

export type InstanceContainerConfig =
    | InstanceContainerPresetConfig
    | InstanceContainerDockerfileConfig
    | InstanceContainerComposeConfig
    | InstanceContainerExistingImageConfig
    | InstanceContainerExistingStoppedContainerConfig;

export interface InstanceManagedContainerDraft {
    containerName?: string;
    env?: Record<string, string>;
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export type InstanceContainerDraft =
    | (InstanceManagedContainerDraft & {
          image?: string;
          mode: "preset";
          preset: string;
      })
    | (InstanceManagedContainerDraft & {
          build: {
              context: string;
              dockerfile?: string;
              tag?: string;
          };
          mode: "dockerfile";
      })
    | {
          compose: {
              file: string;
              projectName?: string;
              service: string;
          };
          mode: "compose";
      }
    | (InstanceManagedContainerDraft & {
          image: string;
          mode: "existingImage";
      })
    | {
          adoptLifecycle?: boolean;
          containerName: string;
          mode: "existingStoppedContainer";
      };
