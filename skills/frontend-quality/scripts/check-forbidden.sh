#!/usr/bin/env bash
# Text-level bans: the ones cheaper to catch by reading source than by browser.
# Usage: check-forbidden.sh [directory]   (defaults to the current one)
#
# Project settings come from .uiverify.json, looked up in the directory, then in
# its parents, then in the current directory. UIVERIFY_CONFIG=<file> points at
# another file; UIVERIFY_CONFIG=none ignores every config. Keys read here:
#   lexicon, lexiconFields   internal words and field names banned in visible text
#   browserFloor     {"chrome":106,"safari":15} — the oldest engines in real use;
#                    without it the floor comes from package.json "browserslist"
#   paletteClasses   "block" turns the Tailwind palette warning into a block
#   networkPaths     directories of the network layer; raw fetch elsewhere is flagged
#   minFontPx        the smallest allowed font size, 16 by default
#   allowMono        true lets monospace through
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
      # A short file is judged by its lines too, not by its length: "fewer than
      # three lines means minified" silently skipped every one-line CSS module and
      # every two-line component — `.a{height:100vh}` alone was never read.
      if awk '
        { total++; if (length($0) > 500) long++ }
        END {
          if (total == 0) exit 1
          if (total < 3) exit (long > 0) ? 1 : 0
          exit (long / total > 0.2) ? 1 : 0
        }
      ' "$file"; then
        echo "$file"
      fi
    done
}

FLAGS=0

# print_group <severity> <title> <why> <hits> [limit]
# The title names the rule, the "why" line says what breaks for a person, the
# hits are file:line:text.
print_group() {
  local severity="$1" title="$2" why="$3" hits="$4" limit="${5:-15}"
  [ -z "$hits" ] && return
  local count
  count=$(printf '%s\n' "$hits" | grep -c .)
  [ "$count" -eq 0 ] && return
  echo ""
  echo "$severity — $title ($count)"
  [ -n "$why" ] && echo "  why: $why"
  # Trim the source text, never the location: a cut over the whole line lost the
  # very part that says what is wrong as soon as the project path was long.
  printf '%s\n' "$hits" | grep . | head -"$limit" \
    | awk '{ if (match($0, /^[^:]+:[0-9]+:/)) { loc = substr($0, 1, RLENGTH); txt = substr($0, RLENGTH + 1) } else { loc = ""; txt = $0 }
             sub(/^[ \t]+/, "", txt); if (length(txt) > 140) txt = substr(txt, 1, 140) "…"; print "  " loc " " txt }'
  [ "$count" -gt "$limit" ] && echo "  … and $((count - limit)) more"
  if [ "$severity" = "BLOCK" ]; then
    VIOLATIONS=$((VIOLATIONS + count))
  else
    FLAGS=$((FLAGS + count))
  fi
}

# report <severity> <title> <regex> <file list> [why]
# BLOCK fails the check. FLAG reports without failing: such places can be
# legitimate, and a human decides.
report() {
  local severity="$1" title="$2" pattern="$3" files="$4" why="${5:-}"
  [ -z "$files" ] && return
  local hits
  hits=$(printf '%s\n' "$files" | grep -v '^$' | tr '\n' '\0' | xargs -0 grep -HnE "$pattern" 2>/dev/null || true)
  print_group "$severity" "$title" "$why" "$hits"
}

MARKUP=$(collect tsx jsx html vue svelte astro)
STYLES=$(collect css scss)
ALL_SRC=$(printf '%s\n%s\n' "$MARKUP" "$STYLES" | grep -v '^$' || true)

if [ -z "$ALL_SRC" ]; then
  echo "No markup or style sources found in $ROOT"
  exit 0
fi

# ---------------------------------------------------------------------------
# Project settings. Read once; every value is shell-quoted by Python.
# (read -d '' rather than $(cat <<EOF): bash 3.2 on macOS misparses quotes and
# parentheses inside a here-document nested in a command substitution.)
# ---------------------------------------------------------------------------
read -r -d '' CFG_PY <<'PY' || true
import json, os, re, shlex, sys

root = os.path.abspath(sys.argv[1])
override = os.environ.get('UIVERIFY_CONFIG', '')

def start_dir():
    return root if os.path.isdir(root) else os.path.dirname(root)

def find_config():
    if override == 'none':
        return ''
    if override:
        return os.path.abspath(override) if os.path.isfile(override) else ''
    d = start_dir()
    while True:
        c = os.path.join(d, '.uiverify.json')
        if os.path.isfile(c):
            return c
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return os.path.abspath('.uiverify.json') if os.path.isfile('.uiverify.json') else ''

path = find_config()
cfg = {}
if path:
    try:
        cfg = json.load(open(path, encoding='utf-8'))
    except Exception:
        cfg = {}

def out(name, value):
    print(name + '=' + shlex.quote(str(value)))

