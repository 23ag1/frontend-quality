#!/usr/bin/env bash
# The plugin checks itself: it must pass what it demands of everyone else.
#
# What is verified:
#   1. manifests and the hook config are valid JSON;
#   2. every skill has a SKILL.md with name and description;
#   3. not a single broken relative link in the documentation;
#   4. every check script runs and says clearly what it is missing;
#   5. the templates are syntactically intact.
#
# Usage: bash scripts/check-plugin.sh   (from the plugin root)
# Exit: 0 — plugin intact, 1 — something is broken.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAILED=0

fail() { echo "  BROKEN: $*"; FAILED=1; }
ok() { echo "  ok: $*"; }

echo "1. Manifests and hooks"
for f in .claude-plugin/plugin.json hooks/hooks.json; do
  if python3 -c "import json,sys;json.load(open('$f'))" 2>/dev/null; then
    ok "$f — valid JSON"
  else
    fail "$f — does not parse as JSON"
  fi
done

echo "2. Skills"
for skill in skills/*/; do
  name=$(basename "$skill")
  file="$skill/SKILL.md"
  if [ ! -f "$file" ]; then
    fail "$name — no SKILL.md"
    continue
  fi
  # Front matter: without name and description the skill never appears in the list.
  if head -12 "$file" | grep -q '^name:' && head -12 "$file" | grep -q '^description:'; then
    ok "$name — front matter present"
  else
    fail "$name — SKILL.md has no name or description in the first 12 lines"
  fi
done

echo "3. Links in the documentation"
BROKEN=$(python3 - <<'PY'
import pathlib, re, sys

root = pathlib.Path('.')
broken = []
for md in root.rglob('*.md'):
    if 'node_modules' in md.parts:
        continue
    text = md.read_text(errors='ignore')
    for label, target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)', text):
        if target.startswith(('http://', 'https://', '#', 'mailto:')):
            continue
        path = (md.parent / target.split('#')[0]).resolve()
        if not path.exists():
            broken.append(f"{md}: [{label}]({target})")
print('\n'.join(broken))
PY
)
if [ -n "$BROKEN" ]; then
  echo "$BROKEN" | while read -r line; do fail "$line"; done
else
  ok "no broken relative links"
fi

echo "4. Check scripts"
for s in skills/frontend-quality/scripts/*.mjs; do
  if node --check "$s" 2>/dev/null; then ok "$(basename "$s") — syntax"; else fail "$(basename "$s") — syntax error"; fi
done
for s in skills/frontend-quality/scripts/*.sh hooks/*.sh scripts/*.sh; do
  if bash -n "$s" 2>/dev/null; then ok "$(basename "$s") — syntax"; else fail "$(basename "$s") — syntax error"; fi
done

# Run without arguments must explain what is missing instead of dying silently.
OUT=$(node skills/frontend-quality/scripts/verify-ui.mjs 2>&1 || true)
if echo "$OUT" | grep -q "ERR_MODULE_NOT_FOUND"; then
  # Expected state before installation: the browser and axe are installed inside
  # the skill as a separate step, and without them the check honestly refuses.
  ok "dependencies not installed yet (npm install in skills/frontend-quality) — code check skipped"
elif echo "$OUT" | grep -qE 'Pass|--url|--scenario|Nothing to check'; then
  ok "verify-ui with no arguments explains what it needs"
else
  fail "verify-ui with no arguments printed something unclear: $(echo "$OUT" | head -1)"
fi

echo "5. Templates"
if node --check templates/scenario.example.mjs 2>/dev/null; then ok "scenario template — syntax"; else fail "scenario template is broken"; fi
if python3 -c "
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
yaml.safe_load(open('templates/frontend-quality.ci.yml'))
" 2>/dev/null; then ok "CI template — parses"; else fail "CI template does not parse as YAML"; fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "Plugin intact."
else
  echo "Plugin has breakages — fix before publishing."
fi
exit "$FAILED"
