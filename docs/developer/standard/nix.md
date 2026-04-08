# Nix Flake Configuration Guide

Complete guide to Nix flake-based projects using the modular nix/ folder structure. This document explains the architecture, how to modify configurations, and common operations.

## Overview

This Nix configuration uses a **modular flake architecture** with separate files for each concern. The structure separates package management, environment grouping, shell composition, formatting, and git hooks into distinct, focused modules.

## Quick Reference

```
nix/
├── packages.nix   # Aggregate packages from registries
├── env.nix        # Group packages by purpose
├── shells.nix     # Define dev environments
├── fmt.nix        # Configure formatters
└── pre-commit.nix # Configure git hooks

flake.nix          # Main flake (orchestrator)
.envrc             # Direnv (watches files, loads default shell)
```

## File Structure

### flake.nix - The Orchestrator

**Purpose**: Central coordinator that defines inputs (package registries) and exports outputs (packages, shells, checks).

**Key Concepts**:

- **Inputs**: Where packages come from (nixpkgs versions, custom registries)
- **Outputs**: What gets exported (packages, devShells, formatter, checks)
- **Wiring**: Connects all the nix/ modules together using `with rec { ... }` pattern

**How it works**: The flake uses `with rec { ... }` to allow modules to reference each other. Each module is imported with only the parameters it needs. Read `flake.nix` to see the exact inputs and wiring for your project.

### nix/packages.nix - Package Aggregation

**Purpose**: Combine packages from multiple registries into one unified attribute set.

**How it works**: Each input registry gets its own group in a `let all = { ... }` block. Groups are merged with `//` (attribute set merge) in priority order — later groups override earlier ones.

**To find what registries and variable names are available**: Read `flake.nix` to see the inputs and what parameters are passed to `packages.nix`.

### nix/env.nix - Environment Groups

**Purpose**: Organize packages into functional groups so different shells can include only what they need.

**How it works**: Takes `packages` as input, uses `with packages;` to bring all package names into scope, then defines named groups as lists. Each group is a list of packages serving a common purpose.

**When to create a new group**: When you have a set of packages that should be included in some shells but not others. For example, if you have packages only needed for release automation, create a dedicated group rather than adding them to an existing group.

**Design principle**: Groups enable flexible shell composition — a CI shell can exclude interactive tools, a release shell can include release-specific tools, etc.

### nix/shells.nix - Development Environments

**Purpose**: Define development environments by composing environment groups with `++` (list concatenation).

**How it works**: Takes `env` as input, uses `with env;` to bring group names into scope, then defines named shells using `pkgs.mkShell`. Each shell's `buildInputs` combines groups with `++`. The `shellHook` is passed as a parameter from `flake.nix`.

**IMPORTANT**: All shells must use `inherit shellHook;` — do not override or customize `shellHook` in `shells.nix`. The `shellHook` inheritance must be preserved for downstream nix-resolvers to work correctly. Nix resolvers do not understand custom shellHook modifications.

**When to create a new shell**: When you have a distinct workflow requiring a different combination of environment groups. Each shell composes groups differently but always inherits the same `shellHook`.

**Usage**: `nix develop` for default, `nix develop .#name` for a specific shell.

### nix/fmt.nix - Formatters

**Purpose**: Configure multi-language code formatting via treefmt.

**How it works**: Defines a `fmt` config with `programs` attribute set. Each formatter is enabled with `program-name.enable = true`. The config is evaluated through `treefmt-nix.lib.evalModule`.

**Common formatters**: See https://github.com/numtide/treefmt-nix#supported-programs

### nix/pre-commit.nix - Git Hooks

**Purpose**: Configure git pre-commit hooks for code quality and security.

**How it works**: Uses `pre-commit-lib.run` with a `hooks` attribute set. The treefmt formatter hook is included by default. Additional hooks can be formatters, linters, or enforcers.

