# GitHub review-time concurrency protection — stage specification

## Outcome and compatibility

In the existing GitHub panel, a signed-in connected user can load a bounded comparison of the staged text files against a selected repository and branch at an immutable remote commit. The UI displays both versions, marks new/changed/unchanged files, and requires a fresh checkbox and confirmation before push. Editing the target, commit message or files invalidates approval; an expired preview requires refresh. The current OAuth flow and existing project data are not migrated.

The server creates an expiring, one-use Firestore review record and issues a short-lived, user-bound HMAC review token binding the exact repository, branch, snapshot HEAD and validated file contents. It is not a claim that a human read the screen. The push endpoint must require this token and verify it before writing, recheck repository push permissions, consume the review transactionally once, and perform an atomic expected-HEAD commit via GitHub's `createCommitOnBranch` GraphQL mutation. A changed HEAD must fail; no automatic retry, overwrite, merge or commit is allowed. On an unknown network outcome the UI must advise checking GitHub before retrying. Legacy callers lacking a token must re-review through the UI instead of silently bypassing this safeguard.

Read-only comparison uses only the user's encrypted OAuth token against GitHub, with validated paths, strict file/body/count limits, bounded GitHub calls, and no arbitrary URL, shell or AI invocation. Unsupported, oversized or binary remote files fail closed rather than pretending a diff is complete. External file content is untrusted text and rendered as text. Auth and CSRF are independently checked on both routes. GitHub enforces repository permissions and branch protection; no new rights are granted. Audit only metadata and result, not file contents or tokens.

## Verification

Tests must exercise unchanged/new/changed content, unsupported files, owner and argument binding, invalid/expired tokens, pre-commit stale HEAD, GraphQL expectedHeadOid, GraphQL failure, auth and CSRF, and preserving existing OAuth. Live GitHub requires a disposable account and repository and is not assumed by mocked tests. Configure Firestore TTL on `github_push_reviews.expire_at` only after validating retention requirements; it is not enabled by this change. The remaining repository browsing, pull/conflict-resolution and PR workflows are separate stages.
