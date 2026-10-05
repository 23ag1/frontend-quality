#!/usr/bin/env bash
# Download an old Chromium (Linux x64) to run the checks on the engine of old phones.
#
# Why. Phones in the field run browsers years old: no dvh, no :has(), different
# viewport behaviour with the keyboard. The Chromium bundled with Playwright is
# always the newest, so "works here" says nothing about them. Chromium keeps a
# build of almost every commit in the public chromium-browser-snapshots bucket;
# this script takes the one at a major version's branch point.
#
# Usage:
#   scripts/fetch-chromium.sh 106                 # a major version
#   scripts/fetch-chromium.sh --revision 1036826  # a snapshot position directly
#   scripts/fetch-chromium.sh --list              # the built-in table
#
#   export FQ_CHROME_PATH="$(scripts/fetch-chromium.sh 106)"
#   node skills/frontend-quality/scripts/verify-ui.mjs --url http://localhost:3000
#
# Stdout is only the executable path; progress and the version go to stderr.
# Installs into ${FQ_CHROMIUM_DIR:-~/.cache/frontend-quality}/chromium-<major>.
# NOT into ~/.cache/ms-playwright: `playwright install` deletes every
# chromium-* directory there that it did not install itself.
#
# Exit: 0 — the path is printed, 1 — could not download or run, 2 — bad arguments.
set -euo pipefail

BUCKET="https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64"
CACHE="${FQ_CHROMIUM_DIR:-$HOME/.cache/frontend-quality}"

# Major version → the last Linux x64 snapshot at or before its branch point
# (chromium_main_branch_position from chromiumdash), checked against the bucket.
revision_for() {
  case "$1" in
    100) echo 972765 ;;  101) echo 982481 ;;  102) echo 992733 ;;
    103) echo 1002910 ;; 104) echo 1012728 ;; 105) echo 1027016 ;;
    106) echo 1036826 ;; 107) echo 1047731 ;; 108) echo 1058929 ;;
    109) echo 1070081 ;; 110) echo 1083987 ;; 111) echo 1097615 ;;
    112) echo 1109220 ;; 113) echo 1121454 ;; 114) echo 1135561 ;;
    115) echo 1148103 ;; 116) echo 1160321 ;; 117) echo 1181205 ;;
    118) echo 1192586 ;; 119) echo 1204222 ;; 120) echo 1217362 ;;
    121) echo 1233101 ;; 122) echo 1250580 ;; 123) echo 1262506 ;;
    124) echo 1274535 ;; 125) echo 1287743 ;;
    *) return 1 ;;
  esac
}

# A major outside the table: ask chromiumdash for its branch point, then take the
# nearest snapshot at or before it.
revision_online() {
  local major="$1" pos prefix best=""
  pos=$(curl -fsS "https://chromiumdash.appspot.com/fetch_milestones?mstone=$major" |
    grep -o '"chromium_main_branch_position": *[0-9]*' | grep -o '[0-9]*$' | head -1) || return 1
  [ -n "$pos" ] || return 1
  prefix=${pos:0:${#pos}-2}
  for p in "$prefix" "$((prefix - 1))"; do
    best=$(curl -fsS "https://www.googleapis.com/storage/v1/b/chromium-browser-snapshots/o?prefix=Linux_x64/$p&delimiter=/&fields=prefixes" |
      grep -o 'Linux_x64/[0-9]*/' | grep -o '[0-9]\+' |
      awk -v pos="$pos" -v len="${#pos}" 'length($0) == len && $0 + 0 <= pos + 0' | sort -n | tail -1) || true
    [ -n "$best" ] && break
  done
  [ -n "$best" ] && echo "$best"
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2; exit 2; }

[ $# -ge 1 ] || usage
MAJOR=""
REVISION=""
case "$1" in
  --list)
    for m in $(seq 100 125); do printf '%s %s\n' "$m" "$(revision_for "$m")"; done
    exit 0 ;;
  --revision)
    [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || usage
    REVISION="$2" ;;
  -h|--help) usage ;;
  *)
    [[ "$1" =~ ^[0-9]+$ ]] || usage
    MAJOR="$1"
    REVISION=$(revision_for "$MAJOR") || REVISION=$(revision_online "$MAJOR") || {
      echo "No known snapshot for Chromium $MAJOR — pass one with --revision <position>" >&2
      exit 1
    } ;;
esac

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "Only Linux x64 snapshots are handled; this is $(uname -s)-$(uname -m)" >&2
  exit 1
fi

DIR="$CACHE/chromium-${MAJOR:-r$REVISION}"
BIN="$DIR/chrome-linux/chrome"

if [ ! -x "$BIN" ]; then
  command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 1; }
  mkdir -p "$DIR"
  echo "Downloading Chromium snapshot $REVISION (about 150 MB) into $DIR" >&2
  if ! curl -fSL --progress-bar -o "$DIR/chrome-linux.zip" "$BUCKET/$REVISION/chrome-linux.zip"; then
    echo "Download failed: $BUCKET/$REVISION/chrome-linux.zip" >&2
    exit 1
  fi
  unzip -q -o "$DIR/chrome-linux.zip" -d "$DIR"
  rm -f "$DIR/chrome-linux.zip"
fi

if ! VERSION=$("$BIN" --version 2>&1); then
  echo "The build does not start — missing system libraries? $VERSION" >&2
  exit 1
fi
echo "$VERSION" >&2
if [ -n "$MAJOR" ] && ! echo "$VERSION" | grep -q " $MAJOR\."; then
  echo "Warning: asked for $MAJOR, got: $VERSION" >&2
fi
echo "$BIN"
