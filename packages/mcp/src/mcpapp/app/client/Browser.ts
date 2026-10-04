import { McpAppRuntime } from "./Runtime.js";

export function mount(options: { version: string }): McpAppRuntime {
    const root = document.getElementById("root");
    const status = document.getElementById("status");
    if (!root || !status) throw new Error("MCP App DOM is incomplete");
    const runtime = new McpAppRuntime({ version: options.version, root, status });
    void runtime.start();
    window.addEventListener("beforeunload", () => { void runtime.destroy(); }, { once: true });
    return runtime;
}
