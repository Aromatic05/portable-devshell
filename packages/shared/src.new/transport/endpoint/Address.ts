export type Host = string;
export type PortName = string;

export interface Address {
    readonly host: Host;
    readonly port: PortName;
}
