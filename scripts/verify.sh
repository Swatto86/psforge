#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# File-size guideline (the agent-standards engineering skill): a code file over 400 lines needs a
# reason on record or a split; files already over it are listed in scripts/file-size-baseline.txt
# and may not grow.
size_check="$HOME/.agents/scripts/check-file-size.ps1"
if [ -f "$size_check" ] && command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -File "$size_check" -Root "$PWD"
else
  echo "skip - file size check: ~/.agents/scripts/check-file-size.ps1 or pwsh not found"
fi
npm test
(cd src-tauri && cargo fmt --all -- --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --all-targets)
npx tauri build --debug --no-bundle
npm run test:e2e
