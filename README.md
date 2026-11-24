# Herdr mods

Personal mods for [Herdr](https://herdr.dev), packaged for the [mods gallery](https://herdr.dev/mods/).

## Mods

| Mod | What it does | Docs |
| --- | --- | --- |
| **GitHub Spaces** | Replaces the Spaces sidebar with PR status, comment badges, worktree cleanup prompts, and a fetch/rebase button. | [Install and use →](github-spaces/README.md) · [Build recipe](github-spaces/RECIPE.md) · [Source](github-spaces/mods/github-spaces/main.js) |
| **Branch review** | Native tab: changed-file tree, one diff at a time, local Prism syntax colours, Split/Unified, editable base. | [Install and use →](branch-review/README.md) · [Source](branch-review/mods/branch-review/main.js) |

Each mod's own README covers its marks, controls, notifications, and limits.

## Requirements

- [Herdr](https://herdr.dev).
- [Git](https://git-scm.com/) for both mods; run `git fetch` yourself before comparing with a remote base.
- The [GitHub CLI](https://cli.github.com/) (`gh`), authenticated with `gh auth status`, for GitHub Spaces.

Mods run trusted code: one that queries a service or runs commands does so with your credentials. Each mod's README says what it touches.

## Repository layout

Each mod has its own folder containing user documentation, the installable files under `mods/<name>/`, and a regression check where one exists. GitHub Spaces also ships a `RECIPE.md` build brief and `preview.png`.

No replacement layout or key bindings are included. GitHub Spaces plugs into the existing Spaces block; Branch review needs one key, shown in its README:

```json
"cmd-shift-b": "mod.open:branch-review"
```
