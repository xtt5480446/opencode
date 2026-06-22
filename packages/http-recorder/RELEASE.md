# Release

`@opencode-ai/http-recorder` is versioned independently from OpenCode and published under the npm `beta` tag.

## Prepare A Release

1. Add a Changeset for every user-facing package change.
2. Run `bunx changeset status` and confirm that only `@opencode-ai/http-recorder` will be bumped.
3. Merge the package changes into `dev`.
4. From a branch based on the latest `dev`, run `bun run version:http-recorder`.
5. Review the generated version and `packages/http-recorder/CHANGELOG.md`, then open and merge the release PR.

The first minor Changeset advances the unpublished `0.0.0` package to `0.1.0`. OpenCode's repository-wide release script deliberately excludes this package from its version synchronization.

## Verify And Publish

Before merging the release PR, run these commands from `packages/http-recorder`:

```sh
bun run test
bun typecheck
bun run verify:package
```

After the release PR reaches `dev`, manually dispatch the `http-recorder release` workflow from the `dev` branch. The workflow repeats the focused tests, builds and verifies the exact tarball in a clean npm consumer, and publishes it with provenance under the `beta` tag.

The bootstrap release uses the repository's existing `NPM_TOKEN` secret because npm trusted publishing cannot be configured for a package that does not exist yet. After the package exists, configure its npm trusted publisher for repository `anomalyco/opencode` and workflow `http-recorder-release.yml`, then remove `NODE_AUTH_TOKEN` from the workflow so later releases authenticate through GitHub OIDC like the repository's other npm packages.

Verify the result:

```sh
npm view @opencode-ai/http-recorder version dist-tags --json
```
