#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
worker_binary="$repo_root/target/debug/devshell-worker"

if [ ! -x "$worker_binary" ]; then
    echo "building worker binary: $worker_binary" >&2
    cargo build --locked -p devshell-worker --manifest-path "$repo_root/Cargo.toml"
fi

if [ ! -x "$worker_binary" ]; then
    echo "missing worker binary after build: $worker_binary" >&2
    exit 1
fi

cd "$repo_root"
pnpm test
