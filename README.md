# Herdr mods

Personal mods for [Herdr](https://herdr.dev), packaged for the [mods gallery](https://herdr.dev/mods/).

## Mods

| Mod | What it does | Docs |
| --- | --- | --- |
| **GitHub Spaces** | Replaces the Spaces sidebar with PR status, comment badges, worktree cleanup prompts, and a fetch/rebase button. | [Install and use →](github-spaces/README.md) · [Build recipe](github-spaces/RECIPE.md) · [Source](github-spaces/mods/github-spaces/main.js) |

Each mod's own README covers its marks, controls, notifications, and limits.

## Requirements

- [Herdr](https://herdr.dev).
- [Git](https://git-scm.com/) and the [GitHub CLI](https://cli.github.com/) (`gh`), authenticated with `gh auth status`, for GitHub Spaces.

Mods run trusted code: one that queries a service or runs commands does so with your credentials. Each mod's README says what it touches.

## Repository layout

Each mod has its own folder containing user documentation, a `RECIPE.md` build brief, a `preview.png`, the installable files under `mods/<name>/`, and a regression check where one exists. No replacement layout or key bindings are included.
