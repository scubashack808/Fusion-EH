#!/usr/bin/env node
/**
 * Validate the Fusion-EH downstream delta against fork/manifest.toml.
 *
 * Copied in shape from browser-harness-cdp-completion/scripts/check_fork_contract.py,
 * rewritten in Node because Fusion is a pnpm workspace with no Python toolchain.
 * The four refusals the maintainer contract names are identical in meaning:
 *
 *   1. a downstream file that no active patch entry covers;
 *   2. a patch entry not reviewed against the recorded release;
 *   3. a package version that is not upstream's own for the recorded release;
 *   4. an upstream base that is not real Git ancestry.
 *
 * Two more refusals are carried from the same template and from bp44 decision 609:
 *   5. a carried patch entry that matches no current delta (skipped with --partial,
 *      which is how a single local/* branch is checked);
 *   6. an `origin` remote whose push URL is not disabled, because the one thing this
 *      repository must never do is push to Runfusion/Fusion.
 *
 * Usage:
 *   node scripts/check-fork-contract.mjs [--expected-upstream vX.Y.Z] [--partial]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "fork/manifest.toml");

const REQUIRED_PATCH_FIELDS = ["paths", "last_reviewed_upstream"];

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

class ContractError extends Error {}
function fail(message) {
  throw new ContractError(message);
}

/*
 * A deliberately SMALL TOML reader for exactly the manifest's shape: top-level tables,
 * arrays of tables, string values, and arrays of strings (inline or multi-line).
 * It THROWS on any syntax it does not understand rather than guessing, so a manifest
 * this parser cannot read is a hard failure and never a silent misreading.
 */
function parseToml(text) {
  const root = {};
  let table = root;
  const lines = text.split("\n");

  const readString = (raw, lineNumber) => {
    const value = raw.trim();
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
      fail(`fork/manifest.toml line ${lineNumber}: only double-quoted strings are supported, got ${raw.trim()}`);
    }
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  };

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const arrayTable = trimmed.match(/^\[\[([A-Za-z0-9_]+)\]\]$/);
    if (arrayTable) {
      const key = arrayTable[1];
      if (!Array.isArray(root[key])) root[key] = [];
      table = {};
      root[key].push(table);
      continue;
    }

    const plainTable = trimmed.match(/^\[([A-Za-z0-9_]+)\]$/);
    if (plainTable) {
      const key = plainTable[1];
      root[key] = root[key] ?? {};
      table = root[key];
      continue;
    }

    const assignment = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!assignment) fail(`fork/manifest.toml line ${lineNumber}: unsupported syntax: ${trimmed}`);
    const [, key, rawValue] = assignment;

    if (/^\d+$/.test(rawValue)) {
      table[key] = Number(rawValue);
      continue;
    }

    if (rawValue.startsWith("[")) {
      let body = rawValue;
      while (!body.trimEnd().endsWith("]")) {
        i += 1;
        if (i >= lines.length) fail(`fork/manifest.toml line ${lineNumber}: unterminated array for ${key}`);
        body += "\n" + lines[i];
      }
      const inner = body.trim().slice(1, -1);
      const items = [];
      let buffer = "";
      let inString = false;
      let escaped = false;
      for (const character of inner) {
        if (inString) {
          buffer += character;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          buffer += character;
          continue;
        }
        if (character === ",") {
          if (buffer.trim() !== "") items.push(readString(buffer, lineNumber));
          buffer = "";
          continue;
        }
        if (character === "\n" || character === " " || character === "\t" || character === "\r") continue;
        fail(`fork/manifest.toml line ${lineNumber}: unsupported array element near ${character}`);
      }
      if (inString) fail(`fork/manifest.toml line ${lineNumber}: unterminated string in ${key}`);
      if (buffer.trim() !== "") items.push(readString(buffer, lineNumber));
      table[key] = items;
      continue;
    }

    table[key] = readString(rawValue, lineNumber);
  }

  return root;
}

