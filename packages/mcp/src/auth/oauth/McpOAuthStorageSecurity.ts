import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_ACL_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "$path = $env:PORTABLE_DEVSHELL_OAUTH_SECURE_PATH",
    "$kind = $env:PORTABLE_DEVSHELL_OAUTH_SECURE_KIND",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "if ($null -eq $identity.User) { throw 'Current Windows identity has no SID.' }",
    "if ($kind -eq 'directory') {",
    "  $acl = [System.Security.AccessControl.DirectorySecurity]::new()",
    "  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "} elseif ($kind -eq 'file') {",
    "  $acl = [System.Security.AccessControl.FileSecurity]::new()",
    "  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None",
    "} else {",
    "  throw \"Unsupported ACL target kind: $kind\"",
    "}",
    "$acl.SetOwner($identity.User)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(",
    "  $identity.User,",
    "  [System.Security.AccessControl.FileSystemRights]::FullControl,",
    "  $inheritance,",
    "  [System.Security.AccessControl.PropagationFlags]::None,",
    "  [System.Security.AccessControl.AccessControlType]::Allow",
    ")",
    "$acl.AddAccessRule($rule)",
    "Set-Acl -LiteralPath $path -AclObject $acl",
].join("\n");

export interface McpOAuthStorageSecurity {
    secureStorage(path: string): Promise<void>;
}

export function createMcpOAuthStorageSecurity(
    platform: NodeJS.Platform = process.platform,
): McpOAuthStorageSecurity {
    return platform === "win32"
        ? new WindowsMcpOAuthStorageSecurity()
        : noOpMcpOAuthStorageSecurity;
}

const noOpMcpOAuthStorageSecurity: McpOAuthStorageSecurity = {
    async secureStorage() {},
};

class WindowsMcpOAuthStorageSecurity implements McpOAuthStorageSecurity {
    async secureStorage(path: string): Promise<void> {
        await secureDirectoryTree(path);
    }
}

async function secureDirectoryTree(path: string): Promise<void> {
    await secureWindowsPath(path, "directory");
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) {
            throw new Error(`OAuth storage must not contain symbolic links: ${child}`);
        }
        if (entry.isDirectory()) {
            await secureDirectoryTree(child);
            continue;
        }
        if (entry.isFile()) {
            await secureWindowsPath(child, "file");
            continue;
        }
        throw new Error(`OAuth storage contains an unsupported filesystem entry: ${child}`);
    }
}

async function secureWindowsPath(path: string, kind: "directory" | "file"): Promise<void> {
    await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
        {
            env: {
                ...process.env,
                PORTABLE_DEVSHELL_OAUTH_SECURE_KIND: kind,
                PORTABLE_DEVSHELL_OAUTH_SECURE_PATH: path,
            },
            windowsHide: true,
        },
    );
}
