#!/usr/bin/env bash
# Text-level bans: the ones cheaper to catch by reading source than by browser.
# Usage: check-forbidden.sh [directory]   (defaults to the current one)
#
# Exit: 0 — clean, 1 — violations found.

set -uo pipefail
ROOT="${1:-.}"
VIOLATIONS=0

# Build and dependency directories hold generated and minified code the bans do
# not apply to.
PRUNE=( node_modules .next out dist build .output .vercel coverage .git .turbo storybook-static )
PRUNE_EXPR=()
for dir in "${PRUNE[@]}"; do
  PRUNE_EXPR+=( -name "$dir" -o )
done
unset 'PRUNE_EXPR[${#PRUNE_EXPR[@]}-1]'

collect() {
  local pattern_args=()
  for ext in "$@"; do
    pattern_args+=( -name "*.$ext" -o )
  done
  unset 'pattern_args[${#pattern_args[@]}-1]'
  find "$ROOT" -type d \( "${PRUNE_EXPR[@]}" \) -prune -o \
       -type f \( "${pattern_args[@]}" \) -print 2>/dev/null |
    # Minified and generated files are filtered out by name and by line length.
    grep -vE '\.(min|bundle|chunk)\.' |
    while read -r file; do
      # Minification filter. One long line used to be enough to drop a whole file
      # from the check: a 2600-line page with a single 631-character line was never
      # scanned at all, and the report quietly said "clean".
      # Minification means long lines PREVAIL, not that one shows up.
      if awk '
        { total++; if (length($0) > 500) long++ }
        END {
          if (total < 3) exit 1
          exit (long / total > 0.2) ? 1 : 0
        }
      ' "$file"; then
        echo "$file"
      fi
    done
}

FLAGS=0

# report <severity> <title> <regex> <file list>
# BLOCK fails the check. FLAG reports without failing: such places can be
# legitimate, and a human decides.
report() {
  local severity="$1" title="$2" pattern="$3" files="$4"
  [ -z "$files" ] && return
  local hits
  hits=$(echo "$files" | xargs grep -nE "$pattern" 2>/dev/null || true)
  [ -z "$hits" ] && return
  local count
  count=$(echo "$hits" | wc -l)
  echo ""
  echo "$severity — $title ($count)"
  echo "$hits" | head -15 | cut -c1-160 | sed 's/^/  /'
  [ "$count" -gt 15 ] && echo "  … and $((count - 15)) more"
  if [ "$severity" = "BLOCK" ]; then
    VIOLATIONS=$((VIOLATIONS + count))
  else
    FLAGS=$((FLAGS + count))
  fi
}

MARKUP=$(collect tsx jsx html vue svelte astro)
STYLES=$(collect css scss)
ALL_SRC=$(printf '%s\n%s\n' "$MARKUP" "$STYLES" | grep -v '^$' || true)

if [ -z "$ALL_SRC" ]; then
  echo "No markup or style sources found in $ROOT"
  exit 0
fi

# 1. Numbering with a leading zero — banned everywhere, decorative counters included.
#    The zero is caught with text after it too: "01 — step one" is the same ban
#    as a lone "01" in a cell.
report BLOCK "numbering with a leading zero (01, 02, …)" \
  '>[[:space:]]*0[1-9]([[:space:]]|<|[.,)—-])|"0[1-9]"|'"'"'0[1-9]'"'"'|decimal-leading-zero' \
  "$ALL_SRC"

# 2. Inline styles and !important.
report BLOCK "static inline style=\"...\"" 'style="' "$MARKUP"
report FLAG "inline style={{ }} (dynamic is fine, static belongs in a class)" \
  'style=\{\{' "$MARKUP"
