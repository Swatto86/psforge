# Contributing to PSForge

Thank you for your interest in contributing to PSForge! This guide explains how to set up the development environment, the code standards you must follow, and the workflow for submitting changes.

---

## Table of Contents

1. [Development Environment](#development-environment)
2. [Project Structure](#project-structure)
3. [Code Standards](#code-standards)
4. [Testing Requirements](#testing-requirements)
5. [Submitting Changes](#submitting-changes)
6. [Release Process](#release-process)
7. [Debugging Tips](#debugging-tips)

---

## Development Environment

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable (via rustup) | `winget install Rustlang.Rustup` |
| Node.js | 18 LTS or later | `winget install OpenJS.NodeJS.LTS` |
| Git | any | `winget install Git.Git` |
| VS Code (recommended) | any | `winget install Microsoft.VisualStudioCode` |

### Recommended VS Code Extensions

- [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

### First-Time Setup

```powershell
git clone https://github.com/YOUR_ORG/psforge
cd psforge
npm install
cd src-tauri && cargo check
```

### Running in Development Mode

```powershell
# From the repo root:
npx tauri dev
```

---

## Project Structure

```
psforge/
  README.md               # User-facing documentation
  CONTRIBUTING.md         # This file
  PROJECT_ATLAS.md        # Architecture reference (keep current!)
  PROGRESS.md             # Internal tracking only; not shipped
  package.json            # Node dependencies
  vite.config.ts          # Vite + Monaco worker config
  src/                    # Frontend (React + TypeScript)
  src-tauri/              # Backend (Rust + Tauri v2)
    src/                  # Production Rust source
    tests/                # Integration tests (E2E, Rule 3)
  .github/workflows/      # CI and Release workflows
  update-application.ps1  # Automated release script
```

See [PROJECT_ATLAS.md](PROJECT_ATLAS.md) for a detailed breakdown of every module and its responsibility.

---

## Code Standards

All contributions must comply with the **AI Operating Contract (DevWorkflow.instructions.md)**, summarised here:

### Rust

- All code must compile and pass `cargo clippy -- -D warnings` with zero errors or warnings.
- Run `cargo fmt` before committing (formatter is non-negotiable).
- Propagate errors using the `AppError` type; never use `.unwrap()` in library code.
- Transient I/O must use the `with_retry` helper (Rule 11).
- Growing collections must have explicit `MAX_SIZE` constants (Rule 11).
- New `impl` blocks and `fn` items must appear **before** any `#[cfg(test)]` module in the same file (Rule 3 / clippy::items_after_test_module).

### TypeScript / React

- No TypeScript errors (`npx tsc --noEmit` must pass).
- Run `npx prettier --write "src/**/*.{ts,tsx}"` before committing.
- State mutations go through the `AppState` reducer in `store.tsx`; components must not mutate global state directly.
- UI controls must be disabled when their action is invalid (Rule 16).

### Cross-Cutting

- Source files must be UTF-8 without BOM.
- No smart quotes (`"` `"` `'` `'`), en-dashes (`--`), or em-dashes (`---`) in executable code or CI YAML files. Hyphens (`-`) only.
- `PROJECT_ATLAS.md` must be updated in the same PR as any structural change.

---

## Testing Requirements

### Mandatory Coverage (Rule 3)

- **E2E / integration tests** for every user-visible feature (not mocks, real filesystem).
- **Regression tests** for every bug fix (must fail before fix, pass after).
- **Failure-mode tests** for error paths, corrupt data, and boundary conditions.

### Rust Integration Tests

Integration tests live in `src-tauri/tests/`. They are compiled against `psforge_lib` (the `rlib` build) and have full access to all `pub` functions.

```powershell
cd src-tauri
cargo test              # Run all tests
cargo test --test settings_e2e   # Run one integration test file
```

### Timeout Constants (Rule 3)

Every test that blocks on I/O, a background thread, or an async task **must** define a `const TEST_TIMEOUT_SECS: u64` at the top of the test file. The value must be at least 5x the worst-case local completion time and no less than 30 seconds for filesystem tests.

### CI Environment Awareness

GitHub Actions `windows-latest` runners run as **Administrator**. Tests that check admin status will always take the elevated code path in CI. If your test must behave differently based on elevation, use `#[ignore = "requires non-admin environment"]` with a documented reason.

---

## Submitting Changes

### Branch Naming

| Prefix | Use |
|--------|-----|
| `feature/...` | New user-visible functionality |
| `fix/...` | Bug fix |
| `test/...` | Tests only (no production change) |
| `docs/...` | Documentation only |
| `chore/...` | Tooling, CI, dependency updates |

### Pre-PR Checklist

Before opening a pull request, confirm all of the following:

- [ ] `cargo fmt` applied to all changed Rust files
- [ ] `cargo clippy -- -D warnings` passes with zero errors
- [ ] `cargo test` passes (all tests green)
- [ ] `npx tsc --noEmit` passes
- [ ] `npx prettier --write "src/**/*.{ts,tsx}"` applied
- [ ] `PROJECT_ATLAS.md` updated if structure, APIs, or build changed
- [ ] `PROGRESS.md` updated to reflect what is now complete
- [ ] E2E / regression test added for every new feature or bug fix
- [ ] No smart quotes, en-dashes, or em-dashes in source code or CI YAML

### CI Gates

The CI workflow (`ci.yml`) runs on every push and PR:

1. `cargo fmt -- --check` (formatting)
2. `cargo clippy -- -D warnings` (linting)
3. `cargo test` (all backend tests)
4. `tsc --noEmit` (TypeScript)
5. `vite build` (frontend bundle)

**CI must pass before any merge to `main`.**

---

## Release Process

Releases are managed by `update-application.ps1`. Do **not** manually edit version numbers, create tags, or push releases by hand.

```powershell
# Full release
.\update-application.ps1 -Version x.y.z

# Dry run (preview only, no changes)
.\update-application.ps1 -Version x.y.z -DryRun

# Override an existing tag (use with care)
.\update-application.ps1 -Version x.y.z -Force
```

The script:
1. Validates the version is newer than the current one
2. Collects release notes interactively
3. Updates `Cargo.toml`, `package.json`, and `Cargo.lock`
4. Shows a `git diff` and asks for confirmation
5. Builds the release binary
6. Runs `cargo fmt --check`, `cargo clippy`, `cargo test`
7. Commits the version bump, creates an annotated tag, pushes to origin
8. Deletes old release tags from GitHub (only the latest release tag is kept)

GitHub Actions (`release.yml`) picks up the new tag, builds the NSIS/MSI installers, and attaches them to a GitHub Release automatically.

---

## Debugging Tips

### Enable Verbose Rust Logging

```powershell
$env:RUST_LOG = "psforge=debug"
npx tauri dev
```

### Inspect IPC Traffic

In `tauri.conf.json`, the CSP is set to allow `devtools`. Open the WebView2 devtools with `F12` (dev build only) to inspect network activity and IPC calls.

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `cargo clippy` warns about `new_without_default` | Struct with `new()` lacks `Default` | Add `impl Default { fn default() -> Self { Self::new() } }` |
| Frontend shows blank white screen on first launch | Expensive init inside `run_native` closure | Move all init before `run_native` (Rule 16) |
| Settings silently reset to defaults | Corrupt JSON in `%APPDATA%/PSForge/settings.json` | Delete the file to regenerate defaults; check error logs |
| PowerShell execution fails | Wrong path or execution policy | Verify path with `Get-Command powershell` and check Output pane for errors |
