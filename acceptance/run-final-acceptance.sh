#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$repo_root"

pnpm build
pnpm typecheck
pnpm test
cargo test --manifest-path "$repo_root/Cargo.toml"
cargo build --manifest-path "$repo_root/Cargo.toml"

bash "$repo_root/acceptance/run-real-worker-smoke.sh"
bash "$repo_root/acceptance/run-mcp-smoke.sh"
