# Azure DevOps PR dashboard (canvas extension)

An interactive Copilot CLI **canvas** that shows Azure DevOps pull requests, lets you review
them (vote, comment, resolve threads, toggle draft/auto-complete) and exposes agent-callable
actions so Copilot can reason over your PRs.

- **Filter** by project, repository, status, creator, reviewer, target branch and title

- **Review** commits, changed files with dependency-free inline unified diffs, policy evaluations, status checks and discussion threads

- **Act** — vote (approve / suggestions / wait / reject), comment and reply, resolve threads, toggle draft, set auto-complete

- **Stay current** — 60 s polling pushed to the UI over Server-Sent Events, plus manual refresh

- **Agent actions** — `list_ado_pull_requests`, `show_ado_pr_detail`, `show_ado_pr_file_diff`, `vote_on_ado_pull_request`, `comment_on_ado_pull_request`, `refresh_ado_pull_requests`

Canvas id: `ado-pr-dashboard` · display name: **Azure DevOps PRs**

## Using it in other sessions

The extension is discovered per session from its folder, so where you put it decides who
sees it:

| Scope | Location | Visible in |
| --- | --- | --- |
| Project (this repo) | `.github/extensions/ado-pr-dashboard/` | Any session whose git root is this repo, **once the branch is merged to `main`** |
| User (personal) | `$COPILOT_HOME/extensions/ado-pr-dashboard/` (`~/.copilot/...`) | Every session, in every repo, for you only |
| Gist | `share_extension` → `install_extension` | Whoever you share the gist with |

To install it for yourself everywhere:

```powershell
Copy-Item -Recurse -Force `
  '.github\extensions\ado-pr-dashboard' `
  "$env:USERPROFILE\.copilot\extensions\ado-pr-dashboard"
```

Then run `extensions_reload` (or start a new session).

> **Heads-up:** if both a project copy *and* a user copy are loaded in the same session,
> they both declare canvas id `ado-pr-dashboard` and `open_canvas` fails with
> `canvas_ambiguous`. Pass `extensionId: "project:ado-pr-dashboard"` or
> `"user:ado-pr-dashboard"` to disambiguate, or delete one of the copies. This only
> happens in a checkout that actually contains `.github/extensions/ado-pr-dashboard/`.

Remember that the PAT is read when the extension process starts, so a session started
before `AZURE_DEVOPS_PAT` was set needs an `extensions_reload` (the Windows
`HKCU\Environment` fallback below covers most of this).

## Setup

1. Create a Personal Access Token in Azure DevOps for your organization
   (`https://dev.azure.com/{organization}/_usersSettings/tokens`).

   Required scopes:
   - **Code** — *Read & write* (read PRs, cast votes, post comments, update PRs)
   - **Work Items** — *Read*

2. Put it in your environment before launching the app:

   ```powershell
   $env:AZURE_DEVOPS_PAT = '<pat>'
   ```

   ```bash
   export AZURE_DEVOPS_PAT='<pat>'
   ```

   `AZDO_PAT` and `SYSTEM_ACCESSTOKEN` are accepted as fallbacks.

   On Windows the extension also reads the PAT from your persisted **user**
   environment (`HKCU\Environment`) when it isn't in `process.env`, so setting it with
   `[Environment]::SetEnvironmentVariable('AZURE_DEVOPS_PAT', '<pat>', 'User')` takes effect
   after `extensions_reload` without restarting the whole app. The value is held in memory
   only.

3. Open the canvas. If no token is found the canvas renders a setup message instead of
   failing — nothing throws, and no request is made.

The token is read from `process.env` on each request, sent only as
`Authorization: Basic base64(":" + pat)` to `dev.azure.com`, and is **never** written to
disk, logged, persisted in preferences, or returned to the iframe or the agent.

> **Avatars.** Profile images come from `_apis/GraphProfile/MemberAvatars`, which needs a
> Graph/Identity read scope. If your PAT doesn't have it those requests 401 and the UI
> silently falls back to initials bubbles — everything else keeps working.

## What it does

- **Filter bar** — project dropdown (`GET /_apis/projects`), repository dropdown
  (`GET /{project}/_apis/git/repositories`), status (active/completed/abandoned/all),
  creator, reviewer, target branch, plus a client-side title filter.
