#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SONICJS_DIR="$SCRIPT_DIR/sonicjs-app"

echo "CMS Integration Test Setup"
echo "=========================="

# 1. Scaffold SonicJS if not already present
if [ -d "$SONICJS_DIR" ]; then
	echo "SonicJS already scaffolded at $SONICJS_DIR"
else
	echo "Scaffolding SonicJS..."
	npx create-sonicjs@latest "$SONICJS_DIR" --defaults --no-git
fi

# 2. Install deps
echo "Installing dependencies..."
cd "$SONICJS_DIR"
bun install

# 3. Run D1 migrations (local)
echo "Running D1 migrations (local)..."
DB_NAME=$(grep -o '"db_name": "[^"]*"' "$SONICJS_DIR/wrangler.toml" | head -1 | cut -d'"' -f4 || echo "DB")
bunx wrangler d1 migrations apply "$DB_NAME" --local 2>/dev/null || true

echo ""
echo "Setup complete!"
echo ""
echo "To run tests:"
echo "  cd $SONICJS_DIR"
echo "  bunx wrangler dev --local &"
echo "  cd $SCRIPT_DIR/../.."
echo "  bun run test:cms"
echo ""
echo "Or simply:"
echo "  bun run test:cms"
echo ""
echo "The test runner will start SonicJS automatically."
