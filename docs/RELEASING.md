# Publishing a release

Use a clean `main` branch with passing CI. npm package versions cannot be reused after publication.

## One-time setup

1. Create or sign in to the npm account that owns the `@1amsheldon` scope.
2. Enable two-factor authentication for package publication.
3. Sign in on the release machine:

```bash
npm login
npm whoami
```

## Prepare the version

Choose the SemVer increment that matches the change:

```bash
npm version patch --no-git-tag-version
npm run release:check
npm pack --dry-run
```

Commit `package.json` and `package-lock.json`, open or update the pull request, and merge it after CI passes.

## Publish

From the exact commit on `main`:

```bash
npm ci
npm run release:check
npm publish --access public
npm view @1amsheldon/mail-mcp version
```

For an account with publication 2FA, npm asks for the second factor. Do not put an npm token in the repository.

## Tag and create the GitHub release

Replace `X.Y.Z` with the version that npm reports:

```bash
git tag -a vX.Y.Z -m "mail-mcp vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --generate-notes
```

Check the release from a clean temporary directory:

```bash
npx -y @1amsheldon/mail-mcp@X.Y.Z --version
npx -y @1amsheldon/mail-mcp@X.Y.Z --help
```

`npm publish --dry-run` and `npm pack --dry-run` are previews. They do not reserve a version.
