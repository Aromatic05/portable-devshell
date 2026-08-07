import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_ACL_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "$path = $env:PORTABLE_DEVSHELL_SECURE_PATH",
    "$kind = $env:PORTABLE_DEVSHELL_SECURE_KIND",
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

export interface ReverseCredentialFileSecurity {
    secureDirectory(path: string): Promise<void>;
    secureFile(path: string): Promise<void>;
}

export function createReverseCredentialFileSecurity(
    platform: NodeJS.Platform = process.platform,
): ReverseCredentialFileSecurity {
    return platform === "win32"
        ? new WindowsReverseCredentialFileSecurity()
        : noOpReverseCredentialFileSecurity;
}

const noOpReverseCredentialFileSecurity: ReverseCredentialFileSecurity = {
    async secureDirectory() {},
    async secureFile() {},
};

class WindowsReverseCredentialFileSecurity implements ReverseCredentialFileSecurity {
    async secureDirectory(path: string): Promise<void> {
        await secureWindowsPath(path, "directory");
    }

    async secureFile(path: string): Promise<void> {
        await secureWindowsPath(path, "file");
    }
}

async function secureWindowsPath(path: string, kind: "directory" | "file"): Promise<void> {
    await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
        {
            env: {
                ...process.env,
                PORTABLE_DEVSHELL_SECURE_KIND: kind,
                PORTABLE_DEVSHELL_SECURE_PATH: path,
            },
            windowsHide: true,
        },
    );
}
