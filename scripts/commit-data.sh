#!/usr/bin/env bash
# Коммитит изменения в рабочей копии ветки `data` и пушит их.
# Если другой workflow успел запушить раньше, подтягивает его коммиты (rebase) и повторяет.
# Использование: scripts/commit-data.sh <каталог ветки data> "<сообщение>"
set -euo pipefail

dir="$1"
message="$2"
cd "$dir"

git add -A
if git diff --cached --quiet; then
  echo "No changes"
  exit 0
fi
git commit -q -m "$message"

for attempt in 1 2 3 4; do
  if git push origin data; then
    exit 0
  fi
  echo "Push rejected (attempt $attempt), rebasing onto origin/data"
  git fetch origin data
  git rebase origin/data
  sleep $((attempt * 2))
done
echo "Failed to push after 4 attempts" >&2
exit 1