out('CONFIG_JSON', path)
out('CONFIG_DIR', os.path.dirname(path) if path else os.path.abspath('.'))
out('CUSTOM_WORDS', '|'.join(cfg.get('lexicon') or []))
out('CUSTOM_FIELDS', '|'.join(cfg.get('lexiconFields') or []))
out('PALETTE_MODE', 'block' if str(cfg.get('paletteClasses', '')).lower() == 'block' else 'flag')
out('HAS_NETWORK_PATHS', '1' if 'networkPaths' in cfg else '0')
out('NETWORK_PATHS', '\n'.join(cfg.get('networkPaths') or []))
try:
    out('MIN_FONT', float(cfg.get('minFontPx', 16)))
except Exception:
    out('MIN_FONT', 16)
out('ALLOW_MONO', '1' if cfg.get('allowMono') is True else '0')

# Browser floor: the config wins; otherwise the nearest package.json browserslist
# (or .browserslistrc). Only a query that names chrome gives a chrome floor.
def rc_queries(rc):
    lines = open(rc, encoding='utf-8').read().splitlines()
    return [l for l in lines if l.strip() and not l.lstrip().startswith(('#', '['))]

chrome = safari = None
source = ''
floor = cfg.get('browserFloor')
if isinstance(floor, dict) and floor:
    chrome = floor.get('chrome')
    safari = floor.get('safari')
    source = 'browserFloor in ' + os.path.basename(path)
else:
    queries, where = None, ''
    d = start_dir()
    while True:
        pkg = os.path.join(d, 'package.json')
        rc = os.path.join(d, '.browserslistrc')
        if os.path.isfile(rc):
            queries, where = rc_queries(rc), rc
            break
        if os.path.isfile(pkg):
            try:
                bl = json.load(open(pkg, encoding='utf-8')).get('browserslist')
            except Exception:
                bl = None
            if isinstance(bl, dict):
                bl = bl.get('production') or [q for v in bl.values() for q in (v if isinstance(v, list) else [v])]
            if isinstance(bl, str):
                bl = [bl]
            if bl:
                queries, where = bl, pkg
            break   # the nearest package.json is the project: stop here either way
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    if queries:
        text = ' , '.join(queries)
        cs = [int(v) + (1 if op == '>' else 0) for op, v in re.findall(r'\bchrome\s*(>=|>)?\s*(\d+)', text, re.I)]
        ss = [float(v) for v in re.findall(r'\b(?:safari|ios_saf|ios)\s*(?:>=|>)?\s*(\d+(?:\.\d+)?)', text, re.I)]
        chrome = min(cs) if cs else None
        safari = min(ss) if ss else None
        source = 'browserslist in ' + os.path.relpath(where) + ('' if cs else ' (it does not name chrome)')
out('FLOOR_CHROME', chrome if chrome is not None else '')
out('FLOOR_SAFARI', safari if safari is not None else '')
out('FLOOR_SOURCE', source)
PY
eval "$(python3 -c "$CFG_PY" "$ROOT" 2>/dev/null)"
: "${CONFIG_JSON:=}" "${CONFIG_DIR:=.}" "${CUSTOM_WORDS:=}" "${CUSTOM_FIELDS:=}" "${PALETTE_MODE:=flag}"
: "${HAS_NETWORK_PATHS:=0}" "${NETWORK_PATHS:=}" "${MIN_FONT:=16}" "${ALLOW_MONO:=0}"
: "${FLOOR_CHROME:=}" "${FLOOR_SAFARI:=}" "${FLOOR_SOURCE:=}"
export FQ_ROOT="$ROOT" FQ_CONFIG_DIR="$CONFIG_DIR" FQ_NETWORK_PATHS="$NETWORK_PATHS" FQ_MIN_FONT="$MIN_FONT"

# ---------------------------------------------------------------------------
# Context-aware scanner for the rules a line regex gets wrong: it strips comments
# (multi-line ones too), knows var() fallbacks, @supports blocks and which
# function a line sits in. Usage: scan <mode> <<< "$files"; prints TAG<TAB>hit.
# ---------------------------------------------------------------------------
read -r -d '' SCAN_PY <<'PY' || true
import os, re, sys, bisect

mode = sys.argv[1]
files = [f for f in sys.stdin.read().split('\n') if f]
cache = {}

def read(p):
    if p not in cache:
        try:
            cache[p] = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            cache[p] = ''
    return cache[p]

TOKEN = re.compile(r"/\*|//|<!--|[\"'`]")

