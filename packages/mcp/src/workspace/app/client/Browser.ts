import { WorkspaceRuntime } from "./Runtime.js";

export function mount(options: { version: string }): WorkspaceRuntime {
    const root = document.getElementById("root");
    const status = document.getElementById("status");
    if (!root || !status) throw new Error("Workspace App DOM is incomplete");
    const runtime = new WorkspaceRuntime({ version: options.version, root, status });
    void runtime.start();
    window.addEventListener("beforeunload", () => { void runtime.destroy(); }, { once: true });
    return runtime;
}
