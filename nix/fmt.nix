{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    # enable or disable formatters, see https://github.com/numtide/treefmt-nix#supported-programs
    programs = { };


  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper


