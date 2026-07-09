import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";
import { asInstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export interface ControlTargetControl {
    kind: "control";
}

export interface ControlTargetInstance {
    instance: InstanceName;
    kind: "instance";
}

export type ControlTarget = ControlTargetControl | ControlTargetInstance;

export function createControlTarget(): ControlTargetControl {
    return { kind: "control" };
}

export function createInstanceTarget(instance: string | InstanceName): ControlTargetInstance {
    return {
        instance: typeof instance === "string" ? asInstanceName(instance) : instance,
        kind: "instance"
    };
}
