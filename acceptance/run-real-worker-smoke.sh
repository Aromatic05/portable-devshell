#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
worker_binary="$repo_root/target/debug/devshell-worker"
cli_entry="$repo_root/packages/cli/dist/cli/CliMain.js"
fixture_config="$repo_root/acceptance/fixtures/config.local.toml"
fixture_workspace="$repo_root/acceptance/fixtures/workspace"

if [ ! -x "$worker_binary" ]; then
    echo "building worker binary: $worker_binary" >&2
    cargo build --locked -p devshell-worker --manifest-path "$repo_root/Cargo.toml"
fi

if [ ! -x "$worker_binary" ]; then
    echo "missing worker binary after build: $worker_binary" >&2
    exit 1
fi

if [ ! -f "$cli_entry" ]; then
    echo "missing cli build output: $cli_entry" >&2
    exit 1
fi

tmp_home=$(mktemp -d)
tmp_runtime=$(mktemp -d)
tmp_workspace=$(mktemp -d)
tmp_bin=$(mktemp -d)
mcp_port=$(node <<'EOF'
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.exit(1);
  }

  process.stdout.write(String(address.port));
  server.close(() => process.exit(0));
});
server.on("error", () => process.exit(1));
EOF
)

cleanup() {
    PATH="$tmp_bin:$PATH" HOME="$tmp_home" XDG_RUNTIME_DIR="$tmp_runtime" devshell instance stop aromatic-pc >/dev/null 2>&1 || true
    PATH="$tmp_bin:$PATH" HOME="$tmp_home" XDG_RUNTIME_DIR="$tmp_runtime" devshell stop >/dev/null 2>&1 || true
    rm -rf "$tmp_home" "$tmp_runtime" "$tmp_workspace" "$tmp_bin"
}

trap cleanup EXIT INT TERM

cp "$fixture_workspace/README.md" "$tmp_workspace/README.md"
mkdir -p "$tmp_home/.devshell/control/instances"

WORKSPACE_PATH="$tmp_workspace" FIXTURE_CONFIG="$fixture_config" MCP_PORT="$mcp_port" OUTPUT_CONFIG="$tmp_home/.devshell/control/config.toml" node <<'EOF'
const { readFileSync, writeFileSync } = require("node:fs");
const fixture = readFileSync(process.env.FIXTURE_CONFIG, "utf8");
writeFileSync(
  process.env.OUTPUT_CONFIG,
  fixture
    .replace("__WORKSPACE__", process.env.WORKSPACE_PATH)
    .replace('listenPort = 17890', `listenPort = ${process.env.MCP_PORT}`)
    .replace('publicBaseUrl = "http://127.0.0.1:17890"', `publicBaseUrl = "http://127.0.0.1:${process.env.MCP_PORT}"`),
  "utf8"
);
EOF

WORKSPACE_PATH="$tmp_workspace" OUTPUT_INSTANCE_CONFIG="$tmp_home/.devshell/control/instances/aromatic-pc.toml" node <<'EOF'
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.env.OUTPUT_INSTANCE_CONFIG,
  [
    "version = 2",
    'name = "aromatic-pc"',
    "enabled = true",
    'provider = "local"',
    `workspace = ${JSON.stringify(process.env.WORKSPACE_PATH)}`,
    "",
    "[mcp]",
    "enabled = true",
    "",
    "[mcp.tools]",
    'groups = ["bash"]',
    'capabilities = ["execute"]',
    "",
    "[logs]",
    "eventBufferSize = 50",
    ""
  ].join("\n"),
  "utf8"
);
EOF

cat >"$tmp_bin/devshell" <<EOF
#!/bin/sh
exec node "$cli_entry" "\$@"
EOF
chmod +x "$tmp_bin/devshell"

export PATH="$tmp_bin:$PATH"
export HOME="$tmp_home"
export XDG_RUNTIME_DIR="$tmp_runtime"

worker_env_name=$(node <<'EOF'
const platform = { linux: "LINUX", darwin: "DARWIN" }[process.platform];
const arch = { x64: "X64", arm64: "ARM64" }[process.arch];
if (platform === undefined || arch === undefined) {
  process.exit(1);
}
process.stdout.write(`PORTABLE_DEVSHELL_WORKER_${platform}_${arch}_PATH`);
EOF
)
export "$worker_env_name=$worker_binary"

start_output=$(devshell start)
printf '%s\n' "$start_output"
printf '%s\n' "$start_output" | grep 'control: running' >/dev/null

status_output=$(devshell status)
printf '%s\n' "$status_output"
printf '%s\n' "$status_output" | grep 'instances: 1' >/dev/null

list_output=$(devshell instance list)
printf '%s\n' "$list_output"
printf '%s\n' "$list_output" | grep 'aromatic-pc' >/dev/null

pre_status_output=$(devshell instance status aromatic-pc)
printf '%s\n' "$pre_status_output"
printf '%s\n' "$pre_status_output" | grep 'status: stopped' >/dev/null

instance_start_output=$(devshell instance start aromatic-pc)
printf '%s\n' "$instance_start_output"
printf '%s\n' "$instance_start_output" | grep 'status: ready' >/dev/null

post_status_output=$(devshell instance status aromatic-pc)
printf '%s\n' "$post_status_output"
printf '%s\n' "$post_status_output" | grep 'ready: true' >/dev/null

call_pwd_output=$(devshell instance call aromatic-pc bash_run '{"command":"pwd"}')
printf '%s\n' "$call_pwd_output"
printf '%s\n' "$call_pwd_output" | grep "$tmp_workspace" >/dev/null

call_echo_output=$(devshell instance call aromatic-pc bash_run '{"command":"echo portable-devshell"}')
printf '%s\n' "$call_echo_output"
printf '%s\n' "$call_echo_output" | grep 'portable-devshell' >/dev/null

logs_output=$(devshell instance logs aromatic-pc)
printf '%s\n' "$logs_output"
printf '%s\n' "$logs_output" | grep 'portable-devshell' >/dev/null

grep 'bash_run' "$tmp_home/.devshell/aromatic-pc/control-worker/tool-calls.jsonl" >/dev/null
grep 'toolCall.completed' "$tmp_home/.devshell/aromatic-pc/control-worker/events.jsonl" >/dev/null
grep 'portable-devshell' "$tmp_home/.devshell/aromatic-pc/control-worker/logs.jsonl" >/dev/null
grep 'control server started' "$tmp_home/.devshell/control/logs/control.log" >/dev/null

devshell instance stop aromatic-pc >/dev/null
stop_output=$(devshell stop)
printf '%s\n' "$stop_output"
printf '%s\n' "$stop_output" | grep 'control: stopped' >/dev/null
