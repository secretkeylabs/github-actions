// Release guard: fails a release PR (or an rc publish) unless every commit the release branch adds on top of the
// trusted source branches is either reviewed (merged through an approved PR into the release branch) or a
// GitHub-verified github-actions[bot] commit that only changes version lines. Also checks the version file matches
// the version in the release branch name and is higher than the target branch's version.

const token = process.env.GITHUB_TOKEN;
const repoFullName = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const mode = process.env.GUARD_MODE || "pr";
const versionFile = process.env.VERSION_FILE || "package.json";
const sourceBranches = (process.env.SOURCE_BRANCHES || "")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);
const allowedBotChangesJson = process.env.ALLOWED_BOT_CHANGES || "{}";
const expectedHeadSha = process.env.EXPECTED_HEAD_SHA || "";

const BOT_LOGIN = "github-actions[bot]";
const RELEASE_BRANCH = /^(?:release|hotfix)\/(?:cli-)?v?(\d+\.\d+\.\d+)$/;

if (!token || !repoFullName || !prNumber || sourceBranches.length === 0) {
  console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER or SOURCE_BRANCHES.");
  process.exit(1);
}
if (mode !== "pr" && mode !== "rc") {
  console.error(`Unknown mode "${mode}", expected "pr" or "rc".`);
  process.exit(1);
}

const allowedBotChanges = Object.fromEntries(
  Object.entries(JSON.parse(allowedBotChangesJson) as Record<string, string[]>).map(([file, patterns]) => [
    file,
    patterns.map((p) => new RegExp(p)),
  ]),
);

const api = `https://api.github.com/repos/${repoFullName}`;

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${api}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function ghPaged<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await gh<T[]>(`${path}${sep}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

type Pull = {
  number: number;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};
type Commit = {
  sha: string;
  parents: { sha: string }[];
  author: { login: string } | null;
  committer: { login: string } | null;
  commit: { message: string; verification?: { verified: boolean; reason: string } };
  files?: { filename: string; status: string; patch?: string }[];
};
type Review = { user: { login: string } | null; state: string; commit_id: string; submitted_at?: string };

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`"${v}" is not a plain x.y.z version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

async function versionAt(ref: string): Promise<string> {
  const file = await gh<{ content: string }>(`/contents/${versionFile}?ref=${encodeURIComponent(ref)}`);
  const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) as { version?: string };
  if (!json.version) throw new Error(`${versionFile} at ${ref} has no version`);
  return json.version;
}

// A source branch name resolved once to an immutable SHA, so a branch that advances mid-run cannot shift pagination
// offsets or change what "on a source" means between requests.
const sourceSha = memo(
  (source: string) => source,
  async (source: string): Promise<string> => (await gh<{ sha: string }>(`/commits/${encodeURIComponent(source)}`)).sha,
);

// Commits on `head` that are not on any trusted source branch.
async function commitsNotOnSources(head: string): Promise<Commit[]> {
  let remaining: Map<string, Commit> | undefined;
  for (const source of sourceBranches) {
    const base = await sourceSha(source);
    const ahead = new Map<string, Commit>();
    for (let page = 1; ; page++) {
      const cmp = await gh<{ commits: Commit[] }>(`/compare/${base}...${head}?per_page=100&page=${page}`);
      for (const c of cmp.commits) ahead.set(c.sha, c);
      if (cmp.commits.length < 100) break;
    }
    remaining = remaining ? new Map([...remaining].filter(([sha]) => ahead.has(sha))) : ahead;
  }
  return [...(remaining ?? new Map()).values()];
}

const writeAccess = new Map<string, Promise<boolean>>();
// Only reviewers with write access count: GitHub accepts approvals from anyone, but they don't satisfy branch protection.
function canWrite(login: string): Promise<boolean> {
  let cached = writeAccess.get(login);
  if (!cached) {
    cached = gh<{ permission: string }>(`/collaborators/${encodeURIComponent(login)}/permission`)
      .then((p) => p.permission === "admin" || p.permission === "write")
      // Only a missing user means "no access"; rate limits and server errors must fail the guard, not drop a veto.
      .catch((err: Error) => {
        if (err.message.includes(" -> 404 ")) return false;
        throw err;
      });
    writeAccess.set(login, cached);
  }
  return cached;
}

// True when, among reviewers with write access (each one's latest decision), no change request is outstanding and
// one has approved `headSha`.
function memo<A extends unknown[], R>(key: (...args: A) => string, fn: (...args: A) => Promise<R>) {
  const cache = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const k = key(...args);
    let hit = cache.get(k);
    if (!hit) {
      hit = fn(...args);
      cache.set(k, hit);
    }
    return hit;
  };
}

