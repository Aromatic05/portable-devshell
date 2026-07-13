#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$repo_root"

pnpm build
pnpm typecheck
cargo build --locked --workspace
pnpm test
cargo test --locked --workspace

bash "$repo_root/acceptance/run-real-worker-smoke.sh"
bash "$repo_root/acceptance/run-mcp-smoke.sh"