- **PR list** — org-wide (`GET /_apis/git/pullrequests`), project-wide, or repo-scoped,
  showing title, id, repo, author avatar, `source → target`, age, draft flag, merge status
  and colour-coded reviewer vote chips.
- **Detail pane** — description, commits, changed files (latest iteration), policy
  evaluations + status checks, and discussion threads.
- **Inline diffs** — in the **Files** tab, click any changed file (or **Expand all diffs**)
  to see its unified diff rendered inline with line numbers and add/delete highlighting.
  The extension fetches both blobs (`/_apis/git/repositories/{id}/items?includeContent=true`)
  at the iteration's merge-base and source commits and diffs them locally with a
  dependency-free LCS differ (`diff.mjs`). Results are cached per source commit and the
  cache is dropped when the branch is pushed to again. Binary files, added/deleted files
  and oversized files degrade to a clear message instead of failing.
- **Interactions** — vote (approve / approve-with-suggestions / reset / wait-for-author /
  reject), comment and reply, resolve/reactivate threads, toggle draft, set or cancel
  auto-complete (both behind a confirm), and open the PR in your real browser.
- **Auto-refresh** — polls every 60 s and pushes snapshots to the iframe over
  Server-Sent Events (`/events`); a manual **Refresh** button is always available.
- **Error states** — Azure DevOps messages are surfaced verbatim; 401/403 becomes
  "check your PAT scopes: Code (read & write), Work Items (read)".

## Agent-facing actions

| Action | Input | Returns |
| --- | --- | --- |
| `list_ado_pull_requests` | `project?`, `repository?`, `status?`, `creator?`, `reviewer?` | Compact PR summaries + effective filters |
| `show_ado_pr_detail` | `pullRequestId` or `url`, `project?`, `repository?` | Description, commits, changed files, checks, threads (and focuses it in the canvas) |
| `vote_on_ado_pull_request` | `pullRequestId`/`url`, `vote` (`approve`, `approve_with_suggestions`, `reset`, `wait_for_author`, `reject`) | Updated reviewer votes |
| `comment_on_ado_pull_request` | `pullRequestId`/`url`, `content`, `threadId?` | Thread count after posting |
| `show_ado_pr_file_diff` | `pullRequestId`/`url`, `path`, `project?`, `repository?` | Unified diff hunks (as text) for one changed file, plus add/delete counts |
| `refresh_ado_pull_requests` | — | PR count + `lastUpdated` |

## File layout

| File | Purpose |
| --- | --- |
| `extension.mjs` | Wiring only: `createCanvas`, action declarations/handlers, `open`/`onClose`, `joinSession` |
| `ado-client.mjs` | Azure DevOps REST client, PAT handling, error mapping, PR summarisation |
| `server.mjs` | Per-instance loopback `http.Server`, dashboard state machine, SSE, avatar proxy |
| `renderer.mjs` | HTML shell for the iframe |
| `styles.css` | Canvas styling using the mirrored app theme tokens (light + dark) |
| `client.js` | Iframe UI: rendering, filters, detail tabs, interactions |
| `store.mjs` | Durable user-global preferences |
| `diff.mjs` | Dependency-free LCS line differ producing unified-diff hunks |

## State

- **User-global preferences** (org, last project/repository/status, creator, reviewer,
  target branch, title filter, saved presets) live in
  `$COPILOT_HOME/extensions/ado-pr-dashboard/artifacts/preferences.json`
  (`$COPILOT_HOME` defaults to `~/.copilot`). Never in the repo, never keyed by `instanceId`.
- **Transient per-panel state** (active detail tab, scroll position, in-progress comment
  drafts) lives only in the iframe and is intentionally lost on reload.
- `open()` is idempotent and rehydrates from the durable store, so `reason: "rehydrate"`
  re-opens after `extensions_reload` restore the same view.

## Constraints honoured

- No `console.log` — stdout is reserved for JSON-RPC. Diagnostics go to stderr, visible via
  `extensions_manage({ operation: "inspect", name: "ado-pr-dashboard" })`.
- Servers bind to `127.0.0.1:0` only and are closed in `onClose`.
- No third-party npm dependencies; Node built-ins plus global `fetch` only.
