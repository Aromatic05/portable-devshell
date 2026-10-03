import type { ExtensionRemoveResult, ExtensionRuntimeRecord } from "@portable-devshell/shared";

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    install(sourcePath: string): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(id: string): Promise<void>;
    remove(id: string, purge: boolean): Promise<ExtensionRemoveResult>;
}
