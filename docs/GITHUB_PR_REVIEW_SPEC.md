# GitHub pull request stage — design and limits

## Intent

Offer an explicit, same-repository pull-request creation flow in the existing project GitHub panel. The user chooses a writable repository, source and target branches, title and optional description. The server resolves both refs and fetches a bounded GitHub comparison by immutable commit SHAs. It displays the changed file list and text patches, and refuses detectable incomplete/oversized comparisons. GitHub may still omit or truncate patch detail without an explicit marker; the screen warns users to inspect the actual PR on GitHub before merging. The user must separately approve and confirm creation. This stage does not merge or write branch content.

## Boundaries

- Authentication, origin checks and server-side permission checks are mandatory. GitHub enforces the connected user's actual pull-request permissions and repository policy.
- Review approval is bound to user, repository, refs, SHAs, title and description using a short-lived signed token and a one-use server record. Changing any input requires another comparison. Audit metadata only.
- Both branch heads are checked before creation. GitHub's create-PR REST endpoint accepts branch names, not expected OIDs: the preflight and write are **not atomic**. A branch may move during creation or afterward. Report the actual GitHub PR and require the user to inspect it on GitHub, particularly before merge; never claim an immutable PR or merge automatically.
- On a transport error, outcome may be unknown; inspect existing pull requests on GitHub before another attempt. Never auto-retry a creation.
- Only bounded text patches are supported; binary, missing or detectably incomplete comparisons fail closed. Individual GitHub patches may still be truncated without a detectable marker; the comparison is not a guarantee of completeness. Forks, branch creation, PR merge/reviews and large comparisons remain future work.
- This flow is initially mock-tested only. A live test requires a disposable repository with a separately authorized GitHub user and correct permissions; do not use this working checkout to create test PRs.