**Hook naming convention**: Prefix custom hook names with `a-` (e.g., `a-eslint`, `a-file-size`, `a-secrets`).

**Hook types**:

| Type      | Purpose             | Example                   |
| --------- | ------------------- | ------------------------- |
| Formatter | Runs treefmt        | Formats all files         |
| Linter    | Checks file quality | eslint, shellcheck        |
| Enforcer  | Validates policies  | File permissions, secrets |

### .envrc - Direnv Configuration

**Purpose**: Automatically load the default development shell, watch for file changes, and optionally add repo-local paths for dev convenience.

**How it works**:

1. `watch_file` — monitors specific nix files for changes and auto-reloads
2. `use flake` — loads the default dev shell
3. Optional `PATH_add` — for repo-local paths only (see below)

**PATH_add rules**: You may add `PATH_add` entries in `.envrc` for paths whose existence is **declared by a file checked into the repository**. The path itself doesn't have to be inside the repo, but the reason it exists must be traceable to a repo config. These are a dev convenience — making non-nix-managed binaries accessible without full paths. All primary tool installation is still managed by nix.

```bash
# OK — existence declared by repo config files
PATH_add node_modules/.bin           # declared by package.json
PATH_add ~/.dotnet/tools             # declared by .config/dotnet-tools.json
PATH_add bin                         # scripts checked into the repo

# NOT OK — arbitrary external paths not traceable to repo config
# PATH_add /usr/local/custom-tool/bin
# export TOOL_HOME=/some/path
```

**Do not** use `.envrc` to install tools, export environment variables, or add arbitrary external paths.

## Data Flow

```
Registries (flake.nix inputs)
           |
    packages.nix (aggregate into attrset, merge with //)
           |
       env.nix (group into named lists)
           |
     shells.nix (compose lists with ++)
           |
    flake.nix (export as devShells, checks, etc.)
```

## Common Operations

### Adding a Package

1. **Read `flake.nix`** to identify which registry variable to use in `packages.nix`
2. **Add to registry group** in `nix/packages.nix`:

```nix
# Add to the appropriate registry group
my-registry-group = with registry-var; {
  inherit existing-package new-package;
};
```

3. **Add to environment group** in `nix/env.nix`:

```nix
# Add to the appropriate group
my-group = [ existing-package new-package ];
```

4. **Apply**: `direnv reload`

### Removing a Package

1. Remove from `nix/packages.nix` (the `inherit` line)
2. Remove from `nix/env.nix` (the group list)
3. Apply: `direnv reload`

### Adding an Environment Group

**When**: You have packages that should be available in some shells but not others.

1. **Add the group** in `nix/env.nix`:

```nix
{ pkgs, packages }:
with packages;
{
  # ... existing groups ...
  my-new-group = [ package1 package2 ];
}
```

2. **Use in shells** in `nix/shells.nix`:

```nix
my-shell = pkgs.mkShell {
  buildInputs = existing-group ++ my-new-group;
  inherit shellHook;
};
```

### Adding a Shell

**When**: You have a distinct workflow needing a different package combination.

1. **Add the shell** in `nix/shells.nix`:

```nix
{ pkgs, packages, env, shellHook }:
with env;
{
  # ... existing shells ...
  my-shell = pkgs.mkShell {
    buildInputs = group-a ++ group-b;
    inherit shellHook;
  };
}
```

**IMPORTANT**: Always use `inherit shellHook;`. Do not customize or override `shellHook` — this breaks downstream nix-resolvers.

2. **Use**: `nix develop .#my-shell`

### Adding a Formatter

1. **Enable in `nix/fmt.nix`**:

```nix
programs = {
  formatter-name.enable = true;
};
```

2. **Optionally exclude files**:

```nix
programs.formatter-name.excludes = ["pattern"];
```

### Adding a Pre-commit Hook

**Convention**: Prefix custom hook names with `a-`.

