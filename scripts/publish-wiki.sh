#!/usr/bin/env bash
# Publish wiki/*.md to the GitHub wiki.
# One-time prerequisite: open https://github.com/fso13/AthenaeumHub/wiki and create the first page.
set -euo pipefail
REPO_SLUG="${REPO_SLUG:-fso13/AthenaeumHub}"
WIKI_URL="https://github.com/${REPO_SLUG}.wiki.git"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git ls-remote "$WIKI_URL" >/dev/null 2>&1; then
  cat >&2 <<MSG
Wiki repository is not initialized yet.
Open https://github.com/${REPO_SLUG}/wiki and create the first page ("Home"),
then run this script again.
MSG
  exit 1
fi

git clone "$WIKI_URL" "$TMP/wiki"
cp "$ROOT"/wiki/*.md "$TMP/wiki/"
cd "$TMP/wiki"
git add -A
if git diff --cached --quiet; then
  echo "Wiki is up to date."
  exit 0
fi
git commit -m "docs(wiki): sync Pickle documentation"
git push origin HEAD
echo "Wiki published: https://github.com/${REPO_SLUG}/wiki"
