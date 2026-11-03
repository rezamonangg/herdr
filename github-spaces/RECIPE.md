# GitHub Spaces

Build a replacement for Herdr's Spaces sidebar that adds GitHub PR marks, comment badges, merge notifications, and a fetch/rebase button. Preserve the shipped sidebar's machine groups, worktree nesting, navigation, menus, and drag-to-reorder behavior.

![GitHub Spaces](preview.png)

This is a build brief, not an installation guide. See [README.md](README.md) for installation, controls, and limitations. The files beside this recipe are one implementation.

## What you see

- A theme-aware Spaces panel with its existing header, new-space control, machine groups, colored avatars, and scrollable rows.
- Main rows are 30px high; nested worktree rows are 28px. The original sidebar's compact rail remains available.
- PR marks replace the branch icon on nested rows and appear after the name on main rows. Tooltips include the PR number.
- A download-arrow button sits beside each repository space's name. Raw ahead/behind counts remain at the right of the row.

| PR state | Mark | Color |
| --- | --- | --- |
| Failed checks | Cross | Red `#ef4444` |
| Running checks | Native spinning ring | Yellow `#eab308` |
| Passing classification | Circle-check | Green `#22c55e` |
| Merged | Circle-check | Purple `#a78bfa` |
| Closed | Minus | Theme dim |
| No known PR | Original sidebar icon | Unchanged |

An unread latest comment adds a 12px speech bubble in the theme accent color. PR marks are about 13px; the download arrow is 14px. Strictly behind branches get a red arrow and a 16px-high red pill with a bold white count. Otherwise the arrow uses theme blue.

## How it behaves

### Branch and PR lookup

Determine each space's checkout from its first terminal's live folder, falling back to its saved folder. Group linked worktrees by Git's common directory, scoped to the machine.

Read branch and ahead/behind counts with `git status --porcelain=v2 --branch`. Use Git-directory watches and the existing sidebar refresh logic to update local state.

Every two minutes, query known branches with:

```sh
gh pr view <branch> --json number,state,statusCheckRollup,comments
```

Run commands on the space's machine. Deduplicate in-flight lookups by machine and folder. Poll even when the window is not focused. If `gh` cannot start, back off that machine for 30 minutes. Known no-PR responses clear the PR mark; other command failures preserve the previous result.

For checks, failure takes priority over running, then passing. The current implementation uses `conclusion`, falling back to `status`. An empty check list falls through to passing; do not describe this as proof that a PR is ready to merge.

### Notifications

The first successful lookup of a place is quiet. Later, a newly observed merge triggers a toast and, for linked worktrees only, opens Herdr's existing `worktree` removal dialog. Record handled PRs in `localStorage` to avoid repeated prompts. Never delete automatically.

Track the latest top-level PR comment's timestamp, author, and first line. New latest comments from someone other than the local `gh` account can trigger one toast and a bubble. Clicking the space row records the comment as read. This is not a complete review or inline-comment feed.

Keep agent status in the existing agents list; do not replace it with PR status.

### Fetch/rebase

- Red means `behind > 0` and `ahead === 0`. Show the behind count in the badge.
- Ahead and behind together means diverged. Keep the arrow blue and explain in the tooltip: inspect history before rebasing or pushing.
- Clicking runs `git fetch`, then plain `git rebase` in that checkout. Use its configured upstream, not the PR's base branch.
- While the mod's operation runs, animate the arrow natively. Show errors in a toast and refresh all checkout counts for that repository afterward.
- Never push, auto-resolve conflicts, or abort an operation. A conflict can leave rebase paused. External rebases are not detected or animated by the current implementation.

Counts reflect the last fetch. Do not auto-fetch just to refresh the display. Blue is a default, not an assertion that the branch is synchronized.

## Built from

One mod folder, `mods/github-spaces/`, containing `main.js`, `mod.json`, `arrow-down.svg`, and `comment.svg`. The manifest uses `place: "none"`; the person's personal layout references the mod in its existing spaces block. No layout files or key bindings are shipped.

Start from a clone of Herdr's shipped `spaces` mod. Never edit the shipped original. Reuse its grouping, watchers, menus, and row interactions.

The main paths through `main.js` are:

| Responsibility | Entry points |
| --- | --- |
| Checkout state and grouping | `check`, `refreshGit`, `ordered`, `grouped` |
| PR polling and classification | `pollPRs`, `readPR` |
| Notifications and remembered state | `speak`, `readPrComments` |
| Row controls | `prMark`, `fetchButton`, `fetchRebase` |

Use `exec` with `{ cwd, on }` for Git and GitHub CLI commands. Use `notify` for toasts and `openOverlay` for Herdr's removal dialog. Reuse shipped `workspace-chrome` icons where possible; keep only the arrow and comment assets in this mod.

Use `cx.spawn` for async work, `cx.timer` for data polling, and native `.spin(900)` for animation. Persist handled merges and comment timestamps in `localStorage`. Read the installed Herdr guide and generated types before building against its API.

## Watch out

- `window()` is null during headless checks. Skip PR polling there, but do not gate real polling on `window().active`.
- Never pass `null` to `.child()`. A no-PR row must retain its original icon without crashing the sidebar.
- Stop mouse propagation on the fetch button so it does not trigger row selection or dragging.
- Do not retain a callback's `cx`; each callback receives its own.
- Ahead/behind counts cannot distinguish a completed rebase from independent remote commits. Do not recommend a push based only on those counts.
- Remote `gh` accounts may differ from the local account used for own-comment filtering. Preserve this limitation in user documentation.

## Done when

1. `node github-spaces/test-branch-status.cjs` passes from the repository root. It covers synchronized, behind-only, ahead-only, independently diverged, and rebased-but-unpushed histories.
2. `herdr-app check <installed-mod-directory>` passes, status reports no errors, and a live screenshot confirms row layout and colors.
3. PR and no-PR rows both render; worktree nesting, selection, menus, and reordering still work.
4. Clicking fetch/rebase animates, reports failures, and refreshes counts. A merge prompts once without automatic deletion; new latest comments notify and their bubbles clear on a row click.

Headless checks and branch-state tests do not prove live notification behavior. Exercise those transitions separately before claiming full verification.
