#!/usr/bin/env node
// inspect-webkit publish versions.
//
// package.json "version" is the next stable release
// (a plain X.Y.Z, no prerelease). Workflows do not invent a higher number.
//
// inspect-webkit has no beta channel: every publish is a stable latest release.
//   stable            print "publish X.Y.Z" or "skip X.Y.Z" if it is already on npm
//   next-patch        print the patch after package.json (post-stable bump)
//   set <ver>         write version into package.json (local to the job; not a bump policy)
//   tag-name <ver>    print vX.Y.Z
//   bump-branch <ver> print the bot branch for a bump PR
//   bump-title <ver>  print the bump PR title
//   plan-bump <mainVersion> [releasedVersion]
//                     print "open X.Y.(Z+1)" or "skip X.Y.(Z+1)"
//   tag-decision <existingSha or -> <headSha>
//                     print "create", "reuse", or fail
//
// There is no prerelease / beta tag; versions are plain X.Y.Z only.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_NAME = "inspect-webkit";
export const STABLE_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const DEFAULT_PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

export function packageJsonPath() {
  return process.env.INSPECT_WEBKIT_PACKAGE_JSON || DEFAULT_PACKAGE_JSON;
}

export function parseStable(version, label) {
  const match = STABLE_RE.exec(version);
  if (!match) {
    throw new Error(
      `${label} must be a stable X.Y.Z version, got ${JSON.stringify(version)}`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: version,
  };
}

export function compareStable(a, b) {
  const left = parseStable(a, "version");
  const right = parseStable(b, "version");
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function nextPatch(version) {
  const parsed = parseStable(version, "version");
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function normalizeVersions(raw) {
  if (raw == null) return [];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  throw new Error(`Unexpected npm versions payload: ${typeof raw}`);
}

export function stablePlan(local, versions, latest) {
  parseStable(local, "package.json version");
  if (latest) {
    parseStable(latest, "npm latest");
    if (compareStable(local, latest) < 0) {
      throw new Error(
        `package.json ${local} is behind npm latest ${latest}. Bump package.json to the next version to release.`,
      );
    }
  }
  if (versions.includes(local)) {
    return { action: "skip", version: local };
  }
  return { action: "publish", version: local };
}

export function releaseTagName(version) {
  parseStable(version, "version");
  return `v${version}`;
}

export function bumpBranchName(nextVersion, packageName = PACKAGE_NAME) {
  parseStable(nextVersion, "version");
  return `chore/bump-${packageName}-to-${nextVersion}`;
}

export function bumpPrTitle(nextVersion, packageName = PACKAGE_NAME) {
  parseStable(nextVersion, "version");
  return `chore: bump ${packageName} to ${nextVersion}`;
}

export function bumpPrBody({
  packageName = PACKAGE_NAME,
  released,
  next,
  tag,
}) {
  return `Bump \`${packageName}\` from ${released} to ${next} now that ${packageName}@${released} is on npm and tagged \`${tag}\`.

This pull request only changes the package.json version. GitHub does not run \`pull_request\` or \`push\` workflows for PRs opened with \`GITHUB_TOKEN\`, so CI will not appear here. That is expected and this change does not need a rebuild. Merge when package.json is ${next}.

If a later rerun of the publish workflow already opened this PR, this is the same bump being reused.
`;
}

export function tagDecision(existingSha, headSha) {
  if (!headSha) {
    throw new Error("HEAD SHA is required to create or reuse a release tag.");
  }
  if (!existingSha || existingSha === "-") {
    return { action: "create" };
  }
  if (existingSha === headSha) {
    return { action: "reuse" };
  }
  throw new Error(
    `tag already points at ${existingSha}, not ${headSha}. Refusing to move the tag.`,
  );
}

export function planBumpOnMain(mainVersion, releasedVersion) {
  const next = nextPatch(releasedVersion);
  if (mainVersion === next) {
    return { action: "skip", next };
  }
  if (mainVersion === releasedVersion) {
    return { action: "open", next };
  }
  throw new Error(
    `origin/main package.json is ${mainVersion}; expected ${releasedVersion} (the version just released) or ${next}.`,
  );
}

export function findReusableBumpPr(pulls, { branch, title, base = "main" }) {
  const open = pulls.filter((pull) => {
    const state = pull.state;
    const baseRef = pull.base?.ref ?? pull.base;
    return state === "open" && baseRef === base;
  });
  const byHead = open.find((pull) => (pull.head?.ref ?? pull.head) === branch);
  if (byHead) return byHead;
  return open.find((pull) => pull.title === title) ?? null;
}

export function readPackageVersion(path = packageJsonPath()) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error(`No version field in ${path}`);
  }
  return pkg.version;
}

export function writePackageVersion(version, path = packageJsonPath()) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function npmView(args) {
  try {
    const out = execFileSync("npm", ["view", PACKAGE_NAME, ...args, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (err) {
    const detail = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
    if (/E404|404 Not Found|code E404/i.test(detail)) return null;
    throw new Error(`npm view inspect-webkit ${args.join(" ")} failed: ${detail}`);
  }
}

export function loadRegistry() {
  const latest = npmView(["dist-tags.latest"]);
  return {
    versions: normalizeVersions(npmView(["versions"])),
    latest: typeof latest === "string" ? latest : null,
  };
}

function usage() {
  return "Usage: publish-version.mjs <stable|next-patch|set <version>|tag-name <version>|bump-branch <version>|bump-title <version>|plan-bump <mainVersion> [releasedVersion]|tag-decision <existingSha or -> <headSha>>";
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command) {
    throw new Error(usage());
  }

  if (command === "set") {
    const version = argv[1];
    if (!version) throw new Error("Usage: publish-version.mjs set <version>");
    writePackageVersion(version);
    return version;
  }

  if (command === "tag-name") {
    const version = argv[1];
    if (!version) throw new Error("Usage: publish-version.mjs tag-name <version>");
    return releaseTagName(version);
  }

  if (command === "bump-branch") {
    const version = argv[1];
    if (!version) throw new Error("Usage: publish-version.mjs bump-branch <version>");
    return bumpBranchName(version);
  }

  if (command === "bump-title") {
    const version = argv[1];
    if (!version) throw new Error("Usage: publish-version.mjs bump-title <version>");
    return bumpPrTitle(version);
  }

  if (command === "tag-decision") {
    const existing = argv[1];
    const head = argv[2];
    if (!existing || !head) {
      throw new Error("Usage: publish-version.mjs tag-decision <existingSha or -> <headSha>");
    }
    return tagDecision(existing, head).action;
  }

  if (command === "plan-bump") {
    const mainVersion = argv[1];
    if (!mainVersion) {
      throw new Error("Usage: publish-version.mjs plan-bump <mainVersion> [releasedVersion]");
    }
    const released = argv[2] ?? readPackageVersion();
    const plan = planBumpOnMain(mainVersion, released);
    return `${plan.action} ${plan.next}`;
  }

  const local = readPackageVersion();

  if (command === "next-patch") {
    return nextPatch(local);
  }

  const { versions, latest } = loadRegistry();


  if (command === "stable") {
    const plan = stablePlan(local, versions, latest);
    return `${plan.action} ${plan.version}`;
  }

  throw new Error(usage());
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  try {
    process.stdout.write(`${main()}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
