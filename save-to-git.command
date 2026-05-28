#!/bin/zsh
set -e

cd "$(dirname "$0")"

git add -A .

if git diff --cached --quiet; then
  echo "No changes to save."
  exit 0
fi

message="${1:-Autosave $(date '+%Y-%m-%d %H:%M:%S')}"

git \
  -c user.name="${GIT_AUTHOR_NAME:-Codex}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-codex@local.invalid}" \
  commit -m "$message"

echo "Saved to local git."