def strip_comments(text, path):
    """Comments become spaces, line breaks stay, so line numbers survive.
    Strings are skipped so that "src/**/*.ts" does not open a comment."""
    css = path.endswith('.css')
    out = list(text)
    i, n = 0, len(text)
    def blank(a, b):
        for k in range(a, b):
            if out[k] != '\n':
                out[k] = ' '
    while True:
        m = TOKEN.search(text, i)
        if not m:
            break
        t, p = m.group(), m.start()
        if t == '/*':
            e = text.find('*/', p + 2)
            e = n if e < 0 else e + 2
            blank(p, e)
            i = e
        elif t == '<!--':
            e = text.find('-->', p + 4)
            e = n if e < 0 else e + 3
            blank(p, e)
            i = e
        elif t == '//':
            if not css and (p == 0 or text[p - 1] in ' \t\n;{}(,'):
                e = text.find('\n', p)
                e = n if e < 0 else e
                blank(p, e)
                i = e
            else:
                i = p + 2
        else:
            # A string: ' and " end at the line break (an apostrophe in JSX text
            # must not swallow the file), a template literal may span lines.
            j = p + 1
            while j < n:
                c = text[j]
                if c == '\\':
                    j += 2
                    continue
                if c == t or (c == '\n' and t != '`'):
                    break
                j += 1
            i = j + 1
    return ''.join(out)

def lines_of(text):
    return [0] + [m.end() for m in re.finditer(r'\n', text)]

def where(starts, pos):
    ln = bisect.bisect_right(starts, pos) - 1
    return ln, pos - starts[ln]

def emit(tag, path, ln, raw_lines):
    text = raw_lines[ln] if ln < len(raw_lines) else ''
    print(tag + '\t' + path + ':' + str(ln + 1) + ':' + text)

def is_test(p):
    # Judged below the checked directory: a project that itself lives under
    # some ".../tests/..." path is not a test.
    rel = '/' + os.path.relpath(p, os.environ.get('FQ_ROOT', '.')).replace(os.sep, '/')
    return bool(re.search(r'(\.(test|spec|stories)\.[jt]sx?$)|(/(__tests__|e2e|tests?)/)', rel))

# ---------------------------------------------------------------- viewport units
UNIT = re.compile(r'(?<![\w.#-])(?:\d+\.?\d*|\.\d+)(vh|[dsl]v[hw])\b')
# Tailwind's h-screen family is height: 100vh under another name.
TWSCREEN = re.compile(r'(?<![\w\[-])((?:min-|max-)?h-screen)(?![\w-])')
TWDYN = re.compile(r'(?<![\w\[-])((?:min-|max-)?(?:h|w|size|top|bottom|inset|inset-x|inset-y)-[dsl]v[hw])(?![\w-])')
DYN_IN_COND = re.compile(r'(?:\d*\.?\d+)[dsl]v[hw]\b')

def supports_kind(header):
    if not header.startswith('@supports'):
        return None
    if not DYN_IN_COND.search(header):
        return 'other'
    return 'neg' if re.search(r'\bnot\b', header) else 'pos'

def paren_ctx(prefix):
    stack = []
    for m in re.finditer(r'([\w-]*)\(|\)|,', prefix):
        t = m.group(0)
        if t == ')':
            if stack:
                stack.pop()
        elif t == ',':
            if stack and stack[-1][0] == 'var':
                stack[-1][1] = True
        else:
            stack.append([m.group(1).lower(), False])
    var_fallback = any(name == 'var' and fb for name, fb in stack)
    in_calc = any(name.endswith('calc') for name, _ in stack)
    return var_fallback, in_calc

