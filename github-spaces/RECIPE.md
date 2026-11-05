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
| Open PR with confirmed merge conflicts | Crossing branches with exclamation mark | Orange `#f97316` |
| Failed checks | Cross | Red `#ef4444` |
| Running checks | Native spinning ring | Yellow `#eab308` |
| Passing classification | Circle-check | Green `#22c55e` |
| Merged | Circle-check | Purple `#a78bfa` |
| Closed | Minus | Theme dim |
| No known PR | Original sidebar icon | Unchanged |

Pending human feedback adds a 12px speech bubble and bold count in the theme accent color. The count covers all pending comments, not only the five cards. PR marks are about 13px; the download arrow is 14px. Strictly behind branches get a red arrow and a 16px-high red pill with a bold white count. Otherwise the arrow uses theme blue.

## How it behaves

### Branch and PR lookup

Determine each space's checkout from its first terminal's live folder, falling back to its saved folder. Group linked worktrees by Git's common directory, scoped to the machine.

Read branch and ahead/behind counts with `git status --porcelain=v2 --branch`. Use Git-directory watches and the existing sidebar refresh logic to update local state.

Every two minutes, query known branches with:

```sh
gh pr view <branch> --json number,url,state,mergeable,statusCheckRollup,author
```

Run commands on the space's machine. Deduplicate in-flight lookups by machine and folder. Poll even when the window is not focused. If `gh` cannot start, back off that machine for 30 minutes. Known no-PR responses clear the PR mark; other command failures preserve the previous result.

For checks, failure takes priority over running, then passing. The current implementation uses `conclusion`, falling back to `status`. An empty check list falls through to passing; do not describe this as proof that a PR is ready to merge.

For open PRs, `mergeable: "CONFLICTING"` overrides the CI mark with the orange conflict icon and a merge-conflict tooltip. Do not treat `UNKNOWN` as a conflict. Merged and closed marks take priority. Restore the CI mark when GitHub no longer reports conflicts.

### Notifications

Comment notifications use the persistent worktree-scoped comment cards described in [README.md](README.md), plus one Herdr toast per newly seen pending human comment (click selects the space; also for comments that arrived while Herdr was closed; never when no card was saved yet). The sidebar saves the latest five human comments per space in shared `github-spaces.comments` state, with `attentionIds` (pending comments) and `dismissedIds` (cards the person closed). Five extra copies of the same mod, with `props: { role: "comment", slot: 0..4 }`, each render one card for the selected space and never initialize polling. Attach them as floating blocks with `edge: "bottom"`, `align: "end"` to the work-area node — attaching it to the terminal block covers the terminal's status line.

`dock.js` exports `commentCard(slot)`: a 360px-wide card (author, UTC time, 300-character preview, bottom-right GitHub link, × close). A slot past the last visible comment returns an empty div, so its block collapses. Open links through the click callback's `cx.open_url`; never through a shell.

Closing a card records its comment id; the sidebar count drops with it. A close callback dismisses by comment id, so it stays safe after newer activity arrived. Resolution and new commits never close cards; only × does. Switching spaces swaps cards without deleting state. The initial lookup can populate history without a toast.

The first successful lookup of a place is quiet. Later, a newly observed merge triggers a toast and, for linked worktrees only, opens Herdr's existing `worktree` removal dialog. Record handled PRs in `localStorage` to avoid repeated prompts. Never delete automatically.

Using the host and repository from the PR URL, fetch paginated REST issue comments, reviews, and inline comments. REST actor metadata identifies bot accounts and supplies direct comment URLs. Fetch paginated GraphQL `reviewThreads` with `isResolved` and the first comment's `databaseId`; match inline roots and replies to their thread.

Combine discussion comments, nonempty submitted review summaries, and inline replies. Exclude pending reviews, your own account, bot accounts, and usernames containing `bot` case-insensitively. Sort by creation/submission time, using comment identity to break ties. Do not collapse comments sharing a timestamp. Keep only the latest five for the dock, but calculate the sidebar count from the full human-comment list.

For open PRs, attention is the list of unresolved human comment ids. Attention also excludes comments older than the PR's latest commit (`commits[].committedDate` from `gh pr view`) — a push clears the badge; thread resolution, closing cards, or the PR closing/merging also do. The sidebar badge subtracts closed card ids from that list on every render.

If any activity endpoint fails, keep the previous comments and attention count while still refreshing CI and merge status. Never interpret a partial response as resolved feedback.

New human activity updates the persistent card. Resolving feedback or pushing a commit clears the sidebar without changing dock history. Edits are not tracked.

Keep agent status in the existing agents list; do not replace it with PR status.

### Fetch/rebase

- Red means `behind > 0` and `ahead === 0`. Show the behind count in the badge.
- Ahead and behind together means diverged. Keep the arrow blue and explain in the tooltip: inspect history before rebasing or pushing.
- Clicking runs `git fetch`, then plain `git rebase` in that checkout. Use its configured upstream, not the PR's base branch.
- While the mod's operation runs, animate the arrow natively. Show errors in a toast and refresh all checkout counts for that repository afterward.
- Never push, auto-resolve conflicts, or abort an operation. A conflict can leave rebase paused. External rebases are not detected or animated by the current implementation.

Counts reflect the last fetch. Do not auto-fetch just to refresh the display. Blue is a default, not an assertion that the branch is synchronized.

## Built from

One mod folder, `mods/github-spaces/`, containing `main.js`, `dock.js`, `mod.json`, `arrow-down.svg`, `comment.svg`, and `conflict.svg`. The manifest uses `place: "none"`; the person's personal layout references the mod in its existing spaces block and comment dock. No layout files or key bindings are shipped.

Start from a clone of Herdr's shipped `spaces` mod. Never edit the shipped original. Reuse its grouping, watchers, menus, and row interactions.

The main paths through `main.js` are:

| Responsibility | Entry points |
| --- | --- |
| Checkout state and grouping | `check`, `refreshGit`, `ordered`, `grouped` |
| PR polling and classification | `pollPRs`, `readPR` |
| Dock history and merge notifications | `speak`, `commentCard` in `dock.js` |
| Row controls | `prMark`, `fetchButton`, `fetchRebase` |

Use `exec` with `{ cwd, on }` for Git and GitHub CLI commands. Use `notify` for toasts and `openOverlay` for Herdr's removal dialog. Reuse shipped `workspace-chrome` icons where possible; keep the arrow, comment, and conflict assets in this mod.

Use `cx.spawn` for async work, `cx.timer` for data polling, and native `.spin(900)` for animation. Persist handled merges in `localStorage`; dock history and dismissal use shared state. Read the installed Herdr guide and generated types before building against its API.

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
4. Clicking fetch/rebase animates, reports failures, and refreshes counts. A merge prompts once without automatic deletion. Human feedback produces a numbered sidebar icon and a latest-five set of independent cards with exact comment links. Resolution and card closes lower the number; a newer commit clears the badge; only × closes a card.

Headless checks and branch-state tests do not prove live notification behavior. Exercise those transitions separately before claiming full verification.
