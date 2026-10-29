// Pure decision logic of the release guard, kept free of I/O so it can be tested.

export const RELEASE_BRANCH = /^(?:release|hotfix)\/(?:cli-)?v?(\d+\.\d+\.\d+)$/;

// True when `ref` looks like a release or hotfix branch (any case) but does not carry a version the guard can check.
export function isMalformedReleaseBranch(ref: string): boolean {
  return /^(?:release|hotfix)\//i.test(ref) && !RELEASE_BRANCH.test(ref);
}

// The parsed before/after of a JSON file must be identical except for the root `version` value. In a lockfile
// (`npm version` also writes it), `packages[""].version` may change too, but only to the new root version.
export function onlyRootVersionChanged(before: unknown, after: unknown): boolean {
  if (typeof before !== "object" || typeof after !== "object" || !before || !after) return false;
  const { version: bv, ...restBefore } = before as Record<string, unknown>;
  const { version: av, ...restAfter } = after as Record<string, unknown>;
  if (typeof bv !== "string" || typeof av !== "string") return false;
  const strip = (rest: Record<string, unknown>, isAfter: boolean): Record<string, unknown> | undefined => {
    const packages = rest.packages;
    if (typeof packages !== "object" || !packages || !("" in packages)) return rest;
    const { "": rootPkg, ...others } = packages as Record<string, unknown>;
    if (typeof rootPkg !== "object" || !rootPkg) return rest;
    const { version, ...rootRest } = rootPkg as Record<string, unknown>;
    if (isAfter ? version !== av : version !== undefined && typeof version !== "string") return undefined;
    return { ...rest, packages: { "": rootRest, ...others } };
  };
  const [b, a] = [strip(restBefore, false), strip(restAfter, true)];
  return !!b && !!a && JSON.stringify(b) === JSON.stringify(a);
}

// A merge parent ignored by a merge inside an approved PR is trusted only if it is on a source branch, part of the
// same PR, or already in the branch the PR was merged into. A capped (250) commit list proves nothing by absence, so
// it never widens trust.
export function isTrustedMergeParent(opts: {
  inSamePr: boolean;
  onSource: boolean;
  inBaseTips: boolean;
}): boolean {
  return opts.inSamePr || opts.onSource || opts.inBaseTips;
}

// An rc may only be published from a PR that is still open: a closed or merged PR was cancelled or already shipped.
export function isOpenPull(pr: { state: string; merged_at: string | null }): boolean {
  return pr.state === "open" && pr.merged_at === null;
}
