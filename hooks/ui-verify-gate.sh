#!/usr/bin/env bash
# Stop hook: refuses to close a turn while the mechanical layout check is red.
#
# Fires ONLY in projects with a .uiverify.json in the root.
# Everywhere else it exits immediately and does nothing.
#
# Exit codes: 0 — let the turn close, 2 — block and hand the reason back.

set -uo pipefail

PAYLOAD=$(cat)
SKILL_DIR="$HOME/.claude/skills/frontend-quality/scripts"

# Loop guard: if the turn is already blocked by this hook, do not block again.
if echo "$PAYLOAD" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# Project marker. No file — this check does not apply to the project.
[ -f ".uiverify.json" ] || exit 0

FAILED=0
REPORT=""

# Scope of the check. In a monorepo the new frontend usually lives next to legacy
# code with hundreds of violations; a gate over the whole tree would be red
# always and would simply be switched off. So the project declares what it is
# ready to keep green:
# Field absent — the whole tree is checked, as before.
CHECK_PATHS=$(python3 -c "
import json
try:
    paths = json.load(open('.uiverify.json')).get('checkPaths') or ['.']
except Exception:
    paths = ['.']
print('\n'.join(str(p) for p in paths))
" 2>/dev/null || echo ".")

while IFS= read -r path; do
  [ -z "$path" ] && continue
  [ -e "$path" ] || continue
  if OUTPUT=$(bash "$SKILL_DIR/check-forbidden.sh" "$path" 2>&1); then
    :
  else
    FAILED=1
    REPORT="${REPORT}
Bans check failed ($path):
${OUTPUT}"
  fi
done <<EOF
$CHECK_PATHS
EOF

if command -v node >/dev/null 2>&1; then
  if OUTPUT=$(node "$SKILL_DIR/verify-ui.mjs" --config .uiverify.json 2>&1); then
    :
  else
    CODE=$?
    if [ "$CODE" -eq 2 ]; then
      # The check could not start (no playwright, server not running).
      # That is not a reason to block the turn, but the model should know.
      REPORT="${REPORT}
Browser check could not run: ${OUTPUT}"
    else
      FAILED=1
      REPORT="${REPORT}
Browser check failed:
${OUTPUT}"
    fi
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "[frontend-quality] Turn not closed: the layout check is red." >&2
  echo "$REPORT" >&2
  echo "Fix the cause and run again. Saying 'done' before green is not allowed." >&2
  exit 2
fi

[ -n "$REPORT" ] && echo "$REPORT" >&2
exit 0
