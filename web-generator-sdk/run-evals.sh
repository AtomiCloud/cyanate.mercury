#!/bin/bash

# Eval runner for web-generator-sdk skills
# Run this script in a terminal OUTSIDE of Claude Code

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo "Web Generator SDK - Skill Evaluations"
echo "========================================="
echo ""

# Check claude CLI is available
if ! command -v claude &> /dev/null; then
    if [ -f "$HOME/.npm-global/bin/claude" ]; then
        export PATH="$HOME/.npm-global/bin:$PATH"
    else
        echo "❌ Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
        exit 1
    fi
fi

echo "🔧 Claude CLI: $(claude --version)"
echo ""

# Create results directory
RESULTS_DIR="$SCRIPT_DIR/eval-results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "📁 Results will be saved to: $RESULTS_DIR"
echo ""

# Function to run a single eval
run_eval() {
    local skill_name="$1"
    local eval_id="$2"
    local prompt="$3"
    local output_dir="$4"

    echo "----------------------------------------"
    echo "Testing: $skill_name - Eval $eval_id"
    echo "----------------------------------------"

    mkdir -p "$output_dir"

    # Run claude with the skill
    timeout 120 claude -p "$prompt" \
        --permission-mode acceptEdits \
        --setting-sources project \
        > "$output_dir/output.txt" 2>&1

    # Check if it succeeded
    if [ $? -eq 0 ]; then
        echo "✅ $skill_name - Eval $eval_id: PASSED"
        echo "1" > "$output_dir/status.txt"
    else
        echo "❌ $skill_name - Eval $eval_id: FAILED"
        echo "0" > "$output_dir/status.txt"
        echo "Error output:"
        head -20 "$output_dir/output.txt"
    fi
    echo ""
}

# Run evals for each skill
echo "========================================="
echo "1. Testing extract-design-tokens"
echo "========================================="

run_eval "extract-design-tokens" "1" \
    "Generate default design tokens for a modern website. No reference URL provided. Save as design-tokens.json in the current directory." \
    "$RESULTS_DIR/extract-design-tokens-eval1"

run_eval "extract-design-tokens" "2" \
    "Generate default design tokens with a purple accent color and modern sans-serif typography. Save as design-tokens.json." \
    "$RESULTS_DIR/extract-design-tokens-eval2"

echo "========================================="
echo "2. Testing design-brief"
echo "========================================="

run_eval "design-brief" "1" \
    "Generate a design brief for a simple homepage. The page should have a hero section with heading, subheading, and CTA button. Include shared components: Header and Footer. Save as design-brief.json." \
    "$RESULTS_DIR/design-brief-eval1"

echo "========================================="
echo "3. Testing astro-codegen"
echo "========================================="

run_eval "astro-codegen" "1" \
    "Generate src/pages/index.astro for a homepage. It should import Layout, wrap content in Layout component, and include a hero section with a heading. Output directory: ./eval-test-site/" \
    "$RESULTS_DIR/astro-codegen-eval1"

echo "========================================="
echo "4. Testing validate-and-repair"
echo "========================================="

run_eval "validate-and-repair" "1" \
    "Check if the template/astro-project/ directory is valid. Run astro check and report if there are any errors. Save as validation-report.json." \
    "$RESULTS_DIR/validate-and-repair-eval1"

echo "========================================="
echo "Summary"
echo "========================================="

# Count passed/failed
passed=0
failed=0

for status_file in "$RESULTS_DIR"/*/status.txt; do
    if [ -f "$status_file" ]; then
        if [ "$(cat "$status_file")" = "1" ]; then
            ((passed++))
        else
            ((failed++))
        fi
    fi
done

echo "✅ Passed: $passed"
echo "❌ Failed: $failed"
echo ""
echo "📁 Full results in: $RESULTS_DIR"
echo ""
echo "To review individual results:"
echo "  cat $RESULTS_DIR/*/output.txt"
