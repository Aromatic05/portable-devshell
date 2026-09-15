import { TuiRuntime, type TuiRuntimeOptions } from "./app/Runtime.js";

export async function runTui(options: TuiRuntimeOptions = {}): Promise<void> {
    await new TuiRuntime(options).run();
}