// When the PR's base was last changed: retargeted to another branch, or its history rewritten (force-push, or the
// branch deleted and recreated), or a direct push (e.g. a fast-forward) that moved it without a PR merge: that changes
// the merge base, and so the reviewed diff, while the head stays the same. An approval given before that covers a different comparison (the new base may lack
// commits the reviewer saw as already merged, or the other way round), so it must not count.
// With `until` (a merged PR's merge time) only changes up to then count: later rewrites of the branch don't undo a
// review that was already completed into the merge result.
async function lastBaseChange(prNum: number, baseRef: string, until?: string): Promise<number> {
  const limit = until ? Date.parse(until) : Infinity;
  const events = await ghPaged<{ event: string; created_at?: string }>(`/issues/${prNum}/timeline`);
  let last = 0;
  for (const e of events) {
    if (e.event !== "base_ref_changed" || !e.created_at) continue;
    const at = Date.parse(e.created_at);
    if (at <= limit) last = Math.max(last, at);
  }
  const ref = encodeURIComponent(`refs/heads/${baseRef}`);
  for (const type of ["force_push", "branch_deletion", "branch_creation", "push"]) {
    // /activity paginates with cursors, not `page`, so ghPaged would refetch the first page forever. Take the newest
    // page (newest first) and pick the latest entry at or before the limit.
    const perPage = until ? 100 : 1;
    const entries = await gh<{ timestamp?: string }[]>(`/activity?ref=${ref}&activity_type=${type}&direction=desc&per_page=${perPage}`);
    const times = entries.flatMap((e) => (e.timestamp ? [Date.parse(e.timestamp)] : []));
    const inRange = times.filter((t) => t <= limit);
    // A full page that is entirely newer than the limit may hide an older in-range entry: fail rather than guess.
    if (until && !inRange.length && entries.length === perPage) {
      throw new Error(`Cannot find the last ${type} on ${baseRef} before ${until}: more than ${perPage} later events`);
    }
    if (inRange.length) last = Math.max(last, ...inRange);
  }
  return last;
}

