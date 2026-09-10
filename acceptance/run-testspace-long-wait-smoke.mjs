import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "./AcceptanceSupport.mjs";

const root = join(
    tmpdir(),
    `portable-devshell-long-wait-${process.pid}-${Date.now()}`,
);
const env = {
    ...process.env,
    DEVSHELL_TESTSPACE_ROOT: root,
};

let failure;
try {
    runCommand("pnpm", ["testspace", "--", "--skip-build"], {
        env,
        inherit: true,
        timeoutMs: 60_000,
    });
    runCommand("pnpm", ["testspace", "long-smoke"], {
        env,
        inherit: true,
        timeoutMs: 270_000,
    });
} catch (error) {
    failure = error;
} finally {
    try {
        runCommand("pnpm", ["testspace", "stop"], {
            env,
            inherit: true,
            timeoutMs: 30_000,
        });
    } catch (cleanupError) {
        if (failure !== undefined) {
            failure = new AggregateError(
                [failure, cleanupError],
                "Long tmux handoff smoke failed and Testspace cleanup also failed.",
            );
        } else {
            failure = cleanupError;
        }
    }
}

if (failure !== undefined) throw failure;
