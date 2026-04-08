# Nix Flake Patterns & Examples

Concise patterns for each nix file. For full documentation, see **[nix.md](../../../docs/developer/standard/nix.md)**.

**Always read the actual project files first** — variable names, groups, and shells vary per project.

## File Patterns

### packages.nix — Aggregate with `//`

```nix
{ pkgs, registry-a, registry-b, ... }:
let
  all = {
    group-a = (
      with registry-a;
      { inherit package1 package2; }
    );
    group-b = (
      with registry-b;
      { inherit package3; }
    );
  };
in
with all;
group-a // group-b
```

Rightmost group wins on conflict.

### env.nix — Group into lists

```nix
{ pkgs, packages }:
with packages;
{
  group-a = [ package1 package2 ];
  group-b = [ package3 ];
}
```

Create new groups when packages should only appear in certain shells.

### shells.nix — Compose with `++`

```nix
{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = group-a ++ group-b ++ group-c;
    inherit shellHook;
  };
  ci = pkgs.mkShell {
    buildInputs = group-a ++ group-b;
    inherit shellHook;
  };
}
```

**Only change `buildInputs`**. Always `inherit shellHook` — never override.

### fmt.nix — Enable formatters

```nix
{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";
    programs = {
      nixpkgs-fmt.enable = true;
      prettier = { enable = true; excludes = ["dist/**"]; };
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
```

See https://github.com/numtide/treefmt-nix#supported-programs

### pre-commit.nix — Hooks prefixed with `a-`

```nix
{ packages, formatter, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;
  hooks = {
    treefmt = { enable = true; package = formatter; };
    a-eslint = {
      enable = true;
      name = "ESLint";
      entry = "${packages.eslint}/bin/eslint --fix";
      files = "\\.(js|ts|jsx|tsx)$";
    };
    a-file-size = {
      enable = true;
      name = "Check File Size";
      entry = "find . -type f -size +10M | grep . && exit 1 || exit 0";
      language = "system";
    };
  };
}
```

Hook options: `enable`, `name`, `entry`, `files` (regex), `excludes`, `language`.

### .envrc — Minimal

```bash
watch_file "./nix/env.nix" "./nix/fmt.nix" "./nix/packages.nix" "./nix/shells.nix" "./nix/pre-commit.nix" "./flake.nix"
use flake

# Only repo-declared non-nix paths:
PATH_add node_modules/.bin    # declared by package.json
PATH_add ~/.dotnet/tools      # declared by .config/dotnet-tools.json
```

No env var exports. No arbitrary external paths.

## End-to-End Example: Adding a Language Stack

```nix
# 1. packages.nix — add to appropriate registry group
my-registry-group = (
  with registry-var;
  { inherit nodejs_20 pnpm biome; }
);

# 2. env.nix — create groups
{
  node = [ nodejs_20 pnpm ];
  ts-lint = [ biome ];
}

# 3. fmt.nix
{ programs.biome.enable = true; }

# 4. pre-commit.nix
hooks = {
  treefmt = { enable = true; package = formatter; };
  a-biome = {
    enable = true;
    name = "Biome Check";
    entry = "${packages.biome}/bin/biome check --write";
    files = "\\.(ts|tsx|js|jsx)$";
  };
};

# 5. shells.nix — always inherit shellHook
{
  typescript = pkgs.mkShell {
    buildInputs = system ++ node ++ ts-lint ++ lint;
    inherit shellHook;
  };
}
```

Then `direnv reload` (or `nix develop .#typescript`).
