import type {
    Channel,
    ControlClientKind,
    ControlPeerSubject,
} from "@portable-devshell/shared";

export interface ControlTransportAdmission {
    readonly allowedPeers: readonly ControlClientKind[];
    readonly subject: ControlPeerSubject;
}

export interface ControlAcceptedChannel {
    readonly admission: ControlTransportAdmission;
    readonly channel: Channel;
}

export interface ControlTransportListener {
    start(accept: (connection: ControlAcceptedChannel) => void): Promise<void>;
    close(): Promise<void>;
}
