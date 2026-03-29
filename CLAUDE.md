# CLAUDE.md

Repo-specific guardrails for `joryirving/miso-chat`.

- Tags/releases use plain semver like `0.4.6` — do not use a `v` prefix.
- `package.json` is the release version source of truth and should match the released tag.
- Prefer the repo's manual release workflow for releases instead of ad-hoc tagging.
- Update an existing PR for the same work instead of opening a replacement PR.
- Do not silently change release workflows or release process shape; state the change clearly in the PR.
- Before pushing workflow/release changes, validate the affected workflow files and relevant release docs.
- Keep changes minimal and consistent with the existing release/build pipeline unless an explicit process change is requested.
- If a fix request is clear, execute it; don't stall on unnecessary confirmation loops.
