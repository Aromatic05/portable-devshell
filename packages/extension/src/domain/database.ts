/** SQL values are deliberately JSON-compatible across the Extension sandbox boundary. */
export type ExtensionSqlValue = string | number | null;

export interface ExtensionSqlCommand {
    readonly sql: string;
    readonly parameters?: readonly ExtensionSqlValue[];
    readonly mode: "all" | "exec" | "get" | "run";
}

export type ExtensionSqlRow = Record<string, ExtensionSqlValue>;

export interface ExtensionDatabaseConnection {
    all<T extends ExtensionSqlRow>(
        sql: string,
        parameters?: readonly ExtensionSqlValue[],
    ): Promise<T[]>;
    close(): Promise<void>;
    exec(sql: string): Promise<void>;
    get<T extends ExtensionSqlRow>(
        sql: string,
        parameters?: readonly ExtensionSqlValue[],
    ): Promise<T | undefined>;
    run(
        sql: string,
        parameters?: readonly ExtensionSqlValue[],
    ): Promise<number>;
    /**
     * An interactive transaction remains bound to one Host-owned connection.
     * Other commands on that connection wait until this callback completes.
     */
    transaction<T>(
        operation: (connection: ExtensionDatabaseConnection) => Promise<T>,
    ): Promise<T>;
}

export interface ExtensionDatabaseCapability {
    /** Name relative to the owning Extension data directory, without a file extension. */
    open(name: string): Promise<ExtensionDatabaseConnection>;
}
