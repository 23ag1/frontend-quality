#!/usr/bin/env bash
# Stop hook: refuses to close a turn while the mechanical layout check is red.
#
# Fires ONLY in projects with a .uiverify.json in the root.
# Everywhere else it exits immediately and does nothing.
#
# What it runs, all scoped by checkPaths:
#   check-forbidden.sh       — text-level bans in the source;
#   check-browser-floor.mjs  — features above the project's browser floor
#                              (only when browserFloor or a browserslist exists);
#   verify-ui.mjs            — the browser check, only with a gateScenario.
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

cfg() {
  python3 -c "
import json, sys
try:
    v = json.load(open('.uiverify.json')).get(sys.argv[1])
except Exception:
    v = None
if isinstance(v, list):
    print('\n'.join(str(x) for x in v))
elif v is not None:
    print(v)
" "$1" 2>/dev/null
}

# Scope of the check. In a monorepo the new frontend usually lives next to legacy
# code with hundreds of violations; a gate over the whole tree would be red
# always and would simply be switched off. So the project declares what it is
# ready to keep green. Field absent — the whole tree is checked.
CHECK_PATHS=$(cfg checkPaths)
[ -z "$CHECK_PATHS" ] && CHECK_PATHS="."

# Nothing changed in the checked paths since the last run — skip.
# Measured on a real project: 8 of 11 blocks came on turns that never touched the
# frontend, and every run costs ~5 s. The stamp is HEAD plus the diff of the paths.
#
# A red result is remembered too. Without that, one red line left by one session
# blocked every other session in the same tree on every turn — seven blocks in
# four minutes across five sessions that never touched the frontend. The same red
# state is reported once; it blocks again only after the checked paths change.
STAMP_FILE=""
RED_FILE=""
STAMP=""
if GIT_DIR_PATH=$(git rev-parse --git-dir 2>/dev/null); then
  # shellcheck disable=SC2086
  STAMP=$( { git rev-parse HEAD; git diff HEAD -- $CHECK_PATHS; git ls-files --others --exclude-standard -- $CHECK_PATHS; } 2>/dev/null | sha1sum | cut -d' ' -f1)
  STAMP_FILE="$GIT_DIR_PATH/ui-verify-gate.stamp"
  RED_FILE="$GIT_DIR_PATH/ui-verify-gate.red"
  if [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$STAMP" ]; then
    exit 0
  fi
  if [ -f "$RED_FILE" ] && [ "$(cat "$RED_FILE")" = "$STAMP" ]; then
    echo "[frontend-quality] The layout check is still red from an earlier turn; nothing in checkPaths changed since. Run the checks by hand to see it." >&2
    exit 0
  fi
fi

# Only blocking findings go into the report. Warnings are counted, not listed:
# a block buried under 80 FLAG lines is a block nobody reads.
blocking_only() {
  awk '
    /^[[:space:]]*(BLOCK|FLAG)[[:space:]]/ { kind = ($0 ~ /BLOCK/) ? "BLOCK" : "FLAG" }
    /^[[:space:]]*BLOCK[[:space:]]/        { print; next }
    /^[[:space:]]*FLAG[[:space:]]/         { flags++; next }
    kind == "FLAG"         { next }
    { print }
    END { if (flags) printf "(+%d warning group(s) not shown — run the check by hand to see them)\n", flags }
  '
}

while IFS= read -r path; do
  [ -z "$path" ] && continue
  [ -e "$path" ] || continue
  if OUTPUT=$(bash "$SKILL_DIR/check-forbidden.sh" "$path" 2>&1); then
    :
  else
    FAILED=1
    REPORT="${REPORT}
Bans check failed ($path):
$(echo "$OUTPUT" | blocking_only)"
  fi
done <<EOF
$CHECK_PATHS
EOF

# Browser floor: static, takes about a second. Runs only when the project has
# declared a floor (browserFloor in .uiverify.json or a browserslist); without a
# floor every modern feature would be "above" it.
if [ -f "$SKILL_DIR/check-browser-floor.mjs" ] && command -v node >/dev/null 2>&1; then
  if [ -n "$(cfg browserFloor)" ] || grep -q '"browserslist"' package.json 2>/dev/null || [ -f .browserslistrc ]; then
    # shellcheck disable=SC2086
    if OUTPUT=$(node "$SKILL_DIR/check-browser-floor.mjs" $CHECK_PATHS 2>&1); then
      :
    else
      CODE=$?
      if [ "$CODE" -eq 1 ]; then
        FAILED=1
        REPORT="${REPORT}
Browser floor check failed:
$(echo "$OUTPUT" | blocking_only)"
      fi
    fi
  fi
fi

# The browser part runs only with a scenario of the working screen ("gateScenario"
# in .uiverify.json). Without one it checks the entry screen — measured: all of its
# blocks were noise, while the real finds came from scenario runs. Capped at 90 s:
# a gate that hangs gets switched off.
GATE_SCENARIO=$(cfg gateScenario)

if [ -n "$GATE_SCENARIO" ] && command -v node >/dev/null 2>&1; then
  if OUTPUT=$(timeout 90 node "$SKILL_DIR/verify-ui.mjs" --config .uiverify.json --scenario "$GATE_SCENARIO" 2>&1); then
    :
  else
    CODE=$?
    if [ "$CODE" -eq 2 ] || [ "$CODE" -eq 124 ]; then
      # The check could not start (no playwright, server not running) or ran
      # past the cap. Not a reason to block the turn, but the model should know.
      REPORT="${REPORT}
Browser check could not run (exit $CODE): $(echo "$OUTPUT" | tail -3)"
    else
      FAILED=1
      REPORT="${REPORT}
Browser check failed:
$(echo "$OUTPUT" | blocking_only)"
    fi
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  [ -n "$RED_FILE" ] && echo "$STAMP" > "$RED_FILE"
  echo "[frontend-quality] Turn not closed: the layout check is red." >&2
  echo "$REPORT" >&2
  echo "Fix the cause and run again. Saying 'done' before green is not allowed." >&2
  exit 2
fi

[ -n "$STAMP_FILE" ] && echo "$STAMP" > "$STAMP_FILE"
[ -n "$RED_FILE" ] && rm -f "$RED_FILE"
[ -n "$REPORT" ] && echo "$REPORT" >&2
exit 0
