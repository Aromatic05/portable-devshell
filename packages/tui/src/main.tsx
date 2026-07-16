import { TuiRuntime, type TuiRuntimeOptions } from "./runtime/TuiRuntime.js";

export async function runTui(options: TuiRuntimeOptions = {}): Promise<void> {
    await new TuiRuntime(options).run();
}
