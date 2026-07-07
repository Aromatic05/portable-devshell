import { CliMain } from "./cli/CliMain.js";

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
    return await new CliMain().run(argv);
}
