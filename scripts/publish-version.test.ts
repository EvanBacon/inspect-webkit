import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  bumpBranchName,
  bumpPrTitle,
  findReusableBumpPr,
  nextPatch,
  normalizeVersions,
  planBumpOnMain,
  releaseTagName,
  stablePlan,
  tagDecision,
  writePackageVersion,
} from "./publish-version.mjs";

const currentNpm = ["0.0.0", "0.0.1", "0.0.3", "0.0.4", "0.0.5", "0.0.6"];

describe("normalizeVersions", () => {
  test("treats a missing package as no versions", () => {
    expect(normalizeVersions(null)).toEqual([]);
  });

  test("wraps a single published version", () => {
    expect(normalizeVersions("0.0.6")).toEqual(["0.0.6"]);
  });
});

describe("stablePlan", () => {
  test("publishes package.json when that version is not on npm", () => {
    expect(stablePlan("0.0.7", currentNpm, "0.0.6")).toEqual({
      action: "publish",
      version: "0.0.7",
    });
  });

  test("skips when the version is already on npm so a rerun can tag and bump", () => {
    expect(stablePlan("0.0.6", currentNpm, "0.0.6")).toEqual({
      action: "skip",
      version: "0.0.6",
    });
  });

  test("fails if package.json is behind npm latest", () => {
    expect(() => stablePlan("0.0.5", currentNpm, "0.0.6")).toThrow(
      /behind npm latest 0.0.6/,
    );
  });
});

describe("nextPatch", () => {
  test("increments the patch", () => {
    expect(nextPatch("0.0.7")).toBe("0.0.8");
  });
});

describe("release tag and bump PR", () => {
  test("names the git tag and the bump PR from the version", () => {
    expect(releaseTagName("0.0.7")).toBe("v0.0.7");
    expect(bumpBranchName("0.0.8")).toBe("chore/bump-inspect-webkit-to-0.0.8");
    expect(bumpPrTitle("0.0.8")).toBe("chore: bump inspect-webkit to 0.0.8");
  });

  test("reuses a tag that already points at HEAD and refuses to move one", () => {
    expect(tagDecision(null, "abc")).toEqual({ action: "create" });
    expect(tagDecision("abc", "abc")).toEqual({ action: "reuse" });
    expect(() => tagDecision("old", "abc")).toThrow(/already points at old/);
  });

  test("opens a bump PR only when main is still at the released version", () => {
    expect(planBumpOnMain("0.0.7", "0.0.7")).toEqual({
      action: "open",
      next: "0.0.8",
    });
    expect(planBumpOnMain("0.0.8", "0.0.7")).toEqual({
      action: "skip",
      next: "0.0.8",
    });
    expect(() => planBumpOnMain("0.0.6", "0.0.7")).toThrow(
      /origin\/main package.json is 0.0.6/,
    );
  });

  test("reuses an open bump PR by head branch, then by title", () => {
    const openByHead = {
      state: "open",
      title: "other",
      html_url: "https://example/1",
      number: 1,
      head: { ref: "chore/bump-inspect-webkit-to-0.0.8" },
      base: { ref: "main" },
    };
    const openByTitle = {
      state: "open",
      title: "chore: bump inspect-webkit to 0.0.8",
      html_url: "https://example/2",
      number: 2,
      head: { ref: "old-branch" },
      base: { ref: "main" },
    };
    expect(
      findReusableBumpPr([openByTitle, openByHead], {
        branch: "chore/bump-inspect-webkit-to-0.0.8",
        title: "chore: bump inspect-webkit to 0.0.8",
      }),
    ).toBe(openByHead);
  });
});

describe("writePackageVersion", () => {
  const previous = process.env.INSPECT_WEBKIT_PACKAGE_JSON;
  afterEach(() => {
    if (previous == null) delete process.env.INSPECT_WEBKIT_PACKAGE_JSON;
    else process.env.INSPECT_WEBKIT_PACKAGE_JSON = previous;
  });

  test("updates only the version field", () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-webkit-version-"));
    const path = join(dir, "package.json");
    writeFileSync(
      path,
      `${JSON.stringify({ name: "inspect-webkit", version: "0.0.7" }, null, 2)}\n`,
    );
    writePackageVersion("0.0.8", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      name: "inspect-webkit",
      version: "0.0.8",
    });
  });
});
