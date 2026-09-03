import type { DevshellPiWorkspaceBridge } from "@portable-devshell/pi-extension";

import type { PiSessionLike } from "./PiSdkLoader.js";

export interface ManagedPiAgentResources {
    devshell: DevshellPiWorkspaceBridge;
    session: PiSessionLike;
}

export interface PiGuiDetachLike {
    detach(session: PiSessionLike): void;
}

export async function disposeManagedPiAgent(
    active: ManagedPiAgentResources,
    gui: PiGuiDetachLike
): Promise<void> {
    await active.session.abort().catch(() => undefined);
    gui.detach(active.session);
    active.session.dispose();
    await active.devshell.close();
}
