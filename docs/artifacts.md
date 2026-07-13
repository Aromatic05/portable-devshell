# Artifact sharing and transfer contract

Version: 1

## Tool surface

The MCP tool surface is fixed:

```text
artifact_read
artifact_share
artifact_transfer
```

`artifact_read` remains a worker tool and only reads stdout/stderr artifacts created by `bash_run`.

`artifact_share` and `artifact_transfer` are control-owned tools merged into the MCP endpoint catalog. Regular files, directories, share payloads, and transfer payloads never receive Artifact handles and never become readable through `artifact_read`.

## Artifact content and references

Artifact bytes are stored independently from the expiring handle that exposes them.

```text
ArtifactContent
  contentId
  bytes
  blake3
  referenceCount derived from persisted leases

ArtifactReference
  handle
  contentId
  expiresAt
  state: active | expired | revoked

ArtifactLease
  leaseId
  contentId
  ownerType: reference | share | transfer
  ownerId
  expiresAt
```

An expired or revoked Artifact reference becomes inaccessible immediately. `artifact_read` must reject it even if the content still exists. Physical content is removed only after every persisted lease is gone. Share and transfer tasks acquire their own leases atomically before returning success.

Reference counts are reconstructed from persisted leases after restart. A bare mutable counter is not authoritative.

## Sharing

`artifact_share` accepts exactly one source:

```text
handle
path
```

The source instance defaults to the current MCP endpoint instance. A share is created only after its payload is stable.

- stdout/stderr Artifact: acquire a content lease.
- regular file: create a reflink snapshot, falling back to a copy.
- directory: create one deterministic `.tar.zst` payload.

Shares have TTL and explicit revocation. Version 1 has no download-count limit.

The existing local MCP/OAuth HTTP listener also serves:

```text
GET  /artifacts/share/<token>
HEAD /artifacts/share/<token>
```

The listener remains local and is exposed through the same reverse proxy or tunnel as MCP/OAuth. Tokens are high-entropy capability URLs. Logs must not record complete tokens. Responses support HTTP Range, set `Cache-Control: private, no-store`, and set `Referrer-Policy: no-referrer`.

`HEAD` never changes share state. Revocation is available through control RPC, CLI, and TUI, not through a fourth MCP tool.

## Asynchronous transfer

`artifact_transfer` is asynchronous and supports three operations:

```text
start
status
cancel
```

`start` returns immediately with a transfer record in `queued` state. Transfer states are:

```text
queued
preparing
transferring
verifying
committing
completed
failed
cancelling
cancelled
interrupted
```

After a control restart:

- `queued` transfers remain queued and can be scheduled again.
- transfers that had started become `interrupted` and their temporary receive state is cleaned.
- terminal records remain terminal.
- an interrupted commit is recovered or rolled back from its commit journal before cleanup.

The transfer source lease is released only after the task reaches a terminal state.

## File transfer

A regular file is transferred byte-for-byte. User-owned archives such as `.zip`, `.tar.gz`, and `.zst` remain ordinary files and are never unpacked or recompressed.

The receiver writes to a temporary file in the target parent directory, verifies byte count and BLAKE3, calls `fsync`, renames into place, and syncs the parent directory.

## Directory payload

A directory is represented during sharing or transfer as a deterministic `.tar.zst` payload. Directory transfer restores a directory at the target path; it does not leave the archive there.

Allowed source members:

```text
regular files
directories
empty directories
hidden files and directories
```

Rejected members:

```text
symbolic links
device files
FIFO
Unix sockets
non-UTF-8 paths
tar hard-link entries
absolute paths
empty path components
. and .. components
```

Multiple source paths that reference the same inode are serialized as independent regular files.

Archive entries are relative to the source directory, use `/` separators, and are ordered by path bytes. The source directory name itself is not included.

Preserved metadata:

```text
regular permission bits, including executable bits
modification time rounded to seconds
empty directories
```

Discarded metadata:

```text
uid/gid and user/group names
setuid/setgid/sticky bits
ACL
xattr
platform-specific extended metadata
```

Sparse files are transferred as complete regular files in version 1.

Every directory payload has two independent checksums:

- `payloadBlake3`: checksum of the exact `.tar.zst` bytes.
- `manifestBlake3`: checksum of a canonical length-prefixed binary manifest of restored entries.

Each manifest entry contains entry type, relative path, mode, size, modification time, and file BLAKE3 for regular files. The receiver verifies both checksums before commit.

## Hidden `host` pseudo-instance

Only Artifact source and target resolution recognizes the exact string `host`. It is not a valid managed instance name, is not returned by instance discovery, is not described in MCP schemas, and has no MCP endpoint or lifecycle operations.

The user must explicitly tell an Agent to use `host`; the feature is not discoverable from tool descriptions. This knowledge boundary does not replace security enforcement.

### `host` as source

A path source with `instance = "host"` is read from the machine running the control server. Artifact handles cannot use `host` because handles belong to worker Artifact stores.

Host source access follows the effective existing `security.mode` and approval policy of the calling MCP endpoint:

- unrestricted mode adds no extra path restriction.
- restricted mode applies the configured read-path policy locally in Control.
- approval mode requires the existing approval flow.

All host source access is audited.

### `host` as target

A target with `targetInstance = "host"` is always redirected to the control user's `~/Download` directory.

`targetPath` only proposes the final basename. Parent components are discarded, and the final object is always a direct child of `~/Download`. Invalid basenames use the source default name.

The host receiver writes and extracts relative to an opened Download root, rejects final symlink targets, verifies content, and commits through temporary entries inside that root.

## Control RPC

Control exposes lifecycle operations for CLI/TUI:

```text
control.artifact.createShare
control.artifact.listShares
control.artifact.revokeShare
control.artifact.startTransfer
control.artifact.getTransfer
control.artifact.listTransfers
control.artifact.cancelTransfer
```

These operations do not add more MCP tools.
