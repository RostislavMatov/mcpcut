# Releasing mcpcut

A checklist for the maintainer. A version number on npm can never be reused, so
every step before `npm stage approve` is there to make the one irreversible
step boring.

The working repository is private; this public repository receives its
history through a filtered export (ADR-0011). Steps 1–3 happen in the private
repository, the rest in the public clone.

1. **Bump the version** in `package.json` and `src/brand.ts` (`PRODUCT_VERSION`),
   and every `mcpcut@x.y.z` in `README.md` and `SECURITY.md`. The tests refuse a
   mismatch between any two of them.
2. **Changelog.** `## [Unreleased]` becomes `## [X.Y.Z] — YYYY-MM-DD`; a fresh
   empty `## [Unreleased]` goes on top; the links at the bottom get the new tag.
3. **Export** to the public clone, then push and wait for a green CI:
   ```
   node tools/release/export-public.mjs ~/mcpcut-public
   git -C ~/mcpcut-public push origin main
   ```
   The export refuses to rewrite published history; a new commit always
   arrives as a fast-forward.
4. **Tag** the release commit in the public clone and push the tag:
   ```
   git tag -a vX.Y.Z -m "mcpcut X.Y.Z"
   git push origin vX.Y.Z
   ```
   The `Release` workflow runs CI once more, checks that the tag names the
   package version, and stages the package on npm through trusted publishing
   (GitHub's OIDC token; no npm token exists anywhere).
5. **Approve** the staged version with 2FA, after checking what it contains:
   ```
   npm stage list mcpcut
   npm stage view <id>
   npm stage approve <id>
   ```
6. **Check** the published version and write the GitHub release:
   ```
   npm view mcpcut@X.Y.Z dist.attestations
   gh release create vX.Y.Z --title "mcpcut X.Y.Z" --notes-file <notes>
   ```

## 0.1.0, the first version

npm cannot bind a trusted publisher to a package that does not exist yet, so
0.1.0 was published by hand from the tag `v0.1.0`, with a fresh clone and a
two-hour `npm login` session:

```
npm ci
npm publish --dry-run   # the prepublishOnly guard warns if the tree is dirty or untagged
npm login
npm publish
```

`prepublishOnly` (`tools/release/check-release.mjs`) refuses a real publish
from a tree with uncommitted changes or a `HEAD` that is not tagged
`v<version>`. The workflow's "Already on npm?" step skips a version that is
already published, so the tag push after a hand-published version is a CI run
and nothing more.

## If the workflow cannot publish

The fallback is the 0.1.0 procedure above, run by the maintainer from the tag.
Say so in the release notes: a hand-published version carries no provenance.
