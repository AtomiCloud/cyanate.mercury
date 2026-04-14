{ pkgs, packages, env, shellHook }:
with env;
{
  default = pkgs.mkShell {
    buildInputs = system ++ main ++ lint ++ dev;
    shellHook = shellHook + ''
      export PATH="$PWD/node_modules/.bin:$PATH"

      # Ensure Playwright chromium is installed (headless, for reviewers).
      # For Docker/CI, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to skip this.
      if [ -z "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ] && [ -n "$(command -v bunx)" ]; then
        TMPDIR=/tmp bunx playwright install chromium >>/tmp/playwright-install.log 2>&1 &
      fi
    '';
  };
}
