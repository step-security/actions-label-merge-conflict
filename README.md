[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# StepSecurity Label Merge Conflicts

GitHub Action that scans the open pull requests of a repository, detects those whose mergeable state is `CONFLICTING`, and applies a configurable label. Optionally, it removes another label (e.g. a "ready to merge" marker) when conflicts appear, and posts a comment when a pull request becomes dirty or returns to a clean state.

Useful for keeping a long-lived branch (typically `main`) and its open pull requests in sync: maintainers can filter PRs by the dirty label, and authors are notified when their branch needs a rebase.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `repoToken` | yes | — | Token used by the action. Usually `${{ secrets.GITHUB_TOKEN }}`. |
| `dirtyLabel` | yes | — | Label applied to pull requests in a `CONFLICTING` state. |
| `removeOnDirtyLabel` | no | — | Label removed from a pull request when it becomes dirty. |
| `retryAfter` | no | `120` | Seconds to wait before re-checking pull requests whose mergeable state is `UNKNOWN`. |
| `retryMax` | no | `5` | Maximum number of retries when `UNKNOWN` is returned. |
| `continueOnMissingPermissions` | no | `false` | When `true`, log warnings instead of failing if the token cannot modify labels or comments. |
| `commentOnDirty` | no | — | Markdown comment posted when a pull request becomes dirty for the first time. |
| `commentOnClean` | no | — | Markdown comment posted when a previously-dirty pull request becomes clean. |

## Outputs

| Name | Description |
| --- | --- |
| `prDirtyStatuses` | JSON object mapping pull request numbers to booleans. `true` means dirty, `false` means clean. |

## Example usage

```yaml
name: Label conflicting PRs

on:
  push:
    branches: [main]
  pull_request_target:
    types: [synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  label-conflicts:
    runs-on: ubuntu-latest
    steps:
      - uses: step-security/actions-label-merge-conflict@v1
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          dirtyLabel: "needs-rebase"
          removeOnDirtyLabel: "ready-to-merge"
          commentOnDirty: "This pull request has conflicts. Please rebase or merge `main` before requesting another review."
          commentOnClean: "Conflicts resolved. A maintainer will take another look shortly."
```

## License

MIT. See [LICENSE](LICENSE).
