#!/usr/bin/env bash
# Подключает ветку `data` как рабочую копию в каталоге <dir> (создаёт её при первом запуске).
# Использование: scripts/checkout-data.sh <dir>
set -euo pipefail

dir="$1"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git ls-remote --exit-code --heads origin data >/dev/null; then
  # Полная история ветки data нужна для rebase при одновременных запусках.
  git fetch origin data:refs/remotes/origin/data
  git worktree add -B data "$dir" origin/data
else
  git worktree add --orphan -b data "$dir"
fi
