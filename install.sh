#!/usr/bin/env bash
# Install the frontend-quality plugin without a plugin manager.
#
# Places the skills, the acceptance agent and the Stop hook into ~/.claude and
# installs the browser with axe INSIDE the skill — the project under test gets
# no dependencies.
# Usage: bash install.sh [--dry-run]
#
# If your plugin manager works, prefer it:
#   claude plugin marketplace add <repository>
#   claude plugin install frontend-quality

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$HERE"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry] $*"; else "$@"; fi; }

[ -d "$PLUGIN" ] || { say "Plugin directory not found: $PLUGIN"; exit 1; }

say "Plugin: $PLUGIN"
say "Target: $DEST"
say ""

# 1. Skills. An existing one with the same name is renamed, never overwritten.
for src in "$PLUGIN"/skills/*/; do
  skill="$(basename "$src")"
  dst="$DEST/skills/$skill"
  if [ -e "$dst" ] && [ "$DRY" = 0 ]; then
    backup="$dst.bak.$(date +%Y%m%d-%H%M%S)"
    say "  existing $skill → $(basename "$backup")"
    run mv -f "$dst" "$backup"
  fi
  run mkdir -p "$dst"
  run cp -rf "$src." "$dst/"
  say "  skill: $skill"
done

# 2. The independent acceptance agent.
run mkdir -p "$DEST/agents"
run cp -f "$PLUGIN/agents/ui-verifier.md" "$DEST/agents/ui-verifier.md"
say "  agent: ui-verifier"

# 3. The acceptance hook. Silent everywhere except projects with .uiverify.json.
run mkdir -p "$DEST/hooks"
run cp -f "$PLUGIN/hooks/ui-verify-gate.sh" "$DEST/hooks/ui-verify-gate.sh"
run chmod +x "$DEST/hooks/ui-verify-gate.sh"
say "  hook: ui-verify-gate.sh"

# 4. Browser and axe go inside the skill, not into the project.
if [ "$DRY" = 0 ]; then
  say ""
  say "Installing playwright and axe-core inside the skill (~250 MB with the browser)…"
  ( cd "$DEST/skills/frontend-quality" && npm install --silent && npx --yes playwright install chromium )
fi

say ""
say "Check that it is alive:"
say "  node $DEST/skills/frontend-quality/scripts/verify-ui.mjs --url https://example.com/"
say "  bash  $DEST/skills/frontend-quality/scripts/check-forbidden.sh ."
say ""
say "The gate switches on with a .uiverify.json in the project root. Template:"
say "  $DEST/skills/frontend-quality/reference/uiverify.example.json"
say ""
say "To make the hook block a turn, add this to $DEST/settings.json:"
cat <<'JSON'
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash \"/full/path/.claude/hooks/ui-verify-gate.sh\"" } ] }
    ]
  }
JSON
say ""
say "Where to start on your project: skills/frontend-quality/reference/adopt.md"
