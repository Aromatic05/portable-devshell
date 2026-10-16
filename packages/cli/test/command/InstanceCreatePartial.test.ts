import assert from "node:assert/strict";
import test from "node:test";

import type {
    ConnectionTransport,
    InstanceTransport,
} from "@portable-devshell/shared";
import { CliCommandInstanceCreate } from "../../src/command/instance/create/Command.js";
import { renderInstanceCreateResult } from "../../src/command/instance/create/Render.js";
import type { CliWizardInstanceCreate } from "../../src/command/instance/create/Wizard.js";

test("reverse create preserves the registered instance when code issuance fails", async () => {
    const created: string[] = [];
    const draft = { name: "reverse-partial", provider: "reverse" as const };
    const instanceClient = {
        async createInstanceSchema() {
            return {};
        },
        async createInstance(request: typeof draft) {
            created.push(request.name);
            return { enabled: true, name: request.name };
        },
    } as unknown as InstanceTransport;
    const reverseClient = {
        async createCode() {
            throw new Error("enrollment service unavailable");
        },
    } as unknown as ConnectionTransport;
    const wizard = {
        async run() {
            return { draft, summary: {} };
        },
    } as unknown as CliWizardInstanceCreate;
    const result = await new CliCommandInstanceCreate().execute(
        instanceClient,
        reverseClient,
        wizard,
    );
    assert.deepEqual(created, ["reverse-partial"]);
    assert.equal(result?.name, "reverse-partial");
    assert.match(result?.enrollmentError ?? "", /service unavailable/u);
    assert.match(
        renderInstanceCreateResult(result!),
        /Recover with: devshell instance device-code reverse-partial/u,
    );
});
