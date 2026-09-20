#!/usr/bin/env bash
# Bring Fusion-EH up to a new upstream release, in the shape this fork actually uses:
# main is the fork's line, it is protected, and an upstream release arrives as a pull request that
# merges the release tag into main. Nothing is rebased, nothing is force-pushed, and this script
# never pushes, never merges into main, and never decides a patch's fate for you.
#
#   ./fork-update.sh [vX.Y.Z]     prepare the merge branch for a release (newest v* tag by default)
#   ./fork-update.sh --verify     check the working tree against fork/manifest.toml
#
# Before you merge the branch this prepares: read each carried patch's retire condition in the
# estate patch registry in blueprint.db, and drop any patch upstream has fixed instead of carrying it.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'fork-update: %s\n' "$1" >&2; exit 1; }

mode="prepare"
if [ "${1:-}" = "--verify" ]; then mode="verify"; shift; fi
requested_tag="${1:-}"
[ "$#" -le 1 ] || die "usage: ./fork-update.sh [--verify] [vX.Y.Z]"

git remote get-url origin >/dev/null 2>&1 || die "missing origin remote for Runfusion/Fusion"
git remote get-url eh >/dev/null 2>&1 || die "missing eh remote for scubashack808/Fusion-EH"
case "$(git remote get-url --push origin 2>/dev/null || true)" in
  DISABLED|no_push|NO_PUSH) ;;
  *) die "origin push URL is not disabled; run: git remote set-url --push origin DISABLED" ;;
esac

[ -f fork/manifest.toml ] || die "no fork/manifest.toml here; this script is not meaningful without it"
current_tag="$(sed -n 's/^tag = "\(.*\)"$/\1/p' fork/manifest.toml | head -n 1)"
[ -n "$current_tag" ] || die "could not read [upstream].tag from fork/manifest.toml"

if [ "$mode" = "verify" ]; then
  say "Verify the tree against the manifest"
  node scripts/check-fork-contract.mjs ${requested_tag:+--expected-upstream "$requested_tag"}
  node scripts/check-changeset-format.mjs
  printf '\nVerified. Open a pull request into main; main takes nothing else.\n'
  exit 0
fi

say "Fetch upstream release tags"
git fetch origin --tags
if [ -z "$requested_tag" ]; then
  requested_tag="$(git for-each-ref --sort=-version:refname --format='%(refname:short)' 'refs/tags/v*' | head -n 1)"
fi
[ -n "$requested_tag" ] || die "no upstream v* release tag found"
git rev-parse --verify "${requested_tag}^{commit}" >/dev/null || die "unknown release tag: $requested_tag"
target_commit="$(git rev-parse "${requested_tag}^{commit}")"
[ "$requested_tag" != "$current_tag" ] || die "the manifest already records $current_tag"

[ "$(git branch --show-current)" = "main" ] || die "run this on main; main is the fork's line"
[ -z "$(git status --porcelain)" ] || die "working tree has changes; commit or stash them first"
git fetch eh main
git merge-base --is-ancestor eh/main HEAD || die "main is behind eh/main; fast-forward first"

branch="merge-upstream-$requested_tag"
git show-ref --verify --quiet "refs/heads/$branch" && die "branch already exists: $branch"

cat <<NOTE

BEFORE YOU MERGE THIS BRANCH, check every carried patch's retire condition in the estate patch
registry (blueprint.db, repo scubashack808/Fusion-EH). A patch upstream has fixed is DELETED, not
carried forward. The manifest lists what is carried; the registry says why, and when it retires.

NOTE
printf 'Prepare %s from main by merging %s (%s)? [y/N] ' "$branch" "$requested_tag" "$target_commit"
read -r reply
case "$reply" in y|Y|yes|YES) ;; *) printf 'Aborted; no changes made.\n'; exit 0 ;; esac

git switch -c "$branch"
git merge --no-ff "$requested_tag" || {
  printf '\nResolve the conflict on this branch, then commit. A patch that fights the merge is\n' >&2
  printf 'REWRITTEN against the new release, never defended.\n' >&2
  exit 2
}

cat <<NEXT

$branch is ready. Reconciliation is not complete until:

  1. every carried patch still compiles and passes its own tests on the new release;
  2. fork/manifest.toml records the new tag and commit, and each patch entry's
     last_reviewed_upstream is the new tag;
  3. ./fork-update.sh --verify "$requested_tag" passes;
  4. the full upstream gate passes on this exact candidate (lint, typecheck, build, boot smoke,
     test:gate), with any failure reported against the pristine upstream tag;
  5. the registry rows for each patch record this base change.

Then open a pull request into main. Nothing has been pushed.
NEXT
exit 3