IMPORTANT_HITS=$(echo "$ALL_SRC" | while read -r f; do
  awk -v file="$f" '
    /prefers-reduced-motion/ { inblock = 1 }
    inblock && /}/ { depth--; if (depth <= 0) inblock = 0 }
    inblock && /{/ { depth++ }
    {
      # Comments are stripped entirely, multi-line ones included: the phrase
      # "no !important needed here" in a note is an explanation, not a violation.
      line = $0
      if (incomment) {
        if (match(line, /\*\//)) { line = substr(line, RSTART + 2); incomment = 0 }
        else next
      }
      while (match(line, /\/\*/)) {
        head = substr(line, 1, RSTART - 1)
        tail = substr(line, RSTART + 2)
        if (match(tail, /\*\//)) { line = head substr(tail, RSTART + 2) }
        else { line = head; incomment = 1; break }
      }
      sub(/\/\/.*/, "", line)
      if (line ~ /!important/ && !inblock) printf "%s:%d:%s\n", file, NR, $0
    }
  ' "$f"
done)
if [ -n "$IMPORTANT_HITS" ]; then
  count=$(echo "$IMPORTANT_HITS" | wc -l)
  echo ""
  echo "BLOCK — !important ($count)"
  echo "$IMPORTANT_HITS" | head -15 | cut -c1-160 | sed 's/^/  /'
  VIOLATIONS=$((VIOLATIONS + count))
fi

# 3. Hard-coded colours instead of tokens — in markup only.
#    Theme, token and global style files are excluded: that is where they belong.
MARKUP_NO_THEME=$(echo "$MARKUP" | grep -vE 'tokens|theme|globals|tailwind\.config' || true)
report FLAG "raw HEX in markup instead of a token" '#[0-9a-fA-F]{6}\b' "$MARKUP_NO_THEME"

# 4. Fixed height on a container with variable content.
#    Catches h-[240px] but not max-h-/min-h-: those do the opposite job —
#    hold a ceiling without cutting the content off.
report FLAG "fixed height (check that the content is not variable)" \
  '(^|[^-a-zA-Z])h-\[[0-9]+px\]' "$MARKUP"

# 5. vh instead of dvh — breaks on mobile because of the browser chrome.
VH_HITS=$(echo "$ALL_SRC" | xargs grep -nE '\b[0-9]+vh\b' 2>/dev/null \
  | grep -v 'dvh' \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' \
  | grep -v '\*/' || true)
if [ -n "$VH_HITS" ]; then
  count=$(echo "$VH_HITS" | wc -l)
  echo ""
  echo "BLOCK — vh instead of dvh ($count)"
  echo "$VH_HITS" | head -15 | cut -c1-160 | sed 's/^/  /'
  VIOLATIONS=$((VIOLATIONS + count))
fi

# 6. Internals leaking into visible text.
#    The rule "the interface speaks the user's language" lived as a paragraph in a
#    document, which means it did not work. Field names are searched only in PLAIN
#    text between tags — inside an expression they are ordinary code.
# Words from behind the curtain: they have no place in a label meant for a person.
UI_WORDS='backend|back-end|endpoint|end-point|API handler|the server (returned|responded|is unavailable)|SKU|JSON|payload|token|deploy|staging|production'
# Field names are searched only in PLAIN text between tags: inside an expression
# like `${item.product_id}` this is ordinary code, not a leak.
UI_FIELDS='dish_id|client_id|user_id|restaurant_id|order_id|iiko_[a-z_]+'
# The vocabulary is configurable per project and per interface language: fields
# "lexicon" (words) and "lexiconFields" (field names) in .uiverify.json. When set,
# they replace the built-in defaults and work for any language.
CONFIG_JSON=""
for candidate in "$ROOT/.uiverify.json" ".uiverify.json"; do
  [ -f "$candidate" ] && { CONFIG_JSON="$candidate"; break; }
done
CUSTOM_WORDS=""
CUSTOM_FIELDS=""
if [ -n "$CONFIG_JSON" ]; then
  CUSTOM_WORDS=$(python3 -c "
import json
try:
    print('|'.join(json.load(open('$CONFIG_JSON')).get('lexicon') or []))
except Exception:
    print('')
" 2>/dev/null || echo "")
  CUSTOM_FIELDS=$(python3 -c "
import json
try:
    print('|'.join(json.load(open('$CONFIG_JSON')).get('lexiconFields') or []))
except Exception:
    print('')
" 2>/dev/null || echo "")
fi
[ -n "$CUSTOM_FIELDS" ] && UI_FIELDS="$CUSTOM_FIELDS"

if [ -n "$CUSTOM_WORDS" ]; then
  UI_HITS=$(
    {
      echo "$MARKUP" | xargs grep -nEi ">[^<{]*($CUSTOM_WORDS)[^<]*<" 2>/dev/null
      echo "$MARKUP" | xargs grep -nE ">[^<{]*($UI_FIELDS)[^<]*<" 2>/dev/null
    } | grep -vE '(//|/\*|\*)[[:space:]]' | sort -u || true
  )
else
  UI_HITS=$(
    {
      echo "$MARKUP" | xargs grep -nEi ">[^<{]*($UI_WORDS)[^<]*<" 2>/dev/null
      echo "$MARKUP" | xargs grep -nE ">[^<{]*($UI_FIELDS)[^<]*<" 2>/dev/null
    } | grep -vE '(//|/\*|\*)[[:space:]]' | sort -u || true
  )
fi
# An escape hatch for legitimate cases: the marker `ui-lexicon-ok` on the line
# itself or in a comment above it clears the finding. Needed where a field name
# is part of the user's own task (a required column in a file they upload), not a
# leak of internal structure.
if [ -n "$UI_HITS" ]; then
  UI_HITS=$(printf '%s\n' "$UI_HITS" | python3 -c "
import sys, pathlib
kept = []
for row in sys.stdin.read().splitlines():
    parts = row.split(':', 2)
    if len(parts) < 3:
        kept.append(row); continue
    path, lineno = parts[0], parts[1]
    try:
        lines = pathlib.Path(path).read_text(errors='ignore').splitlines()
        n = int(lineno) - 1
        window = lines[max(0, n - 3):n + 1]
    except Exception:
        window = []
    if any('ui-lexicon-ok' in w for w in window):
        continue
    kept.append(row)
print('\n'.join(kept))
" 2>/dev/null || printf '%s\n' "$UI_HITS")
  UI_HITS=$(printf '%s\n' "$UI_HITS" | grep -v '^$' || true)
fi
if [ -n "$UI_HITS" ]; then
  count=$(echo "$UI_HITS" | wc -l)
  echo ""
  echo "BLOCK — internal terms in visible text ($count)"
  echo "$UI_HITS" | head -15 | cut -c1-160 | sed 's/^/  /'
  [ "$count" -gt 15 ] && echo "  … and $((count - 15)) more"
  VIOLATIONS=$((VIOLATIONS + count))
fi

# 7. Motion without respect for the system "reduce motion" setting.
#    Presence is checked, not correctness: whether it actually works is measured
#    by verify-motion.mjs in the browser.
HAS_MOTION=$(echo "$ALL_SRC" | xargs grep -lE 'animation:|@keyframes|transition:|transition-|animate-' 2>/dev/null | head -1 || true)
HAS_GUARD=$(echo "$ALL_SRC" | xargs grep -lE 'prefers-reduced-motion' 2>/dev/null | head -1 || true)
if [ -n "$HAS_MOTION" ] && [ -z "$HAS_GUARD" ]; then
  echo ""
  echo "FLAG — the project has animations but prefers-reduced-motion appears nowhere (1)"
  echo "  first file with motion: $HAS_MOTION"
  FLAGS=$((FLAGS + 1))
fi

# 8. Markup from a string, bypassing escaping.
report FLAG "dangerouslySetInnerHTML (check sanitisation)" 'dangerouslySetInnerHTML' "$MARKUP"

# 9. A request without a timeout.
#    A real failure: the response was cut mid-flight (a proxy severed the chunked
#    transfer), the promise NEVER settled, `finally` never ran and the loading
#    skeleton hung forever. Cured by AbortSignal.timeout.
CODE=$(collect ts tsx js jsx mjs)
# The signal usually sits NOT on the call line but in the options object below, so
# a window of lines is inspected — otherwise the rule drowns in false positives.
FETCH_HITS=$(echo "$CODE" | xargs grep -nE '\bfetch\(' 2>/dev/null \
  | grep -vE '(^|[^:]):[0-9]+:[[:space:]]*(//|\*|/\*)' \
  | python3 -c "
import sys, pathlib
SAFE = ('signal', 'AbortSignal', 'timeout', 'withTimeout', 'apiFetch', 'fetchWithTimeout')
kept = []
cache = {}
for row in sys.stdin.read().splitlines():
    parts = row.split(':', 2)
    if len(parts) < 3:
        continue
    path, lineno = parts[0], parts[1]
    if path not in cache:
        try:
            cache[path] = pathlib.Path(path).read_text(errors='ignore').splitlines()
        except Exception:
            cache[path] = []
    lines = cache[path]
    n = int(lineno) - 1
    window = ' '.join(lines[max(0, n - 1):n + 6])
    if any(token in window for token in SAFE):
        continue
    kept.append(row)
print('\n'.join(kept))
" 2>/dev/null || true)
if [ -n "$FETCH_HITS" ]; then
  count=$(echo "$FETCH_HITS" | wc -l)
  echo ""
  echo "FLAG — fetch without a timeout/signal ($count)"
  echo "$FETCH_HITS" | head -10 | cut -c1-160 | sed 's/^/  /'
  [ "$count" -gt 10 ] && echo "  … and $((count - 10)) more"
  FLAGS=$((FLAGS + count))
fi

# 10. Mixed event types on one element.
#     A real failure: a tile listened to touchend (otherwise the tap was lost in a
#     scrollable sheet) while nested buttons stopped propagation only for click —
#     the finger reached both and the counter added twice. Stop it on the SAME type.
MIX_HITS=$(echo "$MARKUP" | while read -r f; do
  [ -f "$f" ] || continue
  # The syntax differs across React, Vue and Svelte — the failure is the same.
  TOUCH='onTouch(End|Start)|@touch(end|start)|on:touch(end|start)|addEventListener\(.touch(end|start)'
  CLICK='onClick|@click|on:click|addEventListener\(.click'
  if grep -qE "$TOUCH" "$f" && grep -qE "$CLICK" "$f" && grep -qE 'stopPropagation' "$f"; then
    printf '%s:%s\n' "$f" "$(grep -nE "$TOUCH" "$f" | head -1 | cut -d: -f1)"
  fi
done)
if [ -n "$MIX_HITS" ]; then
  count=$(echo "$MIX_HITS" | wc -l)
  echo ""
  echo "FLAG — click and touch in one component with stopPropagation ($count)"
  echo "  Check that propagation is stopped on the same event type the parent listens to."
  echo "$MIX_HITS" | head -10 | sed 's/^/  /'
  FLAGS=$((FLAGS + count))
fi

# 11. A lone em dash standing in for data.
#     It reads as "zero" or as a failure; the right text is "no data".
report FLAG "lone dash instead of \"no data\"" '>[[:space:]]*(—|–)[[:space:]]*<' "$MARKUP"

echo ""
echo "Bans: blocking — $VIOLATIONS, warnings — $FLAGS"
[ "$VIOLATIONS" -eq 0 ] && exit 0
exit 1
