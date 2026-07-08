#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
worker_binary="$repo_root/target/debug/devshell-worker"
cli_entry="$repo_root/packages/cli/dist/cli/CliMain.js"
fixture_config="$repo_root/acceptance/fixtures/config.local.toml"
fixture_workspace="$repo_root/acceptance/fixtures/workspace"

if [ ! -x "$worker_binary" ]; then
    echo "building worker binary: $worker_binary" >&2
    cargo build -p devshell-worker --manifest-path "$repo_root/Cargo.toml"
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

cleanup() {
    PATH="$tmp_bin:$PATH" HOME="$tmp_home" XDG_RUNTIME_DIR="$tmp_runtime" devshell instance stop aromatic-pc >/dev/null 2>&1 || true
    PATH="$tmp_bin:$PATH" HOME="$tmp_home" XDG_RUNTIME_DIR="$tmp_runtime" devshell stop >/dev/null 2>&1 || true
    rm -rf "$tmp_home" "$tmp_runtime" "$tmp_workspace" "$tmp_bin"
}

trap cleanup EXIT INT TERM

cp "$fixture_workspace/README.md" "$tmp_workspace/README.md"
mkdir -p "$tmp_home/.devshell/control"

WORKER_BINARY="$worker_binary" WORKSPACE_PATH="$tmp_workspace" FIXTURE_CONFIG="$fixture_config" OUTPUT_CONFIG="$tmp_home/.devshell/control/config.toml" node <<'EOF'
const { readFileSync, writeFileSync } = require("node:fs");
const fixture = readFileSync(process.env.FIXTURE_CONFIG, "utf8");
writeFileSync(
  process.env.OUTPUT_CONFIG,
  fixture
    .replace("__WORKSPACE__", process.env.WORKSPACE_PATH)
    .replace("__WORKER_BINARY__", process.env.WORKER_BINARY),
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

devshell start >/dev/null
devshell instance start aromatic-pc >/dev/null

MCP_ENDPOINT="http://127.0.0.1:17890/aromatic-pc/mcp" WORKSPACE_PATH="$tmp_workspace" node --input-type=module <<'EOF'
const endpoint = process.env.MCP_ENDPOINT;
const workspacePath = process.env.WORKSPACE_PATH;

async function post(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (response.status !== 200) {
    throw new Error(`unexpected status ${response.status}`);
  }

  return await response.json();
}

const initialize = await post({
  jsonrpc: "2.0",
  id: "req-init",
  method: "initialize",
  params: { clientInfo: { name: "acceptance", version: "0.0.0" } }
});

if (typeof initialize.result?.sessionId !== "string") {
  throw new Error("initialize did not return a sessionId");
}

const toolsList = await post({
  jsonrpc: "2.0",
  id: "req-tools-list",
  method: "tools/list"
});

if (toolsList.result?.tools?.[0]?.name !== "bash_run") {
  throw new Error("tools/list did not expose bash_run");
}

const toolsCall = await post({
  jsonrpc: "2.0",
  id: "req-tools-call",
  method: "tools/call",
  params: {
    name: "bash_run",
    arguments: {
      command: "pwd"
    }
  }
});

const text = String(toolsCall.result?.content?.[0]?.text ?? "");

if (!text.includes(workspacePath)) {
  throw new Error(`tools/call output did not include workspace path: ${text}`);
}

console.log(JSON.stringify({ initialize, toolsList, toolsCall }, null, 2));
EOF

devshell instance stop aromatic-pc >/dev/null
devshell stop >/dev/null
