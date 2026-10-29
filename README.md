# GitHub Actions

Reusable GitHub Actions for the [`secretkeylabs`](https://github.com/secretkeylabs) organization.

## Actions

### `check-agents`

Checks that a repository has a root `AGENTS.md` file and that it links to every nested `AGENTS.md` file.

#### Usage

```yaml
- name: Check AGENTS.md links
  uses: secretkeylabs/github-actions/check-agents@main
```

#### Inputs

| Input               | Description                                             | Required | Default |
| ------------------- | ------------------------------------------------------- | -------- | ------- |
| `working-directory` | Directory to check, relative to the workflow workspace. | No       | `.`     |

### `add-package-pre-release-info-to-pr`

Prepends a package's pre-release installation instructions to a Pull Request description. If the PR already contains a pre-release info block, it is updated in place.

#### Usage

```yaml
- name: Add package pre-release info
  uses: secretkeylabs/github-actions/add-package-pre-release-info-to-pr@main
  with:
    package-name: "my-awesome-package"
    version: "1.0.0-a429d137"
    github-token: ${{ secrets.GITHUB_TOKEN }}
    pr-number: ${{ github.event.pull_request.number }}
```

#### Inputs

| Input          | Description                                   | Required |
| -------------- | --------------------------------------------- | -------- |
| `package-name` | The name of the NPM package                   | Yes      |
| `version`      | The pre-release version                       | Yes      |
| `github-token` | A GitHub token with pull-request write access | Yes      |
| `pr-number`    | The Pull Request number                       | Yes      |

### `release-guard`

Fails a release PR, or an rc publish, unless the release branch is safe to ship:

- every commit it adds on top of the trusted source branches either came in through an approved PR into that release branch, or is a GitHub-verified `github-actions[bot]` commit that only changes allowed version lines (merge commits made with `-s ours` must change nothing);
- the version file matches the version in the branch name (`release/v1.2.3`, `release/cli-v1.2.3`, `hotfix/v1.2.3`) and is higher than the target branch's version;
- in `rc` mode, the PR is still open and is approved at its head commit.

Allowed-bot-changes patterns are matched per changed line, so anchor them to the exact indentation of the release version (a two-space `"version"` in `package.json`, not any `version` key such as `scripts.version`); for `.json` files the parsed before/after must also be identical except for the root `version` (and, in a lockfile, `packages[""].version` set to the same new version), so allow `package-lock.json` only for its two version lines, as in the example below. Commits that came in through a PR count as reviewed only if they are the PR's own commits or the verified merge GitHub made (rebase merges are not recognised). Source branches must therefore come into a release branch through a PR, not through the "Update branch" button or the web conflict editor: those create a merge authored by the user, which the guard fails as "not authored by github-actions[bot]".

The guard counts an approval from any reviewer with write access at the head commit; it does not check who pushed that commit. Enable the branch protection rule "Require approval of the most recent reviewable push" on `release/**` and `hotfix/**` so a pusher cannot approve their own push to a colleague's PR.

Callers pin the action by commit SHA and use the path `secretkeylabs/github-actions/.github/release-guard`; they must change their `uses:` path when they re-pin from the old location.

For a PR into a release branch it only checks that the result carries the branch's version.

#### Usage

```yaml
- name: Release guard
  uses: secretkeylabs/github-actions/.github/release-guard@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    pr-number: ${{ github.event.pull_request.number }}
    source-branches: develop,main
    allowed-bot-changes: |
      {
        "package.json": ["^ {2}\"version\": \"\\d+\\.\\d+\\.\\d+\",?$"],
        "package-lock.json": ["^ {2}\"version\": \"\\d+\\.\\d+\\.\\d+\",?$", "^ {6}\"version\": \"\\d+\\.\\d+\\.\\d+\",?$"]
      }
```

#### Inputs

| Input                 | Description                                                                              | Required | Default        |
| --------------------- | ---------------------------------------------------------------------------------------- | -------- | -------------- |
| `github-token`        | Token with contents and pull-requests read access                                        | Yes      |                |
| `pr-number`           | The release PR, or a PR into a release branch                                            | Yes      |                |
| `mode`                | `pr`, or `rc` to also require an approval at the PR head                                 | No       | `pr`           |
| `version-file`        | `package.json` carrying the release version                                              | No       | `package.json` |
| `source-branches`     | Comma-separated trusted branches                                                         | Yes      |                |
| `expected-head-sha`   | Fail unless the PR head is this commit; defaults to the head of the triggering PR or PR-review event; pass `github.sha` only for `workflow_dispatch` or other events without a PR head | No | event head |
| `allowed-bot-changes` | JSON: file path -> regexes every changed line of a bot commit must match                 | Yes      |                |
