// Instance identity: the branded name used as the routing host for every
// instance-scoped port.

declare const instanceNameBrand: unique symbol;

export type InstanceName = string & {
    readonly [instanceNameBrand]: "InstanceName";
};

export function asInstanceName(value: string): InstanceName {
    return value as InstanceName;
}
