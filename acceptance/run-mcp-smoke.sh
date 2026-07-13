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

devshell start >/dev/null
devshell instance start aromatic-pc >/dev/null

MCP_ENDPOINT="http://127.0.0.1:$mcp_port/aromatic-pc/mcp" WORKSPACE_PATH="$tmp_workspace" node --input-type=module <<'EOF'
const endpoint = process.env.MCP_ENDPOINT;
const workspacePath = process.env.WORKSPACE_PATH;

async function post(body, headers = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return response;
}

async function postJson(body, headers = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (response.status !== 200) {
    throw new Error(`unexpected status ${response.status}`);
  }

  return {
    headers: response.headers,
    ...(await response.json())
  };
}

const initialize = await postJson({
  jsonrpc: "2.0",
  id: "req-init",
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "acceptance", version: "0.0.0" }
  }
});

const sessionId = initialize.headers.get("mcp-session-id");
const protocolVersion = String(initialize.result?.protocolVersion ?? "");

if (typeof sessionId !== "string" || sessionId.length === 0) {
  throw new Error("initialize did not return mcp-session-id response header");
}

if (protocolVersion.length === 0) {
  throw new Error("initialize did not return protocolVersion");
}

const sessionHeaders = {
  "mcp-protocol-version": protocolVersion,
  "mcp-session-id": sessionId
};

const initialized = await post({
  jsonrpc: "2.0",
  method: "notifications/initialized"
}, sessionHeaders);

if (initialized.status !== 202) {
  throw new Error(`notifications/initialized returned ${initialized.status}`);
}

const toolsList = await postJson({
  jsonrpc: "2.0",
  id: "req-tools-list",
  method: "tools/list"
}, sessionHeaders);

if (toolsList.result?.tools?.[0]?.name !== "bash_run") {
  throw new Error("tools/list did not expose bash_run");
}

const toolsCall = await postJson({
  jsonrpc: "2.0",
  id: "req-tools-call",
  method: "tools/call",
  params: {
    name: "bash_run",
    arguments: {
      command: "pwd"
    }
  }
}, sessionHeaders);

const text = String(toolsCall.result?.content?.[0]?.text ?? "");

if (!text.includes(workspacePath)) {
  throw new Error(`tools/call output did not include workspace path: ${text}`);
}

console.log(JSON.stringify({ initialize, toolsList, toolsCall }, null, 2));
EOF

devshell instance stop aromatic-pc >/dev/null
devshell stop >/dev/null
