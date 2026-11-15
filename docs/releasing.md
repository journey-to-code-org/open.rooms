# Releasing

Merging a version bump to `main` publishes it to npm. Nothing is run by hand.

1. Bump the packages that changed, in a PR. Each package has its own version:

   ```sh
   npm version patch -w @journey-to-code/rooms --no-git-tag-version   # or minor, or major
   ```

   If a package depends on another that you bumped and needs the new one, raise its range too.

2. Merge the PR. `.github/workflows/release.yml` runs on `main`: it builds, typechecks and tests,
   then `scripts/publish.mjs` publishes (with provenance) every package whose version isn't on npm,
   dependencies first, and each one published gets a tag (`rooms-v0.1.1`) and a GitHub release.

A push that doesn't change a version publishes nothing. To see what would go out:
`node scripts/publish.mjs --dry-run`. If a run fails partway, run it again from the Actions tab:
what's already on npm is skipped, and a version with no GitHub release is given one.

## One-time setup

For each package on npmjs.com, Settings → Trusted publishing → GitHub Actions: organization
`journey-to-code-org`, repository `open.rooms`, workflow `release.yml`, environment `release`.
No token is stored. (A package's first version has to be published by hand, before it can be set up.)
