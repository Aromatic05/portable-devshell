// Disposable first-start process. The gate is after the real private-file fsync,
// so every contender has generated a different complete key before publication.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { betaOAuth } from "../support/BetaOAuth.ts";
import { oauthJwksEvidence } from "../support/OAuthJwks.ts";

const [directory, phase] = process.argv.slice(2);
assert.ok(directory);
assert.ok(process.send);
const canonical = join(directory, "jwks.json");
const open = fs.open;
fs.open = async function (...args: Parameters<typeof open>) {
    const file = await open(...args);
    if (String(args[0]).startsWith(`${canonical}.`) && args[1] === "wx") {
        if (phase === "writing") {
            file.writeFile = async (data) => {
                await file.write(String(data).slice(0, 100));
                process.send!({ checkpoint: "writing" });
                await new Promise(() => {});
            };
        }
        const sync = file.sync.bind(file);
        file.sync = async () => {
            await sync();
            const resume = once(process, "message");
            process.send!({ checkpoint: "generated" });
            const [message] = await resume;
            assert.equal(message, "publish");
        };
    }
    return file;
};
const link = fs.link;
fs.link = async (...args: Parameters<typeof link>) => {
    await link(...args);
    if (phase === "linked") {
        process.send!({ checkpoint: "linked" });
        await new Promise(() => {});
    }
};
syncBuiltinESMExports();
const runtime = betaOAuth(directory);
await runtime.warmup();
process.send!({ checkpoint: "ready", evidence: await oauthJwksEvidence(runtime) });
process.disconnect();