def viewport():
    covered, pos_override, pos_classes = set(), set(), set()

    def open_block(stack, header):
        sk = supports_kind(header)
        stack.append((sk or ('at' if header.startswith('@') else 'rule'), header))
        if header.startswith('@'):
            return
        # A class redefined inside @supports not (…dvh…) is covered for old
        # engines; a selector redefined inside @supports (…dvh…) has its base
        # vh line as the deliberate fallback.
        if any(k == 'neg' for k, _ in stack[:-1]):
            covered.update(c.replace('\\', '') for c in re.findall(r'\.((?:\\.|[\w-])+)', header))
        if any(k == 'pos' for k, _ in stack[:-1]):
            pos_override.update(x.strip() for x in header.split(','))
            pos_classes.update(c.replace('\\', '') for c in re.findall(r'\.((?:\\.|[\w-])+)', header))

    per_file = []
    for path in files:
        raw = read(path)
        s = strip_comments(raw, path)
        hits = [(m.start(), 'unit', m.group(1)) for m in UNIT.finditer(s)]
        hits += [(m.start(1), 'tw', m.group(1)) for m in TWDYN.finditer(s)]
        hits += [(m.start(1), 'twvh', m.group(1)) for m in TWSCREEN.finditer(s)]
        hits.sort()
        events = [(m.start(), m.group()) for m in re.finditer(r'[{};]', s)]
        stack, last, ei, snap = [], -1, 0, []
        for pos, kind, val in hits + [(len(s) + 1, None, None)]:
            while ei < len(events) and events[ei][0] < pos:
                epos, ch = events[ei]
                if ch == '{':
                    open_block(stack, ' '.join(s[last + 1:epos].split()))
                elif ch == '}' and stack:
                    stack.pop()
                last = epos
                ei += 1
            if kind:
                snap.append((pos, kind, val, tuple(stack)))
        per_file.append((path, raw, s, snap))

    for path, raw, s, snap in per_file:
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        seen = set()
        for pos, kind, val, stack in snap:
            ln, col = where(starts, pos)
            end = starts[ln + 1] - 1 if ln + 1 < len(starts) else len(s)
            prefix = s[starts[ln]:end][:col]
            # A support check is not a height: @supports (height: 1dvh),
            # CSS.supports("height", "1dvh"), Tailwind supports-[height:1dvh]:…
            if re.search(r'@supports[^{]*$', prefix) or re.search(r'supports\s*\([^)]*$', prefix):
                continue
            token = re.split(r'[\s"\'`]', prefix)[-1]
            if 'supports-' in token:
                continue
            var_fb, in_calc = paren_ctx(prefix)
            if var_fb:
                continue
            kinds = [k for k, _ in stack]
            if kind == 'unit' and val == 'vh':
                if 'neg' in kinds:
                    continue
                rule = next((h for k, h in reversed(stack) if k == 'rule'), '')
                if rule and any(x.strip() in pos_override for x in rule.split(',')):
                    continue
                tag = 'VH'
            elif kind == 'twvh':
                # h-screen is fine where the project redefines the class inside
                # @supports — to dvh for new engines or to var(--app-h) for old.
                if val in covered or val in pos_classes:
                    continue
                tag = 'VH'
            else:
                if 'pos' in kinds:
                    continue
                if kind == 'tw' and val in covered:
                    continue
                tag = 'CALC' if in_calc else 'DVH'
            if (tag, ln) in seen:
                continue
            seen.add((tag, ln))
            emit(tag, path, ln, raw_lines)

# ------------------------------------------------------------- storage in render
DEFER = {'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useSyncExternalStore', 'useCallback',
         'addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback',
         'queueMicrotask', 'then', 'catch', 'finally', 'subscribe', 'Promise', 'startTransition'}
