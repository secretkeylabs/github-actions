# GitHub Actions

Reusable GitHub Actions for the [`secretkeylabs`](https://github.com/secretkeylabs) organization.

## Actions

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
