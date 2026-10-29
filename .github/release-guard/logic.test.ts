import { expect, test } from "bun:test";
import { isMalformedReleaseBranch, isOpenPull, isTrustedMergeParent, onlyRootVersionChanged, RELEASE_BRANCH } from "./logic";

test("release branch names", () => {
  expect(RELEASE_BRANCH.exec("release/v1.2.3")?.[1]).toBe("1.2.3");
  expect(RELEASE_BRANCH.exec("hotfix/cli-1.2.3")?.[1]).toBe("1.2.3");
  for (const ref of ["Release/v1.2.3", "release/v1.2", "release/v1.2.3-beta", "release/foo", "hotfix/x"]) {
    expect(isMalformedReleaseBranch(ref)).toBe(true);
  }
  for (const ref of ["release/v1.2.3", "feature/release/x", "develop", "releases/1"]) {
    expect(isMalformedReleaseBranch(ref)).toBe(false);
  }
});

test("only the root version may change", () => {
  const pkg = (version: string, dep = "1") => ({ name: "a", version, dependencies: { x: dep } });
  expect(onlyRootVersionChanged(pkg("1.0.0"), pkg("1.0.1"))).toBe(true);
  expect(onlyRootVersionChanged(pkg("1.0.0"), pkg("1.0.1", "2"))).toBe(false);
  expect(onlyRootVersionChanged({ name: "a" }, { name: "a", version: "1" })).toBe(false);
  expect(onlyRootVersionChanged(null, pkg("1"))).toBe(false);
});

test("lockfile packages[''].version must follow the new root version", () => {
  const lock = (version: string, rootVersion: string, depVersion = "1.0.0") => ({
    name: "a",
    version,
    packages: { "": { name: "a", version: rootVersion }, "node_modules/x": { version: depVersion } },
  });
  expect(onlyRootVersionChanged(lock("1.0.0", "1.0.0"), lock("1.0.1", "1.0.1"))).toBe(true);
  expect(onlyRootVersionChanged(lock("1.0.0", "1.0.0"), lock("1.0.1", "9.9.9"))).toBe(false);
  expect(onlyRootVersionChanged(lock("1.0.0", "1.0.0"), lock("1.0.1", "1.0.1", "2.0.0"))).toBe(false);
});

test("merge parents are trusted only when on a source, in the same PR or in the base", () => {
  expect(isTrustedMergeParent({ inSamePr: false, onSource: false, inBaseTips: false })).toBe(false);
  expect(isTrustedMergeParent({ inSamePr: true, onSource: false, inBaseTips: false })).toBe(true);
  expect(isTrustedMergeParent({ inSamePr: false, onSource: true, inBaseTips: false })).toBe(true);
  expect(isTrustedMergeParent({ inSamePr: false, onSource: false, inBaseTips: true })).toBe(true);
});
