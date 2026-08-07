import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ReverseCredentialStore, reverseRoute } from "../../src/testing.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const execFileAsync = promisify(execFile);

test("reverse device code is single-use and device token is stored in user-only files", async () => {
    const home = await createTestTempDirectory("devshell-reverse");
    const store = new ReverseCredentialStore(home);
    const code = await store.createDeviceCode("remote-test");

    assert.match(code.deviceCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    const credential = await store.consumeDeviceCode(code.deviceCode.toLowerCase());
    assert.equal(credential.instance, "remote-test");
    assert.equal(await store.authenticate("remote-test", credential.deviceToken), true);

    await assert.rejects(
        store.consumeDeviceCode(code.deviceCode),
        (error: unknown) => hasCode(error, "reverse.deviceCodeConsumed")
    );

    const record = await stat(join(home, ".devshell", "control", "reverse", "remote-test.json"));
    if (process.platform !== "win32") {
        assert.equal(record.mode & 0o777, 0o600);
    }
});

test("reverse credential writes fail closed when file security cannot be established", async () => {
    const home = await createTestTempDirectory("devshell-reverse-security-failure");
    const credentialPath = join(home, ".devshell", "control", "reverse", "remote-test.json");
    const store = new ReverseCredentialStore(home, {
        async secureDirectory() {
            throw new Error("injected credential security failure");
        },
        async secureFile() {},
    });

    await assert.rejects(
        store.createDeviceCode("remote-test"),
        /injected credential security failure/u,
    );
    await assert.rejects(
        stat(credentialPath),
        (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT",
    );
});

test(
    "reverse credentials use owner-only Windows DACLs",
    { skip: process.platform === "win32" ? false : "requires Windows DACL semantics" },
    async () => {
        const home = await createTestTempDirectory("devshell-reverse-windows-acl");
        const store = new ReverseCredentialStore(home);
        await store.createDeviceCode("remote-test");

        const directoryPath = join(home, ".devshell", "control", "reverse");
        const credentialPath = join(directoryPath, "remote-test.json");
        const directoryAcl = await readWindowsAcl(directoryPath);
        const fileAcl = await readWindowsAcl(credentialPath);

        assertOwnerOnlyAcl(directoryAcl);
        assertOwnerOnlyAcl(fileAcl);
        assert.match(directoryAcl.rules[0]?.inheritance ?? "", /ContainerInherit/u);
        assert.match(directoryAcl.rules[0]?.inheritance ?? "", /ObjectInherit/u);
        assert.equal(fileAcl.rules[0]?.inheritance, "None");
    },
);

test("issuing a replacement code keeps the old token valid until the code is consumed", async () => {
    const home = await createTestTempDirectory("devshell-reverse");
    const store = new ReverseCredentialStore(home);
    const firstCode = await store.createDeviceCode("remote-test");
    const first = await store.consumeDeviceCode(firstCode.deviceCode);

    const replacementCode = await store.createDeviceCode("remote-test");
    assert.equal(await store.authenticate("remote-test", first.deviceToken), true);

    const replacement = await store.consumeDeviceCode(replacementCode.deviceCode);
    assert.equal(await store.authenticate("remote-test", first.deviceToken), false);
    assert.equal(await store.authenticate("remote-test", replacement.deviceToken), true);
});

test("token rotation and revocation invalidate the previous credential", async () => {
    const home = await createTestTempDirectory("devshell-reverse");
    const store = new ReverseCredentialStore(home);
    const code = await store.createDeviceCode("remote-test");
    const first = await store.consumeDeviceCode(code.deviceCode);
    const rotated = await store.rotateToken("remote-test");

    assert.equal(await store.authenticate("remote-test", first.deviceToken), false);
    assert.equal(await store.authenticate("remote-test", rotated), true);

    await store.revoke("remote-test");
    assert.equal(await store.authenticate("remote-test", rotated), false);
});

test("reverse route follows the public base URL path", () => {
    assert.equal(reverseRoute("https://example.test", "/reverse/v1/connect"), "/reverse/v1/connect");
    assert.equal(
        reverseRoute("https://example.test/devshell/", "/reverse/v1/connect"),
        "/devshell/reverse/v1/connect"
    );
});

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

interface WindowsAclSnapshot {
    currentSid: string;
    ownerSid: string;
    protected: boolean;
    rules: Array<{
        identitySid: string;
        inheritance: string;
        inherited: boolean;
        rights: string;
        type: string;
    }>;
}

async function readWindowsAcl(path: string): Promise<WindowsAclSnapshot> {
    const script = [
        "$acl = Get-Acl -LiteralPath $env:PORTABLE_DEVSHELL_TEST_ACL_PATH",
        "$sidType = [System.Security.Principal.SecurityIdentifier]",
        "$rules = @($acl.Access | ForEach-Object {",
        "  [pscustomobject]@{",
        "    identitySid = $_.IdentityReference.Translate($sidType).Value",
        "    inheritance = $_.InheritanceFlags.ToString()",
        "    inherited = $_.IsInherited",
        "    rights = $_.FileSystemRights.ToString()",
        "    type = $_.AccessControlType.ToString()",
        "  }",
        "})",
        "[pscustomobject]@{",
        "  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "  ownerSid = $acl.GetOwner($sidType).Value",
        "  protected = $acl.AreAccessRulesProtected",
        "  rules = $rules",
        "} | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n");
    const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
            env: { ...process.env, PORTABLE_DEVSHELL_TEST_ACL_PATH: path },
            windowsHide: true,
        },
    );
    return JSON.parse(stdout) as WindowsAclSnapshot;
}

function assertOwnerOnlyAcl(snapshot: WindowsAclSnapshot): void {
    assert.equal(snapshot.protected, true);
    assert.equal(snapshot.ownerSid, snapshot.currentSid);
    assert.equal(snapshot.rules.length, 1);
    assert.equal(snapshot.rules[0]?.identitySid, snapshot.currentSid);
    assert.equal(snapshot.rules[0]?.type, "Allow");
    assert.match(snapshot.rules[0]?.rights ?? "", /FullControl/u);
    assert.equal(snapshot.rules[0]?.inherited, false);
}
