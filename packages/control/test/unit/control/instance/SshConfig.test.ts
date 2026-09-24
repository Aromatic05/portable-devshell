import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { discoverSshConfigHosts } from "../../../../src/control/instance/create/SshConfig.ts";

test("SSH config discovery lists concrete Host aliases and follows Include", async () => {
    const directory = await createTestTempDirectory("ssh-config-hosts");
    const includeDirectory = join(directory, "conf.d");
    const configPath = join(directory, "config");
    await mkdir(includeDirectory, { recursive: true });
    await writeFile(
        configPath,
        [
            "Host aromatic-server build-server",
            "    User aromatic",
            "Host *.internal !blocked",
            "Include conf.d/*.conf",
            "",
        ].join("\n"),
    );
    await writeFile(
        join(includeDirectory, "extra.conf"),
        ["Host gpu-box", "    HostName 10.0.0.8", ""].join("\n"),
    );

    try {
        assert.deepEqual(discoverSshConfigHosts(configPath), [
            "aromatic-server",
            "build-server",
            "gpu-box",
        ]);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
