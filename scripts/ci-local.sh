#!/usr/bin/env bash
# Run the same checks as .github/workflows/ci.yml before committing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> cargo fmt --check"
# src-tauri/rust-toolchain.toml pins stable (same as GitHub CI dtolnay/rust-toolchain@stable)
(cd src-tauri && cargo fmt --all -- --check)

echo "==> cargo clippy"
(cd src-tauri && cargo clippy --all-targets -- -D warnings)

echo "==> cargo test"
(cd src-tauri && cargo test)

echo "All local CI checks passed."
