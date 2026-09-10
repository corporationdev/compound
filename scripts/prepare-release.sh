#!/usr/bin/env bash
set -euo pipefail

if [ "$GITHUB_EVENT_NAME" = push ]; then
  tag="$GITHUB_REF_NAME"
else
  test "$GITHUB_REF" = refs/heads/main
  # A retry must reuse its version, even after main or another release advances.
  tag="$(git for-each-ref --format='%(refname:short)|%(contents:subject)' refs/tags | awk -F'|' -v subject="Release workflow $GITHUB_RUN_ID" '$2 == subject { print $1 }')"
  if [ -z "$tag" ]; then
    git config user.name 'github-actions[bot]'
    git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    # Keep version-only commits off main so releases cannot diverge developers' branches.
    git checkout --detach HEAD
    bun run release "$RELEASE_BUMP"
    tag="$(git describe --tags --exact-match HEAD)"
    git tag --force --annotate "$tag" --message "Release workflow $GITHUB_RUN_ID"
    git push origin "refs/tags/$tag"
  fi
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
echo "tag=$tag" >> "$GITHUB_OUTPUT"
