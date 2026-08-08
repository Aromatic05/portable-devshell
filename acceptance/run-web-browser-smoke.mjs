import {
    resolveChromiumExecutable,
    runTestspaceWebSmoke,
} from "../scripts/testspace/TestspaceWebSmoke.mjs";
import { createAcceptanceFixture, runCli } from "./AcceptanceSupport.mjs";

const browserExecutable = resolveChromiumExecutable();
if (browserExecutable === undefined) {
    if (process.env.CI !== undefined || process.env.PORTABLE_DEVSHELL_REQUIRE_BROWSER === "1") {
        throw new Error(
            "Web browser smoke requires Chromium in CI. Set PORTABLE_DEVSHELL_CHROMIUM to its executable.",
        );
    }
    process.stdout.write(
        "Web browser smoke: skipped (Chromium unavailable; set PORTABLE_DEVSHELL_CHROMIUM to require it).\n",
    );
} else {
    const fixture = await createAcceptanceFixture();
    try {
        runCli(["start"], fixture.env);
        runCli(["instance", "start", "aromatic-pc"], fixture.env);
        const result = await runTestspaceWebSmoke({
            browserExecutable,
            exerciseLifecycle: true,
            expectedInstance: "aromatic-pc",
            webPort: fixture.webPort,
        });
        await waitForInstanceReady(fixture.env, "aromatic-pc");
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
        await fixture.cleanup();
    }
}

async function waitForInstanceReady(environment, instance, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus;
    while (Date.now() < deadline) {
        lastStatus = runCli(["instance", "status", instance], environment);
        if (/^status: ready$/mu.test(lastStatus.stdout)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Web lifecycle smoke did not restore the instance to ready.\n${lastStatus?.stdout ?? "No status response."}`,
    );
}
