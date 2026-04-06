# Development Environment

All binaries, tools, and PATH are managed by **Nix**. Do not install tools manually or modify PATH outside of the nix configuration.

## Prerequisites

1. **Nix** — package manager ([install](https://nixos.org/download))
2. **Docker** — container runtime ([install](https://docs.docker.com/get-docker))
3. **direnv** — auto-loads the nix shell on `cd` ([install](https://direnv.net/docs/installation.html))

## Getting Started

```bash
direnv allow    # first time only — loads the nix dev shell
```

## Nix Configuration

See **[docs/developer/standard/nix.md](docs/developer/standard/nix.md)** for the full guide on:

- File structure (`flake.nix`, `nix/`, `.envrc`)
- Adding/removing packages
- Environment groups and shells
- Formatters and pre-commit hooks
- Adding registries
