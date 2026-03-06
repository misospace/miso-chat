# Contributing

## Agent claim/lock workflow (prevents overlapping PRs)

Before starting implementation on an issue:

1. Add labels: `claimed`, `in-progress`
2. Assign yourself
3. Comment with:

```text
/claim
owner: <agent-name>
issue: #<number>
branch: chipper/<issue>-<slug>
started: <ISO-8601>
```

If an issue is already claimed or already has an open PR, do not start new work on it.

When blocked, switch label to `blocked` and leave a short status comment.
When complete, remove `claimed`/`in-progress` labels and close the claim comment with PR link.
