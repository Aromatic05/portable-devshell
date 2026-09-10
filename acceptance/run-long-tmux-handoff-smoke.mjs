import { runTestspaceLongWaitSmoke } from "../scripts/testspace/TestspaceLongWaitSmoke.mjs";
import { createAcceptanceFixture, runCli } from "./AcceptanceSupport.mjs";

const fixture = await createAcceptanceFixture();
try {
    runCli(["start"], fixture.env);
    runCli(["instance", "start", "aromatic-pc"], fixture.env);
    const result = await runTestspaceLongWaitSmoke({
        endpoint: `http://127.0.0.1:${fixture.port}/aromatic-pc/mcp`,
        workspace: fixture.workspace,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
    await fixture.cleanup();
}
