---
name: nix
description: Use for ALL Nix flake configuration questions. This includes file structure (flake.nix, nix/, .envrc), adding/removing packages or binaries, PATH configuration, development shells, pre-commit hooks, formatters, linters, enforcers, environment variables, adding registries, and how the Nix template structure works. Use when user asks about nix, flake, packages, binaries, shells, PATH, formatting, linting, git hooks, or registries.
---

# Nix Flake Configuration Skill

## When to Use

User asks about nix files, packages, binaries, PATH, shells, formatters, linters, hooks, registries, or `.envrc`.

## Instructions

### Step 1: Read the Actual Files First

**Always** read `flake.nix` and the target nix file before making changes. Registry names, variable names, environment groups, and shells are project-specific.

### Step 2: Consult the Docs

Full guide: **[nix.md](../../../docs/developer/standard/nix.md)**

### Step 3: Quick Reference

| Task              | Files to Edit                           | Apply With         |
| ----------------- | --------------------------------------- | ------------------ |
| Add package       | `packages.nix`, `env.nix`              | `direnv reload`    |
| Add env group     | `env.nix`, then use in `shells.nix`    | `direnv reload`    |
| Add shell         | `shells.nix` (only change `buildInputs`, always `inherit shellHook`) | `nix develop .#name` |
| Add formatter     | `fmt.nix`                              | `direnv reload`    |
| Add hook          | `pre-commit.nix` (prefix `a-`)        | `direnv reload`    |
| Add binary to PATH | `packages.nix` → `env.nix` (nix); or `.envrc` `PATH_add` (repo-declared non-nix paths) | `direnv reload` |
| Add registry      | `flake.nix`, `packages.nix`            | `nix flake update` |

### Step 4: Critical Rules

1. **Read `flake.nix` first** — it defines all variable names and wiring
2. **`shellHook` must be inherited** — all shells use `inherit shellHook;`, never override or customize it (breaks downstream nix-resolvers)
3. **Prefix custom hooks with `a-`** — e.g., `a-eslint`, `a-file-size`
4. **PATH is managed by nix** — add packages via `packages.nix` → `env.nix`. `.envrc` `PATH_add` is only for paths whose existence is declared by a repo config file (e.g., `node_modules/.bin` from `package.json`, `~/.dotnet/tools` from `.config/dotnet-tools.json`)
5. **`nix flake update` only for new registries** — all other changes just need `direnv reload`
6. **`.envrc` is minimal** — only `watch_file`, `use flake`, and repo-declared `PATH_add`. No env var exports, no arbitrary external paths

### Step 5: Patterns and Examples

See **[reference.md](./reference.md)** for file patterns and code examples.
