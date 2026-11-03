# GitHub Spaces

The Herdr Spaces sidebar with PR status, comment badges, merged-worktree cleanup prompts, and a fetch/rebase button.

![GitHub Spaces preview](preview.png)

Keeps space selection, drag-to-reorder, right-click menus, machine groups, and nested worktree rows.

## Install

Requires Herdr, Git, and [GitHub CLI](https://cli.github.com/) authenticated with access to your repositories.

1. Check GitHub access with `gh auth status`.
2. From this repository's root, copy the mod into Herdr's configuration directory. Back up an existing installation first; this replaces its files.

   ```sh
   mkdir -p ~/.config/herdr-app/mods
   cp -R github-spaces/mods/github-spaces ~/.config/herdr-app/mods/
   ```

   If you use `HERDR_APP_HOME`, use that directory instead of `~/.config/herdr-app`.

3. In your **personal layout**, change the spaces block's `content` to:

   ```json
   { "mod": "github-spaces" }
   ```

   Do not edit a shipped layout. If you use the shipped `main` layout, clone it first; this also switches to the clone:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"main-github"}'
   ```

   Edit `layouts/main-github.json` under your Herdr configuration directory. No other panels or key bindings need changing.

4. Validate the installed mod:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/github-spaces
   herdr-app status
   ```

Herdr reloads saved changes automatically. PR lookups run every two minutes, including in the background; allow a polling cycle for marks to appear.

## Read the sidebar

### PR marks

| Mark | Meaning |
| --- | --- |
| Red cross | Checks failed |
| Yellow spinner | Checks running or pending |
| Green circle-check | Checks classified as passing |
| Purple circle-check | PR merged |
| Grey minus | PR closed without merging |
| Original icon | No known PR for the branch |

Hover a mark for its PR number and status. A bubble marks the latest comment from someone other than the locally authenticated account. Clicking the space row clears it.

### Fetch/rebase button

| Appearance | Meaning |
| --- | --- |
| Blue arrow | Default; not a guarantee that the branch is up to date |
| Red arrow + count | Behind the configured upstream, with no local-only commits |
| Blue arrow + divergence tooltip | Both ahead and behind; inspect history before rebasing or pushing |
| Spinning arrow | Fetch/rebase started by this mod is running |

Clicking the arrow runs `git fetch`, then `git rebase` against the branch's configured upstream. It does not push or resolve conflicts. Errors appear as toasts; conflicts can leave a rebase paused for you to finish or abort.

The row's `↑N ↓N` values are Git's raw commit counts. They compare local history with the **last fetched upstream**, not the PR's base branch. After rebasing, both counts can be nonzero. The mod does not automatically fetch or detect rebases started in another terminal.

## Notifications and cleanup

- New latest comments can trigger a toast. The first lookup is quiet, so old comments do not trigger notifications.
- A newly observed merge triggers a toast. For a linked worktree, Herdr's existing removal dialog also opens.
- Removal requires confirmation. The dialog warns about local changes; removal closes the space and deletes the checkout. The branch remains.
- Previously handled merges are remembered. Main checkouts are never offered for removal by this mod.

## Limits and troubleshooting

- **No PR marks:** wait for a polling cycle, then run `gh pr view` from the checkout. Confirm the branch has a PR and `gh` has access.
- **Remote spaces:** Git and `gh` run on that space's machine. If `gh` cannot start, lookups on that machine pause for 30 minutes. Authentication failures also prevent fresh results.
- **Unexpected grouping:** the mod uses the first terminal's live folder, falling back to the saved folder—not the space's display name.
- **Checks:** an empty check list currently counts as passing. Green is not a guarantee of merge readiness.
- **Comments:** only the latest top-level PR comment is tracked, not a complete review or inline-comment feed. Own-comment filtering uses the local `gh` account, which may differ from a remote machine's account.

This is trusted code: it queries GitHub, reads repository state, and runs Git commands. Status changes alone do not fetch, rebase, push, or remove worktrees. Fetch/rebase requires a click; removal requires confirmation.

## Development

Start with [`mods/github-spaces/main.js`](mods/github-spaces/main.js). The [recipe](RECIPE.md) describes the UI and build requirements.

From the repository root:

```sh
node github-spaces/test-branch-status.cjs
git diff --check
```

The regression check uses disposable local Git repositories to verify arrow colors, badges, and divergence text. It does not touch your working branches. Also run Herdr's check on the installed mod and inspect the live sidebar; headless checks do not cover every later render state.
