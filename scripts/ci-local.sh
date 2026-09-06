#!/usr/bin/env bash
# Run the same checks as .github/workflows/ci.yml before committing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> npm ci"
npm ci

exec bash scripts/verify.sh
