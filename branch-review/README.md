# Branch review

A native Herdr tab for local branch review: changed files in a tree on the left, one file's diff on the right, with syntax colours and **Split / Unified** layouts. No Bun app, no web view.

It reads `git diff <merge-base(base, HEAD)>`, so it includes uncommitted edits. It never fetches or calls GitHub.

## Install

Requires Herdr and Git. No other mod.

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
- **Split** / **Unified** buttons switch layouts. Added and deleted files use one full-width column, because the other side does not exist.
- The plain diff appears first; syntax colours arrive a moment later. Large files never hide the diff behind a spinner.
- Click `vs origin/main` to pick another base. The choice is remembered per checkout.
- `↺` reloads after a commit, edit, or fetch.
- **Escape** closes the base list.

## How it is built

The file list and each patch are plain Git (`name-status`, `numstat`, `git diff`). For the selected file, the old side comes from the merge-base blob and the new side from the working file. A pinned local **Prism 1.30.0** (MIT, `vendor/prism.js`) tokenises each complete side once; its tokens become coloured spans in GPUI. No external process, no terminal escape codes, no gitview.

A row is coloured only when the highlighted line joins back to exactly the patch text. A mismatch, unknown language, binary file, side over 128 KiB, or a Prism failure leaves the row plain.

The vendor copy is **PrismJS 1.30.0**, MIT (`vendor/LICENSE.prism`), with core plus clike, markup, javascript, typescript, go, python, bash, yaml, json, and markdown. SHA-256 of `vendor/prism.js`:

```
88a8085b6a7006b0ce250333b191e43545e13491ea9bdb6e4006eeeb19c707cd
```

To update: rebuild the same core-plus-languages bundle from the pinned npm package, replace `vendor/prism.js` and `vendor/LICENSE.prism`, update the hash here, and rerun both checks.

## Limits

- Local machine only. A remote space needs Git on that machine.
- No GitHub PR metadata, comments, or notes.
- No automatic fetch; run `git fetch` first.
- Fork PRs need the commit checked out.
- Highlighting is skipped for a side over 128 KiB; the plain diff still shows.
- Prism runs synchronously. Very large files are capped rather than offloaded.
- Highlighting covers the languages in the vendor list; anything else is plain.

## Development

From the repository root:

```sh
node branch-review/test-branch-review.cjs
node branch-review/test-syntax.cjs
herdr-app check branch-review/mods/branch-review
herdr-app check ~/.config/herdr-app/mods/branch-review
```
