# Herdr mods

Personal mods for [Herdr](https://herdr.dev), packaged for the [mods gallery](https://herdr.dev/mods/).

## GitHub Spaces

Replace the Spaces sidebar with GitHub PR status, comment badges, worktree cleanup prompts, and a fetch/rebase button.

- **PR status:** orange merge conflicts, red failed checks, yellow running checks, green passing checks, purple merged PRs.
- **Branch status:** blue download arrow by default; red arrow and count when strictly behind the configured upstream.
- **Feedback:** a human-comment count and persistent latest-five dock with GitHub links; a removal prompt when a worktree's PR merges.

**[Install and use GitHub Spaces →](github-spaces/README.md)**

[Build recipe](github-spaces/RECIPE.md) · [Source](github-spaces/mods/github-spaces/main.js)

Requires Herdr, Git, and an authenticated GitHub CLI (`gh`). Mods run trusted code: this one queries GitHub and runs Git commands.

## Repository layout

Each mod has its own folder containing user documentation, a `RECIPE.md` build brief, a `preview.png`, and `mods/<name>/` installable files. No replacement layout or key bindings are included.
