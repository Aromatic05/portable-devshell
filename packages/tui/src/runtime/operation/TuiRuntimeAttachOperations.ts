import { TuiAttachShellCommandResolver } from "../attach/TuiAttachShellCommandResolver.js";
import { TuiAttachShellRunner, type TuiAttachShellSpawn } from "../attach/TuiAttachShellRunner.js";
import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiControlSession } from "../control/TuiControlSession.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";

export class TuiRuntimeAttachOperations {
    constructor(private readonly options: {
        attachHooks?: { resume(): void; suspend(): void };
        attachSpawn?: TuiAttachShellSpawn;
        clients: TuiClients;
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async attachShell(instance: string): Promise<void> {
        const entry = this.options.store.getState().instances.find((candidate) => candidate.name === instance);
        if (entry === undefined) {
            this.options.store.setScreenStatus(
                this.options.store.getState().ui.selectedPage,
                "Attach Shell failed: selected entry is unavailable."
            );
            return;
        }

        try {
            const command = new TuiAttachShellCommandResolver().resolve({
                configView: this.options.store.getState().configView,
                environment: process.env,
                instance: entry,
                snapshot: this.options.store.getState().snapshotsByInstance[instance]
            });
            await new TuiAttachShellRunner({
                hooks: {
                    resume: () => this.options.attachHooks?.resume(),
                    suspend: () => this.options.attachHooks?.suspend()
                },
                ...(this.options.attachSpawn === undefined
                    ? {}
                    : { spawn: this.options.attachSpawn })
            }).run(command);
        } catch (error) {
            this.options.store.setScreenStatus(
                this.options.store.getState().ui.selectedPage,
                `Attach Shell failed: ${readErrorMessage(error)}`
            );
            return;
        }

        try {
            const refreshed = await this.options.clients.runtime.refresh(instance);
            this.options.store.replaceSnapshot(refreshed.snapshot);
            await this.options.session.refreshInstance(instance);
            this.options.store.setScreenStatus(
                this.options.store.getState().ui.selectedPage,
                "Shell exited. Status refreshed from control."
            );
        } catch (error) {
            this.options.store.setScreenStatus(
                this.options.store.getState().ui.selectedPage,
                `Shell exited. Status refresh failed: ${readErrorMessage(error)}`
            );
        }
    }
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
