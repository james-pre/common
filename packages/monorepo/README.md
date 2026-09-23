# @james-pre/monorepo

Tools for managing npm monorepos, mostly just for releasing their workspaces.

Workspaces come from the `workspaces` in the root `package.json`.
Each release is tagged `<id>@<version>`, where the ID is the name of the workspace's directory, like `config@1.2.0`.
Commands take a workspace by its ID, its package name, or its path.

```sh
monorepo release changed        # workspaces that changed since their latest release
monorepo release log config     # commits since the latest release
monorepo release patch config   # bump, commit, tag, and push a release
monorepo rl history config      # `rl` is short for `release`
```

In a release workflow, `resolve` finds the workspace for a tag, checks that the tag matches its version, and sets the `path`, `id`, `name`, and `version` outputs:

```yaml
- name: Resolve package
  id: resolve
  run: npx monorepo release resolve "$TAG"
  env:
      TAG: ${{ github.event.release.tag_name }}

- name: Publish
  run: npm publish
  working-directory: ${{ steps.resolve.outputs.path }}
```