/** Translate one manifest path glob into a matcher. `**` crosses directories, `*` does not. */
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i];
    if (character === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function validate({ expectedUpstream, partial }) {
  const manifest = parseToml(readFileSync(MANIFEST, "utf8"));
  if (manifest.schema_version !== 1) fail("fork/manifest.toml has an unsupported schema_version");

  const upstream = manifest.upstream ?? {};
  const downstream = manifest.downstream ?? {};
  const tag = upstream.tag;
  const commit = upstream.commit;

  // --- refusal 2 (part one) and 4: the recorded release must be real, exact ancestry.
  if (typeof tag !== "string" || !tag.startsWith("v")) fail("[upstream].tag must be one v-prefixed release tag");
  if (expectedUpstream && tag !== expectedUpstream) {
    fail(`manifest still names ${tag}; expected reviewed release ${expectedUpstream}`);
  }
  if (typeof commit !== "string" || commit.length !== 40) fail("[upstream].commit must be one exact 40-character commit");
  if (upstream.tracking_policy !== "released-tags-only") {
    fail("[upstream].tracking_policy must be released-tags-only; this repository never tracks a moving branch");
  }

  const resolvedTag = git(["rev-parse", "--verify", `${tag}^{commit}`], { allowFailure: true });
  if (resolvedTag === null) fail(`upstream release tag is unavailable locally: ${tag}`);
  if (resolvedTag.trim() !== commit) {
    fail(`${tag} resolves to ${resolvedTag.trim()}, not manifest commit ${commit}`);
  }
  if (git(["merge-base", "--is-ancestor", commit, "HEAD"], { allowFailure: true }) === null) {
    fail(`upstream release ${tag} (${commit}) is not an ancestor of HEAD; this tree is not built on the recorded base`);
  }

  // --- refusal 6: origin must be fetch-only. Nothing here may reach Runfusion/Fusion.
  const originPush = git(["remote", "get-url", "--push", "origin"], { allowFailure: true });
  if (originPush === null) fail("no `origin` remote; the upstream remote must exist and be fetch-only");
  if (!/^(DISABLED|no_push|NO_PUSH)$/.test(originPush.trim())) {
    fail("origin push URL is not disabled; run: git remote set-url --push origin DISABLED");
  }

  // --- refusal 3: a public-looking package version.
  const packageManifestPath = downstream.package_manifest ?? "packages/cli/package.json";
  const packageManifest = JSON.parse(readFileSync(resolve(ROOT, packageManifestPath), "utf8"));
  if (packageManifest.name !== downstream.package) {
    fail(`${packageManifestPath} is ${packageManifest.name}, not [downstream].package ${downstream.package}`);
  }
  /*
   * The build carries no invented version. Artifact identity is the deployed image's tag and its
   * org.opencontainers.image.revision label, both of which are the commit git already allocated,
   * so the package version must stay exactly upstream's for the recorded release.
   */
  const upstreamVersion = tag.replace(/^v/, "");
  if (packageManifest.version !== upstreamVersion) {
    fail(
      `${packageManifestPath} version ${packageManifest.version} is not upstream ${tag}'s own version ` +
        `${upstreamVersion}; this fork never invents a version string`,
    );
  }

  // --- refusal 2 (part two) plus per-patch shape.
  const patches = manifest.patches;
  if (!Array.isArray(patches) || patches.length === 0) fail("fork/manifest.toml must contain at least one [[patches]] entry");

  const ids = new Set();
  const activePatterns = [];
  for (const patch of patches) {
    const id = patch.id;
    if (typeof id !== "string" || id === "") fail("every patch needs a non-empty id");
    if (ids.has(id)) fail(`duplicate patch id: ${id}`);
    ids.add(id);
    if (patch.last_reviewed_upstream !== tag) fail(`${id} was not reviewed against ${tag}`);
    for (const field of REQUIRED_PATCH_FIELDS) {
      const value = patch[field];
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        fail(`${id} is missing ${field}`);
      }
    }
    for (const pattern of patch.paths) {
      if (typeof pattern !== "string" || pattern.startsWith("/") || pattern.split("/").includes("..")) {
        fail(`${id} has an unsafe path pattern: ${JSON.stringify(pattern)}`);
      }
      activePatterns.push({ id, matcher: globToRegExp(pattern) });
    }
  }

  // --- refusal 1: every downstream file must be attributed to an active patch entry.
  const changed = new Set();
  for (const line of git(["diff", "--name-only", "--diff-filter=ACDMRTUXB", commit]).split("\n")) {
    if (line) changed.add(line);
  }
  for (const line of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    if (line) changed.add(line);
  }
  const changedPaths = [...changed].sort();
  const uncovered = changedPaths.filter((path) => !activePatterns.some(({ matcher }) => matcher.test(path)));
  if (uncovered.length > 0) {
    fail(`downstream files are not attributed to a patch entry:\n  ${uncovered.join("\n  ")}`);
  }

  // --- refusal 5: a carried entry that matches nothing is a stale claim.
  if (!partial) {
    const unmatched = patches
      .filter((patch) => !patch.paths.some((pattern) => changedPaths.some((path) => globToRegExp(pattern).test(path))))
      .map((patch) => patch.id);
    if (unmatched.length > 0) {
      fail(`carried patch entries match no current downstream delta: ${unmatched.join(", ")}`);
    }
  }

  return { changed: changedPaths.length, patches: patches.length };
}

function main() {
  const args = process.argv.slice(2);
  const partial = args.includes("--partial");
  const flagIndex = args.indexOf("--expected-upstream");
  const expectedUpstream = flagIndex !== -1 ? args[flagIndex + 1] : undefined;

  try {
    const { changed, patches } = validate({ expectedUpstream, partial });
    console.log(
      `fork-contract: ok: ${changed} downstream paths covered by ${patches} patch entries` +
        (partial ? " (--partial: unmatched-entry check skipped)" : ""),
    );
    return 0;
  } catch (error) {
    const message = error instanceof ContractError ? error.message : String(error?.message ?? error);
    console.error(`fork-contract: FAIL: ${message}`);
    return 1;
  }
}

process.exit(main());