const approvedAtCommit = memo(
  (prNum: number, headSha: string, baseRef: string, mergedAt?: string) => `${prNum}@${headSha}@${baseRef}@${mergedAt ?? ""}`,
  async (prNum: number, headSha: string, baseRef: string, mergedAt?: string): Promise<boolean> => {
  const latest = new Map<string, Review>();
  for (const r of await ghPaged<Review>(`/pulls/${prNum}/reviews`)) {
    if (!r.user || (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED" && r.state !== "DISMISSED")) continue;
    latest.set(r.user.login, r);
  }
  // Only reviewers with write access count, for vetoes as well as approvals.
  const states: Review[] = [];
  for (const r of latest.values()) {
    if (await canWrite(r.user!.login)) states.push(r);
  }
  if (states.some((r) => r.state === "CHANGES_REQUESTED")) return false;
  const baseChangedAt = await lastBaseChange(prNum, baseRef, mergedAt);
  return states.some(
    (r) =>
      r.state === "APPROVED" &&
      r.commit_id === headSha &&
      (baseChangedAt === 0 || (r.submitted_at !== undefined && Date.parse(r.submitted_at) > baseChangedAt)),
  );
  },
);

// The approval covers the PR's own commits and the merge GitHub itself made (a verified web-flow commit); a merge
// commit made any other way can carry changes nobody reviewed, so associated-PR membership alone is not enough.
// An intermediate PR commit counts only while the approved final head is still in the checked history, so resetting
// the branch to an earlier snapshot of the PR cannot reuse the approval.
const isAncestorOrSame = memo(
  (ancestor: string, head: string) => `${ancestor}...${head}`,
  async (ancestor: string, head: string): Promise<boolean> => {
    if (ancestor === head) return true;
    const cmp = await gh<{ status: string }>(`/compare/${ancestor}...${head}`);
    return cmp.status === "ahead" || cmp.status === "identical";
  },
);

const prCommitsOf = memo(
  (prNum: number) => String(prNum),
  (prNum: number) => ghPaged<{ sha: string }>(`/pulls/${prNum}/commits`),
);

// The commits reached from `head` by always following the first parent, down to the first commit already on a source
// branch: the sequence of integrations that were made into the release branch itself.
const firstParentChain = memo(
  (head: string) => head,
  async (head: string): Promise<Set<string>> => {
    const chain = new Set<string>();
    let cur: string | undefined = head;
    while (cur && !chain.has(cur) && !(await isOnSource(cur))) {
      chain.add(cur);
      cur = (await gh<Commit>(`/commits/${cur}`)).parents[0]?.sha;
    }
    return chain;
  },
);

async function isReviewedContent(sha: string, pr: Pull, releaseHead: string): Promise<boolean> {
  if (pr.merge_commit_sha === sha) {
    const c = await gh<Commit>(`/commits/${sha}`);
    if (c.committer?.login === "web-flow" && c.commit.verification?.verified === true) return true;
  }
  // A merge inside the PR (e.g. updating the branch) must not make other history reachable: its ignored parents have
  // to be trusted (on a source branch) or already part of the branch the PR was merged into. Otherwise an `ours` merge
  // could pull an earlier snapshot of an approved PR back into the release.
  const own = await gh<Commit>(`/commits/${sha}`);
  if (own.parents.length > 1) {
    const baseTips = [pr.base.sha];
    if (pr.merge_commit_sha) {
      const m = await gh<Commit>(`/commits/${pr.merge_commit_sha}`);
      if (m.parents[0]) baseTips.push(m.parents[0].sha);
    }
    for (const parent of own.parents.slice(1)) {
      let trusted = await isOnSource(parent.sha);
      for (const tip of baseTips) {
        if (!trusted) trusted = await isAncestorOrSame(parent.sha, tip);
      }
      if (!trusted) return false;
    }
  }
  const prCommits = await prCommitsOf(pr.number);
  if (!prCommits.some((c) => c.sha === sha)) {
    // GitHub caps this endpoint at 250 commits, so absence from a full list proves nothing. In that case fall back to
    // history: the commit must be in the approved head's ancestry (the caller already checked that the PR is associated).
    if (prCommits.length < 250 || !(await isAncestorOrSame(sha, pr.head.sha))) return false;
  }
  // Reachability of the approved head alone is not enough: a branch reset to an earlier snapshot can make the head
  // reachable again through unrelated commits. The merge GitHub made of the approved head is the approved integration
  // result, and it only exists in history when the branch was not reset to before it.
  if (!pr.merge_commit_sha) return false;
  // Reachability through any parent is not enough either: another PR started from that merge commit can pull it back
  // in through its second parent. The integration result must sit on the release's own first-parent lineage.
  if (!(await firstParentChain(releaseHead)).has(pr.merge_commit_sha)) return false;
  return isAncestorOrSame(pr.head.sha, releaseHead);
}

async function reviewedIntoBranch(sha: string, branch: string, releaseHead: string): Promise<number | null> {
  const pulls = await ghPaged<Pull>(`/commits/${sha}/pulls`);
  for (const pr of pulls) {
    if (!pr.merged_at || pr.base.ref !== branch) continue;
    if (!(await approvedAtCommit(pr.number, pr.head.sha, pr.base.ref, pr.merged_at))) continue;
    if (await isReviewedContent(sha, pr, releaseHead)) return pr.number;
  }
  return null;
}

async function isOnSource(sha: string): Promise<boolean> {
  for (const source of sourceBranches) {
    if (await isAncestorOrSame(sha, await sourceSha(source))) return true;
  }
  return false;
}

// Empty when the commit is a verified bot commit that only touches allowed version lines.
async function botCommitProblems(sha: string): Promise<string[]> {
  // The commit endpoint paginates `files` (100 per page, 3000 max); inspect all of them.
  const c = await gh<Commit>(`/commits/${sha}?per_page=100&page=1`);
  const allFiles = [...(c.files ?? [])];
  for (let page = 2; allFiles.length >= (page - 1) * 100; page++) {
    const next = await gh<Commit>(`/commits/${sha}?per_page=100&page=${page}`);
    allFiles.push(...(next.files ?? []));
  }
  if (allFiles.length >= 3000) return ["too many changed files to inspect"];
  c.files = allFiles;
  if (c.author?.login !== BOT_LOGIN) return [`not authored by ${BOT_LOGIN}`];
  if (c.committer?.login !== BOT_LOGIN) return [`not committed by ${BOT_LOGIN}`];
  if (!c.commit.verification?.verified) {
    return [`signature not verified (${c.commit.verification?.reason ?? "unknown"})`];
  }
  const files = c.files ?? [];
  // A merge made with `-s ours` keeps the first parent's tree, so it changes nothing.
  if (c.parents.length > 1) {
    if (files.length) return [`merge commit changes ${files.map((f) => f.filename).join(", ")}`];
    // The ignored parents must be trusted history: otherwise the merge could just make an unapproved PR's
    // final head reachable, which lets earlier snapshots of that PR pass the reviewed-content ancestry check.
    for (const parent of c.parents.slice(1)) {
      if (!(await isOnSource(parent.sha))) return [`merge parent ${parent.sha.slice(0, 8)} is not on ${sourceBranches.join(" or ")}`];
    }
    return [];
  }
  const problems: string[] = [];
  for (const f of files) {
    const patterns = allowedBotChanges[f.filename];
    if (!patterns) {
      problems.push(`changes ${f.filename}, which is not a version file`);
      continue;
    }
    if (f.status !== "modified" || f.patch === undefined) {
      problems.push(`${f.filename} is ${f.status}${f.patch === undefined ? " with no text diff" : ""}`);
      continue;
    }
    for (const line of f.patch.split("\n")) {
      if (!/^[+-]/.test(line)) continue;
      const body = line.slice(1);
      if (!patterns.some((p) => p.test(body))) problems.push(`${f.filename}: ${line.trim()}`);
    }
  }
  return problems;
}

async function main() {
  if (mode === "rc" && !expectedHeadSha) {
    console.error("rc mode requires expected-head-sha, so the published revision is the one that was checked.");
    process.exit(1);
  }
  const pr = await gh<Pull>(`/pulls/${prNumber}`);
  // A manually started run reports its result on the ref it ran on, so it must be the PR's head.
  if (expectedHeadSha && pr.head.sha !== expectedHeadSha) {
    console.error(`PR #${pr.number} head is ${pr.head.sha}, but this run checked out ${expectedHeadSha}.`);
    process.exit(1);
  }
  const failures: string[] = [];
  const intoRelease = RELEASE_BRANCH.exec(pr.base.ref);
  const outOfRelease = RELEASE_BRANCH.exec(pr.head.ref);

  if (mode === "rc" && (intoRelease || !outOfRelease)) {
    failures.push(`PR #${pr.number} (${pr.head.ref} -> ${pr.base.ref}) is not a release PR, refusing to publish an rc`);
  } else if (intoRelease) {
    // A PR into a release branch: its result must carry the branch's version.
    const ref = pr.merge_commit_sha ?? pr.head.sha;
    const version = await versionAt(ref);
    if (version !== intoRelease[1]) {
      failures.push(`${versionFile} is ${version} after this PR, expected ${intoRelease[1]} (from ${pr.base.ref})`);
    }
  } else if (outOfRelease) {
    const expected = outOfRelease[1]!;
    const headVersion = await versionAt(pr.head.sha);
    const baseVersion = await versionAt(pr.base.ref);
    if (headVersion !== expected) {
      failures.push(`${versionFile} is ${headVersion} on ${pr.head.ref}, expected ${expected}`);
    }
    if (compareVersions(headVersion, baseVersion) <= 0) {
      failures.push(`version ${headVersion} is not higher than ${pr.base.ref}'s ${baseVersion}`);
    }

    const extra = await commitsNotOnSources(pr.head.sha);
    console.log(`${extra.length} commit(s) on ${pr.head.ref} are not on ${sourceBranches.join(" or ")}`);
    for (const c of extra) {
      const subject = c.commit.message.split("\n")[0];
      const reviewedIn = await reviewedIntoBranch(c.sha, pr.head.ref, pr.head.sha);
      if (reviewedIn) {
        console.log(`ok  ${c.sha.slice(0, 8)} ${subject} (approved PR #${reviewedIn})`);
        continue;
      }
      const problems = await botCommitProblems(c.sha);
      if (problems.length === 0) {
        console.log(`ok  ${c.sha.slice(0, 8)} ${subject} (verified bot version bump)`);
        continue;
      }
      failures.push(
        `${c.sha.slice(0, 8)} ${subject}: not from an approved PR into ${pr.head.ref}, and as a bot commit: ${problems.join("; ")}`,
      );
    }

    if (mode === "rc" && !(await approvedAtCommit(pr.number, pr.head.sha, pr.base.ref))) {
      failures.push(`PR #${pr.number} is not approved at its head commit ${pr.head.sha.slice(0, 8)}`);
    }
  } else {
    console.log(`PR #${pr.number} (${pr.head.ref} -> ${pr.base.ref}) is not a release PR, nothing to check.`);
  }

  if (failures.length) {
    console.error("Release guard failed:");
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log("Release guard passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
