export function buildInspectScript(
    homeDirectory: string,
    targetKey: string,
    sha256: string,
    retentionDays: number,
): string {
    const installDirectory = `${homeDirectory}/.devshell/workers/${targetKey}/${sha256}`;
    const binaryPath = `${installDirectory}/devshell-worker`;
    const shaPath = `${installDirectory}/devshell-worker.sha256`;
    const symlinkPath = buildRemoteExecutablePath(homeDirectory);
    const symlinkTarget = `../workers/${targetKey}/${sha256}/devshell-worker`;
    const workerRoot = `${homeDirectory}/.devshell/workers/${targetKey}`;

    return [
        "set -eu",
        `install_dir=${shellEscape(installDirectory)}`,
        `binary_path=${shellEscape(binaryPath)}`,
        `sha_path=${shellEscape(shaPath)}`,
        `symlink_path=${shellEscape(symlinkPath)}`,
        `symlink_target=${shellEscape(symlinkTarget)}`,
        `expected_sha=${shellEscape(sha256)}`,
        hashFunctionScript(),
        'installed_sha=""',
        'actual_sha=""',
        'if [ -f "$sha_path" ]; then installed_sha="$(cat "$sha_path")"; fi',
        'if [ -f "$binary_path" ]; then actual_sha="$(sha256_file "$binary_path")"; fi',
        'if [ "$installed_sha" = "$expected_sha" ] && [ "$actual_sha" = "$expected_sha" ]; then',
        '  touch "$install_dir" 2>/dev/null || true',
        '  mkdir -p "$(dirname "$symlink_path")"',
        '  alias_tmp="${symlink_path}.next.$$"',
        '  cleanup_alias() { rm -f "$alias_tmp"; }',
        "  trap cleanup_alias EXIT HUP INT TERM",
        '  ln -s "$symlink_target" "$alias_tmp"',
        '  mv -f "$alias_tmp" "$symlink_path"',
        ...workerGenerationGcScript(workerRoot, retentionDays),
        "  trap - EXIT HUP INT TERM",
        "  printf '%s' ready",
        "else",
        "  printf '%s' missing",
        "fi",
    ].join("\n");
}

export function buildInstallScript(
    homeDirectory: string,
    targetKey: string,
    sha256: string,
    retentionDays: number,
): string {
    const installDirectory = `${homeDirectory}/.devshell/workers/${targetKey}/${sha256}`;
    const binaryPath = `${installDirectory}/devshell-worker`;
    const shaPath = `${installDirectory}/devshell-worker.sha256`;
    const symlinkPath = buildRemoteExecutablePath(homeDirectory);
    const symlinkTarget = `../workers/${targetKey}/${sha256}/devshell-worker`;
    const workerRoot = `${homeDirectory}/.devshell/workers/${targetKey}`;

    return [
        "set -eu",
        `install_dir=${shellEscape(installDirectory)}`,
        `binary_path=${shellEscape(binaryPath)}`,
        `sha_path=${shellEscape(shaPath)}`,
        `symlink_path=${shellEscape(symlinkPath)}`,
        `symlink_target=${shellEscape(symlinkTarget)}`,
        `expected_sha=${shellEscape(sha256)}`,
        hashFunctionScript(),
        'tmp_binary_path="${binary_path}.tmp.$$"',
        'tmp_sha_path="${sha_path}.tmp.$$"',
        'alias_tmp="${symlink_path}.next.$$"',
        'cleanup() { rm -f "$tmp_binary_path" "$tmp_sha_path" "$alias_tmp"; }',
        "trap cleanup EXIT HUP INT TERM",
        'mkdir -p "$install_dir" "$(dirname "$symlink_path")"',
        'cat > "$tmp_binary_path"',
        'chmod 755 "$tmp_binary_path"',
        'actual_sha="$(sha256_file "$tmp_binary_path")"',
        'if [ "$actual_sha" != "$expected_sha" ]; then',
        '  printf \'worker bundle checksum mismatch: expected %s, got %s\\n\' "$expected_sha" "$actual_sha" >&2',
        "  exit 1",
        "fi",
        'printf \'%s\\n\' "$expected_sha" > "$tmp_sha_path"',
        'mv "$tmp_binary_path" "$binary_path"',
        'mv "$tmp_sha_path" "$sha_path"',
        'touch "$install_dir" 2>/dev/null || true',
        'ln -s "$symlink_target" "$alias_tmp"',
        'mv -f "$alias_tmp" "$symlink_path"',
        ...workerGenerationGcScript(workerRoot, retentionDays),
        "trap - EXIT HUP INT TERM",
    ].join("\n");
}

function workerGenerationGcScript(workerRoot: string, retentionDays: number): string[] {
    return [
        `worker_root=${shellEscape(workerRoot)}`,
        'if [ -d "$worker_root" ]; then',
        '  for generation in "$worker_root"/*; do',
        '    [ -L "$generation" ] && continue',
        '    [ -d "$generation" ] || continue',
        '    generation_name="${generation##*/}"',
        '    [ "$generation_name" = "$expected_sha" ] && continue',
        '    [ "${#generation_name}" -eq 64 ] || continue',
        '    case "$generation_name" in *[!0-9a-f]*) continue ;; esac',
        `    if [ -n "$(find "$generation" -prune -mtime +${retentionDays - 1} -print 2>/dev/null)" ]; then`,
        '      rm -rf "$generation" 2>/dev/null || true',
        "    fi",
        "  done",
        "fi",
    ];
}

function hashFunctionScript(): string {
    return [
        "sha256_file() {",
        "  if command -v sha256sum >/dev/null 2>&1; then",
        "    sha256sum \"$1\" | awk '{print $1}'",
        "  elif command -v shasum >/dev/null 2>&1; then",
        "    shasum -a 256 \"$1\" | awk '{print $1}'",
        "  elif command -v openssl >/dev/null 2>&1; then",
        "    openssl dgst -sha256 \"$1\" | awk '{print $NF}'",
        "  else",
        "    printf 'no SHA-256 implementation is available\\n' >&2",
        "    return 127",
        "  fi",
        "}",
    ].join("\n");
}

export function buildRemoteExecutablePath(homeDirectory: string): string {
    return `${homeDirectory}/.devshell/bin/devshell-worker`;
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