```nix
# In nix/pre-commit.nix, add to hooks:
hooks = {
  # Treefmt (usually already present)
  treefmt = { enable = true; package = formatter; };

  # Custom linter hook
  a-my-linter = {
    enable = true;
    name = "Display Name";
    entry = "${packages.my-tool}/bin/my-tool --args";
    files = "\\.(ext)$";
  };

  # Enforcer hook (no package needed)
  a-my-enforcer = {
    enable = true;
    name = "Policy Check";
    entry = "shell-command-here";
    language = "system";
  };
}
```

### Adding a Registry

1. **Add input** in `flake.nix`:

```nix
inputs = {
  # ... existing inputs ...
  my-registry.url = "github:myorg/nix-registry";
};
```

2. **Wire it** in `flake.nix` outputs — add the new input to the function parameters and pass it to `packages.nix`

3. **Use in `nix/packages.nix`** — add the new parameter and create a group:

```nix
{ pkgs, ..., my-registry }:
let
  all = {
    # ... existing groups ...
    my-org = with my-registry; {
      inherit tool1 tool2;
    };
  };
in
with all;
existing-group // my-org
```

### Adding a Binary to PATH

**All tool binaries must be managed through nix.** This ensures the environment is reproducible across local dev, CI, and CD.

1. Find the nix package that provides the binary (use `nix search nixpkgs name`)
2. Add it to `nix/packages.nix` → `nix/env.nix` (the standard package flow)
3. The binary will automatically be on PATH in all shells that include that group

**Non-nix managed paths for dev convenience**: If a tool's existence is declared by a config file in the repo (e.g., `./node_modules/.bin` from `package.json`, `~/.dotnet/tools` from `.config/dotnet-tools.json`), you may add `PATH_add` in `.envrc`. The path doesn't have to be inside the repo, but the reason it exists must be traceable to a file checked into the repo.

**If a binary cannot be packaged in nix** (e.g., it's only available via `npm install` or another non-nix package manager), either add the path via `.envrc` `PATH_add` (if its existence is repo-declared), or use downstream task runners to invoke it explicitly (e.g., `npx`, `pnpm exec`).

## Usage Commands

| Action          | Command                        |
| --------------- | ------------------------------ |
| Enter shell     | `nix develop` or `cd` (direnv) |
| Specific shell  | `nix develop .#name`           |
| Update registries | `nix flake update`           |
| Search packages | `nix search nixpkgs name`      |
| Show flake info | `nix flake show`               |
| Reload direnv   | `direnv reload`                |

## Key Concepts

### Modularity

Each file has a single responsibility:

- `packages.nix` = what packages exist (aggregation)
- `env.nix` = how packages are grouped (purpose)
- `shells.nix` = what shells include which groups (composition)
- `fmt.nix` = how files are formatted
- `pre-commit.nix` = what runs before commits
- `.envrc` = watches files, loads default shell, optional repo-local PATH_add

### Composability

Groups are defined once and composed into multiple shells:

```nix
# Define groups once in env.nix
group-a = [ pkg1 pkg2 ];
group-b = [ pkg3 pkg4 ];

# Compose differently in shells.nix
full = group-a ++ group-b;
minimal = group-a;  # No group-b
```

### Separation of Concerns

- **Package source** (where it comes from) vs **group** (what it's for) vs **shell** (when it's available)
- **Formatter** (how to format) vs **hook** (when to run)
- **Definition** (in nix/) vs **orchestration** (in flake.nix)
- **Default shell** (loaded by .envrc or `nix develop`) vs **named shells** (CI, CD, release via `nix develop .#name`)

## For Implementation Help

When you need help implementing Nix changes, use the **nix skill** which provides step-by-step instructions and examples.

See also:

- **Skill**: `.claude/skills/nix/SKILL.md` - Quick reference and critical rules
- **Reference**: `.claude/skills/nix/reference.md` - File patterns and examples
