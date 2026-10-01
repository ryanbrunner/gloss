# Releasing Gloss

Gloss is published as a Homebrew formula in
[ryanbrunner/homebrew-tap](https://github.com/ryanbrunner/homebrew-tap), and
installed with `brew install ryanbrunner/tap/gloss`. It is not on npm.

The formula's source is [packaging/homebrew/gloss.rb](../packaging/homebrew/gloss.rb)
in this repo. A tag runs `.github/workflows/release.yml`, which fills in the
template's `url` and `sha256` for the tag and pushes the result to the tap as
`Formula/gloss.rb`. Nobody edits the tap's copy or a sha256 by hand.

## A release

1. Bump `version` in both `package.json` and `plugin/.claude-plugin/plugin.json`,
   and the tag in the `url` of `packaging/homebrew/gloss.rb`. Run
   `npm install --package-lock-only` so the lockfile follows. `npm test`
   fails while the three differ.
2. Merge that to main.
3. Tag the merge and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   gh run watch
   ```

The release workflow then:

1. fails, publishing nothing, unless the tag is `vX.Y.Z` and both version
   fields are `X.Y.Z`;
2. downloads `archive/refs/tags/vX.Y.Z.tar.gz` and hashes it;
3. makes the formula from the template with that url and sha256, and prints it;
4. checks out the tap with `HOMEBREW_TAP_TOKEN`;
5. creates the GitHub release with generated notes, unless it already exists;
6. commits `Formula/gloss.rb` to the tap as `gloss X.Y.Z` and pushes to its main.

Then check it from a clean shell:

```sh
brew update
brew upgrade gloss || brew install ryanbrunner/tap/gloss
brew test gloss
brew audit --strict --online ryanbrunner/tap/gloss
```

### A dry run

Run by hand, the workflow makes and prints the formula and publishes nothing:
no release and no push to the tap.

```sh
gh workflow run release.yml -f tag=v0.2.0
gh run watch
```

The version check runs against the branch it is dispatched on. Before the
tag exists, it hashes that commit's tarball instead, so the url is the tag's
but the sha256 only stands in for it.

### Trying a formula change before tagging

CI lints and audits the template (the `formula` job), but only installing it
shows that it builds. From a local tap, with a tarball of HEAD:

```sh
git archive --prefix=gloss-0.2.0/ HEAD | gzip > /tmp/gloss-0.2.0.tar.gz
brew tap-new local/gloss-check --no-git
tap=$(brew --repository local/gloss-check)
sed -e 's|^  url ".*"$|  url "file:///tmp/gloss-0.2.0.tar.gz"|' \
    -e "s|^  sha256 \".*\"$|  sha256 \"$(shasum -a 256 /tmp/gloss-0.2.0.tar.gz | cut -d' ' -f1)\"|" \
    packaging/homebrew/gloss.rb > "$tap/Formula/gloss.rb"
brew install --build-from-source local/gloss-check/gloss
brew test local/gloss-check/gloss
brew audit --strict local/gloss-check/gloss
brew uninstall gloss && brew untap local/gloss-check
```

Homebrew installs from the packed tarball, so only what `files` in
`package.json` lists reaches the keg. The package lock is not part of it:
dependencies resolve afresh within their ranges at install time, skipping
anything published in the last day.

## One-time setup

Done once, before the first tag. Without both, the first release's push to
the tap fails; rerunning the job once they exist recovers.

### The tap

```sh
brew tap-new ryanbrunner/homebrew-tap
gh repo create ryanbrunner/homebrew-tap --public \
  --source "$(brew --repository ryanbrunner/homebrew-tap)" --push
```

Then, in the tap, delete `.github/workflows/publish.yml` (it publishes
bottles, and Gloss ships none: esbuild's native binary would make them
per-architecture) and `.github/workflows/autobump.yml` (it would open bump
pull requests the release workflow already makes unnecessary), and push.
Keep `tests.yml`. On a push to main it runs `brew test-bot --only-tap-syntax`,
which lints what the release workflow pushed; it installs and tests formulae
only on pull requests.

### The token

Create a fine-grained personal access token with access to
`ryanbrunner/homebrew-tap` only, and **Contents: read and write**. Store it
in this repo:

```sh
gh secret set HOMEBREW_TAP_TOKEN -R ryanbrunner/gloss
```

When it expires, the release workflow fails at the tap checkout, before it
creates the release. Make a new one and set the secret again.

## When something goes wrong

- **The tag does not match a version.** Nothing was published. Delete the
  tag (`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`), fix the
  versions, and tag again.
- **The push to the tap failed** (no secret, an expired token). Fix the token
  and rerun the failed job: the release is left as it is, and the formula
  is made again from the same tag.
- **The published formula is broken.** Users already have it, so fix it
  forward: fix `packaging/homebrew/gloss.rb`, bump the patch version, and
  release that. To pull it sooner, revert the commit in the tap
  (`git revert <sha> && git push` in a clone of ryanbrunner/homebrew-tap),
  which puts the previous version back.
- **Never move or reuse a tag** once released. Its tarball's sha256 is in
  the formula, and a different tarball under the same tag fails every
  install with a checksum mismatch.
