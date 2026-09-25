import { ControlConfigStore } from "./control/config/storage/Store.js";

export interface ControlMigrationResult {
    changed: boolean;
    domains: readonly string[];
}

export interface ControlMigrationOptions {
    homeDirectory?: string;
}

export async function migrateControlState(
    options: ControlMigrationOptions = {},
): Promise<ControlMigrationResult> {
    const config = await new ControlConfigStore().migrate(options.homeDirectory);
    return {
        changed: config.changed,
        domains: config.changed ? ["config"] : [],
    };
}
