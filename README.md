# Herdr mods

Personal mods for [Herdr](https://herdr.dev), packaged for the [mods gallery](https://herdr.dev/mods/).

## Mods

| Mod | What it does | Docs |
| --- | --- | --- |
| **Spaces Stacks** | The Spaces sidebar, with stacked PRs nested from their base branch and a branch switcher on each main checkout. Needs GitHub Spaces for PR marks. | [Install and use →](spaces-stacks/README.md) · [Source](spaces-stacks/mods/spaces-stacks/main.js) |
| **GitHub Spaces** | GitHub behind the sidebar: PR state per checkout, comment cards and badges, merge cleanup prompts. Draws no rows; Spaces Stacks renders them. | [Install and use →](github-spaces/README.md) · [Build recipe](github-spaces/RECIPE.md) · [Source](github-spaces/mods/github-spaces/main.js) |
| **Branch review** | Native tab: changed-file tree, one diff at a time, local Prism syntax colours, Split/Unified, editable base. | [Install and use →](branch-review/README.md) · [Source](branch-review/mods/branch-review/main.js) |

Each mod's own README covers its marks, controls, notifications, and limits. Spaces Stacks and GitHub Spaces are installed together: one draws the sidebar, the other answers GitHub.

## Requirements

- [Herdr](https://herdr.dev).
- [Git](https://git-scm.com/) for both mods; run `git fetch` yourself before comparing with a remote base.
- The [GitHub CLI](https://cli.github.com/) (`gh`), authenticated with `gh auth status`, for GitHub Spaces.

Mods run trusted code: one that queries a service or runs commands does so with your credentials. Each mod's README says what it touches.

## Repository layout

Each mod has its own folder containing user documentation, the installable files under `mods/<name>/`, and a regression check where one exists. GitHub Spaces also ships the `RECIPE.md` build brief covering both of its mods, and the preview image.

No replacement layout or key bindings are included. Spaces Stacks plugs into the existing Spaces block, with GitHub Spaces mounted as a 1px background block in the same column; Branch review needs one key, shown in its README:

```json
"cmd-shift-b": "mod.open:branch-review"
```
