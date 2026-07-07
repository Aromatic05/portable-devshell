declare const workspacePathBrand: unique symbol;

export type WorkspacePath = string & {
    readonly [workspacePathBrand]: "WorkspacePath";
};

export function asWorkspacePath(value: string): WorkspacePath {
    return value as WorkspacePath;
}