RENDER = {'useState', 'useMemo', 'useReducer', 'useRef'}
ITER = {'map', 'filter', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex', 'flatMap', 'sort'}
COMPONENT = re.compile(
    r'(?:^|[\s;(])(?:async\s+)?function\s*\*?\s*(?:[A-Z][\w$]*|use[A-Z][\w$]*)\s*[<(]'
    r'|(?:const|let|var)\s+(?:[A-Z][\w$]*|use[A-Z][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+?)?=>\s*$')
FUNC = re.compile(r'=>\s*$|\bfunction\b[^{]*$|^\s*(?:async\s+|static\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|with\b)[\w$]+\s*\([^)]*\)\s*(?::[^{]*)?$')

def innermost_call(head):
    stack = []
    for m in re.finditer(r'([\w$]*)\s*\(|\)', head):
        if m.group(0) == ')':
            if stack:
                stack.pop()
        else:
            stack.append((m.group(1), m.end()))
    return stack[-1] if stack else (None, 0)

def classify(head):
    """What a block or an expression runs as: render, deferred, or block (inherits)."""
    name, after = innermost_call(head)
    if name in DEFER:
        return 'deferred'
    if name in RENDER:
        return 'render'
    if name in ITER:
        return 'block'
    if name in ('memo', 'forwardRef'):
        return 'render'
    if name is not None and re.search(r'=>|\bfunction\b', head[after:]):
        return 'deferred'      # a callback handed to some call: runs later
    if COMPONENT.search(head):
        return 'render'
    if FUNC.search(head):
        return 'deferred'
    return 'block'

STORE = re.compile(r'\b(?:localStorage|sessionStorage)\b')

def storage():
    for path in files:
        if is_test(path):
            continue
        raw = read(path)
        s = strip_comments(raw, path)
        uses = [m.start() for m in STORE.finditer(s)
                if not re.search(r'typeof\s+(?:window\.)?$', s[max(0, m.start() - 20):m.start()])]
        if not uses:
            continue
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        events = [(m.start(), m.group()) for m in re.finditer(r'[{};]', s)]
        # A level remembers where its current statement began and where the one
        # before the last closed brace began: "function Page({ id }) {" is one head.
        stack, levels = [], [[0, 0]]
        ei, seen = 0, set()
        def head_at(pos):
            lvl = levels[-1]
            head = s[lvl[0]:pos]
            if re.match(r'\s*[),:]', head):
                head = s[lvl[1]:pos]
            return head[-400:]
        for pos in uses:
            while ei < len(events) and events[ei][0] < pos:
                epos, ch = events[ei]
                if ch == '{':
                    stack.append(classify(head_at(epos)))
                    levels.append([epos + 1, epos + 1])
                elif ch == '}':
                    if stack:
                        stack.pop()
                    if len(levels) > 1:
                        levels.pop()
                    # "}) {", "}: Props) {", "}, [])" continue the statement;
                    # anything else after a closing brace starts a new one.
                    nxt = re.match(r'\s*(\S)', s[epos + 1:epos + 80])
                    levels[-1][0] = epos + 1
                    if not (nxt and nxt.group(1) in '),:=.?['):
                        levels[-1][1] = epos + 1
                else:
                    levels[-1][0] = levels[-1][1] = epos + 1
                ei += 1
            verdict = classify(head_at(pos))
            if verdict == 'block':
                verdict = next((k for k in reversed(stack) if k != 'block'), 'module')
            if verdict == 'deferred':
                continue
            ln, _ = where(starts, pos)
            if ln in seen:
                continue
            seen.add(ln)
            emit('RENDER' if verdict == 'render' else 'MODULE', path, ln, raw_lines)

# ------------------------------------------------------- fetch outside network
def in_network(path):
    roots = [p for p in os.environ.get('FQ_NETWORK_PATHS', '').split('\n') if p.strip()]
    base = os.environ.get('FQ_CONFIG_DIR', '.')
    ap = os.path.abspath(path)
    norm = '/' + ap.replace(os.sep, '/').strip('/') + '/'
    for r in roots:
        full = os.path.abspath(os.path.join(base, r))
        if ap == full or ap.startswith(full.rstrip(os.sep) + os.sep):
            return True
        frag = r.strip().strip('/')
        if frag.startswith('./'):
            frag = frag[2:]
        if frag and ('/' + frag + '/' in norm or norm.rstrip('/').endswith('/' + frag)):
            return True
    return False

def fetchnet():
    for path in files:
        if is_test(path) or in_network(path):
            continue
        raw = read(path)
        s = strip_comments(raw, path)
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        seen = set()
        for m in re.finditer(r'(?<![\w$.])fetch\s*\(|\b(?:window|globalThis|self)\.fetch\s*\(', s):
            if re.search(r'(function|async)\s+$', s[max(0, m.start() - 12):m.start()]):
                continue
            ln, _ = where(starts, m.start())
            if ln not in seen:
                seen.add(ln)
                emit('FETCH', path, ln, raw_lines)

# ------------------------------------------------------ safe area without cover
def safearea():
    uses, cover = [], False
    for path in files:
        raw = read(path)
        s = strip_comments(raw, path)
        if re.search(r'viewport-fit\s*=\s*cover|viewportFit\s*:\s*["\']cover', s):
            cover = True
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        for m in re.finditer(r'env\(\s*safe-area-inset-', s):
            ln, _ = where(starts, m.start())
            uses.append((path, ln, raw_lines))
    if cover:
        return
    seen = set()
    for path, ln, raw_lines in uses:
        if (path, ln) not in seen:
            seen.add((path, ln))
            emit('SAFE', path, ln, raw_lines)

# ----------------------------------------------------------------- font floor
def fontsize():
    floor = float(os.environ.get('FQ_MIN_FONT', '16') or 16)
    named = {'xs': 12, 'sm': 14}
    px = lambda v, unit: float(v) * (16 if unit == 'rem' else 1)
    pats = [
        (re.compile(r'(?<![\w\[-])text-(xs|sm)(?![\w-])'), lambda m: named[m.group(1)]),
        (re.compile(r'(?<![\w-])text-\[(\d*\.?\d+)(px|rem)\]'), lambda m: px(m.group(1), m.group(2))),
        (re.compile(r'(?<![\w-])font-size\s*:\s*(\d*\.?\d+)(px|rem)\b'), lambda m: px(m.group(1), m.group(2))),
        (re.compile(r'\bfontSize\s*:\s*(["\']?)(\d*\.?\d+)(px|rem)?\1(?![\w.])'), lambda m: px(m.group(2), m.group(3))),
    ]
    for path in files:
        raw = read(path)
        s = strip_comments(raw, path)
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        seen = set()
        for rx, size in pats:
            for m in rx.finditer(s):
                try:
                    value = size(m)
                except Exception:
                    continue
                if value >= floor or value == 0:
                    continue
                ln, _ = where(starts, m.start())
                if ln not in seen:
                    seen.add(ln)
                    emit('FONT', path, ln, raw_lines)

HEX = re.compile(r'(?:(?<=[:"\'`(,=\[])|(?<=:\s)|(?<=:\s\s))#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])')

def hexcolour():
    for path in files:
        raw = read(path)
        s = strip_comments(raw, path)
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        seen = set()
        for m in HEX.finditer(s):
            # A link or a reference is not a colour: href="#top", url(#grad).
            if re.search(r'(?:href=["\']?|url\()$', s[max(0, m.start() - 12):m.start()]):
                continue
            ln, _ = where(starts, m.start())
            if ln not in seen:
                seen.add(ln)
                emit('HEX', path, ln, raw_lines)

def mono():
    rx = re.compile(r'(?<![\w-])font-mono(?![\w-])|var\(\s*--font-mono\b|\bmonospace\b')
    for path in files:
        if re.search(r'tailwind\.config', path):
            continue
        raw = read(path)
        s = strip_comments(raw, path)
        starts = lines_of(s)
        raw_lines = raw.split('\n')
        seen = set()
        for m in rx.finditer(s):
            ln, _ = where(starts, m.start())
            # Defining a token is not using it: "--font-mono: ui-monospace, …".
            if re.match(r'\s*--[\w-]+\s*:', s[starts[ln]:m.start()]):
                continue
            if ln not in seen:
                seen.add(ln)
                emit('MONO', path, ln, raw_lines)

{'viewport': viewport, 'storage': storage, 'fetchnet': fetchnet, 'safearea': safearea,
 'fontsize': fontsize, 'mono': mono, 'hex': hexcolour}[mode]()
PY
scan() { python3 -c "$SCAN_PY" "$1"; }
# pick <TAG> <scan output> — the hits of one tag, tab prefix removed.
pick() { printf '%s\n' "$2" | awk -F'\t' -v t="$1" '$1 == t { sub(/^[^\t]*\t/, ""); print }'; }

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
print_group BLOCK "!important" "" "$IMPORTANT_HITS"

# 3. Hard-coded colours instead of tokens — in markup only.
#    Theme, token and global style files are excluded: that is where they belong.
#    Every CSS length counts (#fff, #ffff, #ffffff, #ffffff80): the 6-digit form
#    alone let "#fff" and "#0008" through. A colour is taken only where one can
#    stand (after a quote, bracket, colon, comma or "="), so "order #123" in a
#    sentence is not a colour; links (href="#top") and url(#id) are not either.
MARKUP_NO_THEME=$(echo "$MARKUP" | grep -vE 'tokens|theme|globals|tailwind\.config' || true)
# Comments are stripped by the scanner, multi-line JSX ones included: a note
# "(#aebbc9)" explaining a contrast decision is not a colour in the markup.
HEX_HITS=$(pick HEX "$(scan hex <<< "$MARKUP_NO_THEME")")
print_group FLAG "raw HEX colour in markup instead of a token" \
  "a colour outside the token set does not follow the theme (dark mode, rebrand) and multiplies: every copy is a decision nobody owns" \
  "$HEX_HITS"

# 3b. Tailwind's default palette in components (bg-blue-500, text-red-600 …).
#     The same leak as raw HEX, in class form: the colour bypasses the project's
#     roles. One project collected 341 such classes in half a year. FLAG by
#     default, a block with "paletteClasses": "block" in .uiverify.json.
CLASS_FILES=$(printf '%s\n%s\n' "$MARKUP_NO_THEME" "$(collect ts js | grep -vE 'tokens|theme|globals|tailwind\.config|\.config\.' || true)" | grep -v '^$' || true)
PALETTE_RE='(^|[^a-zA-Z0-9_-])(text|bg|border|from|to|via|ring|placeholder|accent|fill|stroke|outline|divide|shadow|decoration|caret)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}([^0-9a-zA-Z_-]|$)'
PALETTE_SEV=FLAG
[ "$PALETTE_MODE" = "block" ] && PALETTE_SEV=BLOCK
report "$PALETTE_SEV" "Tailwind default palette class instead of a colour role" "$PALETTE_RE" "$CLASS_FILES" \
  "bg-blue-500 is a colour picked on the spot, not a role (danger, accent, muted): it ignores the theme and every screen ends up with its own shade"

# 4. Fixed height on a container with variable content.
#    Catches h-[240px] but not max-h-/min-h-: those do the opposite job —
#    hold a ceiling without cutting the content off.
report FLAG "fixed height (check that the content is not variable)" \
  '(^|[^-a-zA-Z])h-\[[0-9]+px\]' "$MARKUP"

# 5. Viewport units.
#    a) vh where the visible area is meant. On Android 100vh includes the space
#       under the address bar, so the bottom of a full-height screen sits under
#       the browser chrome. Correct fallbacks are NOT findings: a vh inside a
#       var() fallback — var(--app-h, 100vh) —, inside @supports not
#       (height: 1dvh), or in a rule that an @supports (height: 1dvh) block
#       overrides. Comments are not code.
#    b) dvh/svh/lvh with no fallback, and c) any calc() with them. Chrome before
#       108 and Safari before 15.4 do not know these units: a bare 100dvh drops
#       the whole declaration (the sheet loses its height), and calc(100dvh -
#       var(--x)) is worse — with var() inside, Chrome 106 accepts it at parse
#       time and resets the height to auto, beating even an earlier vh line.
#       Active only when the project's floor is below those engines.
VIEWPORT_OUT=$(scan viewport <<< "$ALL_SRC")
print_group BLOCK "vh where the visible height is meant" \
  "on Android 100vh is taller than the visible part (it includes the address bar): the bottom of the screen hides under the browser chrome. Use dvh when the floor allows it, otherwise var(--app-h, 100vh) or an @supports fallback" \
  "$(pick VH "$VIEWPORT_OUT")"

DYN_SEV=""
DYN_FLOOR_NOTE=""
if [ -n "$FLOOR_CHROME" ] || [ -n "$FLOOR_SAFARI" ]; then
  if python3 -c "
import sys
c, s = sys.argv[1], sys.argv[2]
below = (c != '' and float(c) < 108) or (s != '' and float(s) < 15.4)
sys.exit(0 if below else 1)" "$FLOOR_CHROME" "$FLOOR_SAFARI"; then
    DYN_SEV=BLOCK
    DYN_FLOOR_NOTE="Floor: Chrome ${FLOOR_CHROME:-?} / Safari ${FLOOR_SAFARI:-?} ($FLOOR_SOURCE)."
  fi
else
  DYN_SEV=FLAG
  DYN_FLOOR_NOTE="Browser floor unknown, so this is only a warning: set browserFloor {\"chrome\":…,\"safari\":…} in .uiverify.json or a browserslist that names chrome${FLOOR_SOURCE:+ ($FLOOR_SOURCE)}."
fi
if [ -n "$DYN_SEV" ]; then
  print_group "$DYN_SEV" "dvh/svh/lvh without a fallback (needs Chrome 108 / Safari 15.4)" \
    "older engines drop the whole declaration, so the element loses its height. Write var(--app-h, 100dvh) with a script that sets --app-h on old engines, or put the rule in @supports (height: 1dvh) over a vh base. $DYN_FLOOR_NOTE" \
    "$(pick DVH "$VIEWPORT_OUT")"
  print_group "$DYN_SEV" "calc() with dvh/svh/lvh (needs Chrome 108 / Safari 15.4)" \
    "Chrome 106 accepts calc(100dvh - var(--x)) at parse time and resets the height to auto at computed time, overriding even an earlier vh fallback line. Keep the unit in a var() fallback or inside @supports (height: 1dvh). $DYN_FLOOR_NOTE" \
    "$(pick CALC "$VIEWPORT_OUT")"
fi

# 6. Internals leaking into visible text.
#    The rule "the interface speaks the user's language" lived as a paragraph in a
#    document, which means it did not work. Field names are searched only in PLAIN
#    text between tags — inside an expression they are ordinary code.
# Words from behind the curtain: they have no place in a label meant for a person.
UI_WORDS='backend|back-end|endpoint|end-point|API handler|the server (returned|responded|is unavailable)|SKU|JSON|payload|token|deploy|staging|production'
# Field names are searched only in PLAIN text between tags: inside an expression
# like `${item.product_id}` this is ordinary code, not a leak.
UI_FIELDS='user_id|client_id|customer_id|account_id|product_id|order_id|item_id|session_id|tenant_id'
# The vocabulary is configurable per project and per interface language: fields
# "lexicon" (words) and "lexiconFields" (field names) in .uiverify.json. When set,
# they replace the built-in defaults and work for any language.
[ -n "$CUSTOM_FIELDS" ] && UI_FIELDS="$CUSTOM_FIELDS"

if [ -n "$CUSTOM_WORDS" ]; then
  UI_HITS=$(
    {
      echo "$MARKUP" | xargs grep -HnEi ">[^<{]*($CUSTOM_WORDS)[^<]*<" 2>/dev/null
      echo "$MARKUP" | xargs grep -HnE ">[^<{]*($UI_FIELDS)[^<]*<" 2>/dev/null
    } | grep -vE '(//|/\*|\*)[[:space:]]' | sort -u || true
  )
else
  UI_HITS=$(
    {
      echo "$MARKUP" | xargs grep -HnEi ">[^<{]*($UI_WORDS)[^<]*<" 2>/dev/null
      echo "$MARKUP" | xargs grep -HnE ">[^<{]*($UI_FIELDS)[^<]*<" 2>/dev/null
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
print_group BLOCK "internal terms in visible text" "" "$UI_HITS"

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
#    skeleton hung forever. Cured by AbortSignal.timeout — which itself needs
#    Chrome 103 / Safari 16: below that floor register templates/compat-script.js
#    first, or every request throws TypeError.
CODE=$(collect ts tsx js jsx mjs)
# The signal usually sits NOT on the call line but in the options object below, so
# a window of lines is inspected — otherwise the rule drowns in false positives.
FETCH_HITS=$(echo "$CODE" | xargs grep -HnE '\bfetch\(' 2>/dev/null \
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
print_group FLAG "fetch without a timeout/signal" \
  "a response cut mid-flight never settles: the spinner hangs forever. AbortSignal.timeout needs Chrome 103 / Safari 16 — below that, polyfill it first (templates/compat-script.js)" \
  "$FETCH_HITS" 10

# 9b. Raw fetch outside the network layer.
#     Every screen that calls fetch itself re-invents the timeout, the error
#     model and the error text, and each copy drifts. The project names its
#     network layer in "networkPaths"; without that key the rule is off.
if [ "$HAS_NETWORK_PATHS" = "1" ]; then
  print_group FLAG "raw fetch outside the network layer (networkPaths)" \
    "a request made around the shared client skips its timeout, cancellation and error model; the screen then shows its own wording for the same failure" \
    "$(pick FETCH "$(scan fetchnet <<< "$CODE")")" 10
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

# 12. Browser storage read during render.
#     The server has no localStorage: a first render that reads it differs from
#     the server HTML, React throws the hydration error (#418) and re-renders the
#     tree; at module scope the import itself throws on the server. Read it in
#     useEffect / useSyncExternalStore (getServerSnapshot returns a constant) or
#     in a handler. Heuristic: function boundaries are guessed from the text.
STORAGE_OUT=$(scan storage <<< "$(printf '%s\n' "$CODE" | grep -vE '\.mjs$' || true)")
print_group FLAG "localStorage/sessionStorage read during render (heuristic)" \
  "the server renders without storage, the first client render reads it, the two differ — hydration breaks (React #418). Read it in useEffect, useSyncExternalStore or an event handler" \
  "$(pick RENDER "$STORAGE_OUT")" 10
print_group FLAG "localStorage/sessionStorage at module scope (heuristic)" \
  "the module runs on the server too (ReferenceError) and on the client before hydration, so the value differs from the server HTML. Read it lazily, inside an effect or a handler" \
  "$(pick MODULE "$STORAGE_OUT")" 10

# 13. Safe-area insets that are always zero.
#     env(safe-area-inset-*) is 0 unless the viewport meta has
#     viewport-fit=cover: padding meant for the home indicator or the notch
#     silently does nothing and controls sit in the gesture zone.
SAFE_FILES=$(printf '%s\n%s\n' "$ALL_SRC" "$CODE" | grep -v '^$' | sort -u)
# A Vite or plain project keeps the viewport meta in index.html next to src.
for extra in "$ROOT/index.html" "$ROOT/../index.html" "$CONFIG_DIR/index.html"; do
  [ -f "$extra" ] && SAFE_FILES=$(printf '%s\n%s\n' "$SAFE_FILES" "$extra")
done
print_group FLAG "env(safe-area-inset-…) with no viewport-fit=cover anywhere" \
  "without viewport-fit=cover in the viewport meta (Next.js: viewport.viewportFit = \"cover\") every inset is 0, so the padding for the home indicator and the notch does nothing" \
  "$(pick SAFE "$(scan safearea <<< "$SAFE_FILES")")" 5

# 14. Text below the size floor.
#     Small text on a phone held at arm's length is unread or zoomed. The floor
#     is 16px unless the project records its own: "minFontPx": 12 in
#     .uiverify.json is the written exception, not a silent one.
FONT_FILES=$(printf '%s\n%s\n' "$ALL_SRC" "$(printf '%s\n' "$CODE" | grep -vE '\.(tsx|jsx)$' || true)" | grep -v '^$' | sort -u)
MIN_FONT_SHOWN=$(python3 -c "import sys; v=float(sys.argv[1]); print(int(v) if v == int(v) else v)" "$MIN_FONT" 2>/dev/null || echo "$MIN_FONT")
print_group FLAG "font size below the ${MIN_FONT_SHOWN}px floor (text-xs, text-sm, font-size)" \
  "text under the floor is skipped or zoomed on a phone; the floor is minFontPx in .uiverify.json (default 16) — a project with a denser scale records its number there" \
  "$(pick FONT "$(scan fontsize <<< "$FONT_FILES")")" 10

# 15. Monospace.
#     A monospaced face reads as a terminal and widens numbers for nothing;
#     aligned digits come from font-variant-numeric: tabular-nums. A project that
#     needs code samples sets "allowMono": true.
if [ "$ALLOW_MONO" != "1" ]; then
  print_group FLAG "monospace font (font-mono, monospace)" \
    "monospace reads as a developer tool, not an interface; for aligned figures use tabular-nums. Allowed by \"allowMono\": true" \
    "$(pick MONO "$(scan mono <<< "$FONT_FILES")")" 10
fi

echo ""
echo "Bans: blocking — $VIOLATIONS, warnings — $FLAGS"
[ "$VIOLATIONS" -eq 0 ] && exit 0
exit 1
