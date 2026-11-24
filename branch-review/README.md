# Branch review

A native Herdr tab for local branch review: changed files in a tree on the left, one file's diff on the right, with syntax colours and **Split / Unified** layouts. No Bun app, no web view.

It reads `git diff <merge-base(base, HEAD)>`, so it includes uncommitted edits. It never fetches or calls GitHub.

## Install

Requires Herdr and Git. For colours it uses the **gitview** engine if installed; without it the same view renders in plain red/green.

1. Copy the mod:

   ```sh
   mkdir -p ~/.config/herdr-app/mods
   cp -R branch-review/mods/branch-review ~/.config/herdr-app/mods/
   ```

2. Bind a key in `~/.config/herdr-app/keys.json`:

   ```json
   "cmd-shift-b": "mod.open:branch-review"
   ```

3. Check:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/branch-review
   herdr-app status
   ```

Press **Cmd+Shift+B** in a space. It opens a **branch review** tab. Press again to close it; from another tab it jumps to the review. One mod does both jobs: opened by the key it is a 2×2 launcher, opened in the tab it is the review.

Herdr loads new key bindings at start: quit and reopen once after adding the key.

## Use

- Left: changed files as a tree, with `M`, `A`, `D`, `R`, `U` and `+`/`−`.
- Click a file: its diff opens on the right.
- **Split** / **Unified** buttons switch layouts.
- Click `vs origin/main` to pick another base. The choice is remembered per checkout.
- `↺` reloads after a commit, edit, or fetch.
- **Escape** closes the base list.

## How it is built

The file list is plain Git (`name-status`, `numstat`, untracked files). The coloured rows come from gitview's local diff engine, already on this machine:

```sh
herdr-gitview json diff --merge-base <sha> --base <label> --path <path> --kind <kind>
```

That engine returns syntax-coloured spans, line numbers, renames, binary and truncation flags. This mod pairs them for side-by-side and draws them in GPUI. If the engine is missing, it falls back to plain `git diff` rows, so the tab still works without gitview.

## Limits

- Local machine only. A remote space needs Git (and the engine) on that machine.
- No GitHub PR metadata, comments, or notes.
- No automatic fetch; run `git fetch` first.
- Fork PRs need the commit checked out.
- Diffs are capped by the engine at 5,000 rows; very long lines are clipped.
- The engine's JSON shape is private to gitview. If it changes, colours may fail; the plain fallback still renders.
