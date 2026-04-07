{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ dev;
    shellHook = shellHook + ''
      export PATH="$PWD/node_modules/.bin:$PATH"
    '';
  };
}
