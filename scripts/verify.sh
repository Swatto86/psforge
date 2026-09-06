#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
(cd src-tauri && cargo fmt --all -- --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --all-targets)
npx tauri build --debug --no-bundle
npm run test:e2e
