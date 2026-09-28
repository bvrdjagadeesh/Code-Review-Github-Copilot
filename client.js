// Azure DevOps PR dashboard - iframe client.
// Talks to the extension's own loopback endpoints; no privileged host bridge.

const root = document.getElementById("root");

/** Server-owned snapshot. */
let state = null;
/** Transient per-panel UI state (deliberately not persisted). */
const ui = { tab: "overview", titleFilter: "", drafts: {}, newComment: "", busy: false, openDiffs: new Set(), diffs: {}, diffPr: null };

const VOTES = [
    { key: "approve", label: "Approve" },
    { key: "approve_with_suggestions", label: "Approve w/ suggestions" },
    { key: "wait_for_author", label: "Wait for author" },
    { key: "reject", label: "Reject" },
    { key: "reset", label: "Reset vote" },
];

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function age(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "";
    const min = Math.round(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

async function api(path, body) {
    ui.busy = true;
    render();
    try {
        const res = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (data && data.state) applyState(data.state);
        return data;
    } catch (err) {
        if (state) state.error = err.message;
        return { error: err.message };
    } finally {
        ui.busy = false;
        render();
    }
}

function applyState(next) {
    state = next;
    // Diffs belong to one PR; drop them when the selection changes.
    const prId = next.selected?.summary?.pullRequestId ?? null;
    if (prId !== ui.diffPr) {
        ui.diffPr = prId;
        ui.openDiffs = new Set();
        ui.diffs = {};
    }
    if (typeof next.filters?.titleFilter === "string" && document.activeElement?.id !== "titleFilter") {
        ui.titleFilter = next.filters.titleFilter;
    }
}

/** Fetch one file diff without the global busy overlay, then repaint in place. */
async function loadDiff(path) {
    if (ui.diffs[path]) return;
    try {
        const res = await fetch("./api/pr/diff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        const data = await res.json().catch(() => ({}));
        ui.diffs[path] = data.diff || { error: data.error || `Could not load the diff (${res.status}).` };
    } catch (err) {
        ui.diffs[path] = { error: err.message };
    }
    render();
}

/* ---------------- rendering ---------------- */

// Avatar images need a Graph-scoped PAT. If the proxy can't fetch one, stop
// requesting them entirely and render initials instead.
let avatarsBlocked = false;

function initialsOf(name) {
    const parts = String(name || "?")
        .replace(/[[\]\\]/g, " ")
        .split(/[\s.]+/)
        .filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function avatarTag(url, name, cls = "avatar") {
    const initials = esc(initialsOf(name));
    if (!url || avatarsBlocked) return `<span class="${cls} initials" title="${esc(name)}">${initials}</span>`;
    const src = `./avatar?url=${encodeURIComponent(url)}`;
    return `<img class="${cls}" src="${esc(src)}" alt="" title="${esc(name)}" data-initials="${initials}" />`;
}

function wireAvatars() {
    for (const img of document.querySelectorAll("img[data-initials]")) {
        const fallback = () => {
            avatarsBlocked = true;
            const span = document.createElement("span");
            span.className = `${img.className} initials`;
            span.title = img.title;
            span.textContent = img.dataset.initials;
            img.replaceWith(span);
        };
        img.addEventListener("error", fallback);
        if (img.complete && img.naturalWidth === 0) fallback();
    }
}

function setupBanner() {
    return `<div class="banner">
<strong>Azure DevOps PAT not configured.</strong>
Set a Personal Access Token in your environment and restart the app:
<div class="mono">PowerShell:  $env:AZURE_DEVOPS_PAT = '&lt;pat&gt;'</div>
Accepted variables: <code>AZURE_DEVOPS_PAT</code>, <code>AZDO_PAT</code>, <code>SYSTEM_ACCESSTOKEN</code>.
Required scopes: <strong>Code (read &amp; write)</strong>, <strong>Work Items (read)</strong>.
</div>`;
}

function filterBar() {
    const f = state.filters;
    const projectOptions = ['<option value="">Select project…</option>']
        .concat(state.projects.map((p) => `<option value="${esc(p.name)}"${p.name === f.project ? " selected" : ""}>${esc(p.name)}</option>`))
        .join("");
    const repoOptions = ['<option value="">All repositories</option>']
        .concat(state.repositories.map((r) => `<option value="${esc(r.id)}"${r.id === f.repositoryId ? " selected" : ""}>${esc(r.name)}</option>`))
        .join("");
    const statusOptions = ["active", "completed", "abandoned", "all"]
        .map((s) => `<option value="${s}"${s === f.status ? " selected" : ""}>${s}</option>`)
        .join("");

    return `<div class="filters">
  <div class="field"><label for="project">Project</label><select id="project">${projectOptions}</select></div>
  <div class="field"><label for="repository">Repository</label><select id="repository"${state.repositories.length ? "" : " disabled"}>${repoOptions}</select></div>
  <div class="field"><label for="status">Status</label><select id="status">${statusOptions}</select></div>
  <div class="field"><label for="creator">Creator</label><input type="text" id="creator" placeholder="display name or id" value="${esc(f.creator)}" /></div>
  <div class="field"><label for="reviewer">Reviewer</label><input type="text" id="reviewer" placeholder="display name or id" value="${esc(f.reviewer)}" /></div>
  <div class="field"><label for="targetBranch">Target branch</label><input type="text" id="targetBranch" placeholder="main" value="${esc(f.targetBranch)}" /></div>
  <div class="field" style="flex:1 1 180px"><label for="titleFilter">Title contains</label><input type="text" id="titleFilter" placeholder="filter titles…" value="${esc(ui.titleFilter)}" /></div>
</div>`;
}

function voteChips(pr) {
    const reviewers = pr.reviewers.filter((r) => r.vote !== 0);
    const pending = pr.reviewers.length - reviewers.length;
    const chips = reviewers.map(
        (r) => `<span class="chip vote-${esc(r.voteLabel)}">${avatarTag(r.avatar, r.displayName, "avatar sm")}${esc(r.displayName)}${r.isRequired ? " *" : ""}</span>`,
    );
    if (pending > 0) chips.push(`<span class="chip">${pending} awaiting</span>`);
    return chips.join("");
}

function prRow(pr) {
    const selected = state.selected?.summary?.pullRequestId === pr.pullRequestId;
    const flags = [];
    if (pr.isDraft) flags.push('<span class="chip draft">draft</span>');
    if (pr.mergeStatus && pr.mergeStatus !== "succeeded") flags.push(`<span class="chip warn">${esc(pr.mergeStatus)}</span>`);
    if (pr.autoCompleteSetBy) flags.push('<span class="chip ok">auto-complete</span>');
    return `<div class="pr${selected ? " selected" : ""}" data-pr="${pr.pullRequestId}" data-repo="${esc(pr.repositoryId)}" data-project="${esc(pr.project)}">
  ${avatarTag(pr.createdBy.avatar, pr.createdBy.displayName)}
  <div class="pr-main">
    <div class="pr-title">${esc(pr.title)}</div>
    <div class="pr-sub">
      <span>!${pr.pullRequestId}</span>
      <span>${esc(pr.repository)}</span>
      <span>${esc(pr.createdBy.displayName)}</span>
      <span class="branch">${esc(pr.sourceBranch)} → ${esc(pr.targetBranch)}</span>
      <span>created ${esc(age(pr.creationDate))}</span>
      ${flags.join("")}
    </div>
    <div class="chips">${voteChips(pr)}</div>
  </div>
</div>`;
}

function listPane() {
    if (state.loading && !state.pullRequests.length) return '<div class="loading">Loading pull requests…</div>';
    const needle = ui.titleFilter.trim().toLowerCase();
    const items = needle ? state.pullRequests.filter((pr) => pr.title.toLowerCase().includes(needle)) : state.pullRequests;
    if (!items.length) {
        return `<div class="empty">${state.filters.project ? "No pull requests match the current filters." : "Pick a project to load pull requests, or browse the whole organization."}</div>`;
    }
    return items.map(prRow).join("");
}

function detailPane() {
    if (state.detailLoading) return '<div class="loading">Loading pull request…</div>';
    const d = state.selected;
    if (!d) return '<div class="empty">Select a pull request to see its details.</div>';
    const pr = d.summary;
    const tabs = [
        ["overview", "Overview"],
        ["commits", `Commits (${d.commits.length})`],
        ["files", `Files (${d.changes.length})`],
        ["checks", `Checks (${d.statuses.length + d.policies.length})`],
        ["threads", `Threads (${d.threads.filter((t) => !t.isSystem).length})`],
    ];
    return `<div class="detail-head">
  <h2>${esc(pr.title)}</h2>
  <div class="pr-sub">
    <span>!${pr.pullRequestId}</span><span>${esc(pr.project)}/${esc(pr.repository)}</span>
    <span class="branch">${esc(pr.sourceBranch)} → ${esc(pr.targetBranch)}</span>
    <span>${esc(pr.status)}</span><span>updated ${esc(age(pr.creationDate))}</span>
  </div>
  <div class="chips">${voteChips(pr)}</div>
  <div class="actions">
    ${VOTES.map((v) => `<button data-vote="${v.key}">${esc(v.label)}</button>`).join("")}
    <button data-draft="${pr.isDraft ? "publish" : "draft"}">${pr.isDraft ? "Publish PR" : "Mark as draft"}</button>
    <button data-autocomplete="${pr.autoCompleteSetBy ? "off" : "on"}">${pr.autoCompleteSetBy ? "Cancel auto-complete" : "Set auto-complete"}</button>
    <button class="primary" data-external="1">Open in Azure DevOps</button>
  </div>
</div>
<div class="tabs">${tabs.map(([key, label]) => `<button class="tab${ui.tab === key ? " active" : ""}" data-tab="${key}">${esc(label)}</button>`).join("")}</div>
<div class="pane">${tabBody(d)}</div>`;
}

function tabBody(d) {
    if (ui.tab === "commits") {
        if (!d.commits.length) return '<div class="empty">No commits.</div>';
        return `<div class="rows">${d.commits
            .map((c) => `<div class="row"><span class="mono">${esc(c.shortId)}</span><span>${esc(c.comment.split("\n")[0])}</span><span class="meta">${esc(c.author)} · ${esc(age(c.date))}</span></div>`)
            .join("")}</div>`;
    }
    if (ui.tab === "files") {
        if (!d.changes.length) return '<div class="empty">No file changes.</div>';
        const allOpen = d.changes.every((c) => ui.openDiffs.has(c.path));
        return `<div class="pane-toolbar">
    <button data-diff-all="${allOpen ? "collapse" : "expand"}">${allOpen ? "Collapse all" : "Expand all diffs"}</button>
    <span class="meta">Click a file to see its diff against the merge base.</span>
  </div>
  <div class="rows">${d.changes.map(fileBlock).join("")}</div>`;
    }
    if (ui.tab === "checks") {
        const rows = [
            ...d.policies.map((p) => {
                const cls = p.status === "approved" ? "ok" : p.status === "rejected" ? "bad" : "warn";
                return `<div class="row"><span class="chip ${cls}">${esc(p.status)}</span><span>${esc(p.displayName)}${p.isBlocking ? " (blocking)" : ""}</span><span class="meta">${esc(p.description)}</span></div>`;
            }),
            ...d.statuses.map((s) => {
                const cls = s.state === "succeeded" ? "ok" : s.state === "failed" || s.state === "error" ? "bad" : "warn";
                return `<div class="row"><span class="chip ${cls}">${esc(s.state)}</span><span>${esc(s.context)}</span><span class="meta">${esc(s.description)}</span></div>`;
            }),
        ];
        if (!rows.length) return '<div class="empty">No policies or status checks.</div>';
        return `<div class="rows">${rows.join("")}</div>`;
    }
    if (ui.tab === "threads") {
        const threads = d.threads.filter((t) => !t.isSystem && t.comments.length);
        const composer = `<div class="thread">
  <div class="thread-head"><strong>New comment</strong></div>
  <textarea id="newComment" placeholder="Leave a comment on this pull request…">${esc(ui.newComment)}</textarea>
  <div class="reply"><button class="primary" data-newcomment="1">Comment</button></div>
</div>`;
        if (!threads.length) return `${composer}<div class="empty">No discussion threads yet.</div>`;
        return composer + threads.map(threadBlock).join("");
    }
    // overview
    const pr = d.summary;
    return `<div class="chips">
    <span class="chip">merge: ${esc(pr.mergeStatus || "unknown")}</span>
    ${pr.isDraft ? '<span class="chip draft">draft</span>' : ""}
    ${pr.autoCompleteSetBy ? `<span class="chip ok">auto-complete by ${esc(pr.autoCompleteSetBy)}</span>` : ""}
  </div>
  <p class="desc">${pr.description ? esc(pr.description) : '<span class="meta">No description.</span>'}</p>`;
}

function fileBlock(change) {
    const open = ui.openDiffs.has(change.path);
    const diff = ui.diffs[change.path];
    const stats =
        diff && !diff.binary && !diff.unavailable
            ? `<span class="meta"><span class="add-count">+${diff.additions}</span> <span class="del-count">-${diff.deletions}</span></span>`
            : "";
    return `<div class="file">
  <div class="file-head" data-file="${esc(change.path)}">
    <span class="caret">${open ? "▾" : "▸"}</span>
    <span class="chip">${esc(change.changeType)}</span>
    <span class="mono">${esc(change.path)}</span>
    <span class="spacer"></span>
    ${stats}
  </div>
  ${open ? `<div class="file-diff">${diffBody(diff)}</div>` : ""}
</div>`;
}

function diffBody(diff) {
    if (!diff) return '<div class="loading">Loading diff…</div>';
    if (diff.error) return `<div class="banner error">${esc(diff.error)}</div>`;
    if (diff.unavailable) return `<div class="empty">Diff unavailable: ${esc(diff.unavailable)}</div>`;
    if (diff.binary) return '<div class="empty">Binary file — not shown.</div>';
    if (diff.tooLarge) return `<div class="empty">File is too large to diff inline (${diff.additions} added / ${diff.deletions} removed lines).</div>`;
    if (diff.identical || !diff.hunks.length) return '<div class="empty">No textual changes.</div>';
    return diff.hunks
        .map((hunk) => {
            const header = `<div class="hunk-head mono">@@ -${hunk.oldStart} +${hunk.newStart} @@</div>`;
            const rows = hunk.lines
                .map(
                    (line) => `<div class="dline ${line.type}"><span class="ln">${line.oldNo ?? ""}</span><span class="ln">${line.newNo ?? ""}</span><span class="sign">${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span><span class="dtext">${esc(line.text) || "&nbsp;"}</span></div>`,
                )
                .join("");
            return `<div class="hunk">${header}${rows}</div>`;
        })
        .join("");
}

function threadBlock(t) {
    const resolved = ["fixed", "closed", "wontFix", "byDesign"].includes(t.status);
    return `<div class="thread">
  <div class="thread-head">
    <span class="chip ${resolved ? "ok" : "warn"}">${esc(t.status)}</span>
    ${t.filePath ? `<span class="mono">${esc(t.filePath)}${t.line ? `:${t.line}` : ""}</span>` : ""}
    <span class="spacer"></span>
    <button data-thread-status="${t.id}" data-next="${resolved ? "active" : "fixed"}">${resolved ? "Reactivate" : "Resolve"}</button>
  </div>
  ${t.comments
      .map(
          (c) => `<div class="comment">${avatarTag(c.avatar, c.author, "avatar sm")}<div class="comment-body"><strong>${esc(c.author)}</strong> <span class="meta">${esc(age(c.publishedDate))}</span><div>${esc(c.content)}</div></div></div>`,
      )
      .join("")}
  <div class="reply">
    <input type="text" data-reply-input="${t.id}" placeholder="Reply…" value="${esc(ui.drafts[t.id] || "")}" />
    <button data-reply="${t.id}">Reply</button>
  </div>
</div>`;
}

function render() {
    if (!state) return;
    const listScroll = document.querySelector(".list")?.scrollTop ?? 0;
    const detailScroll = document.querySelector(".detail")?.scrollTop ?? 0;
    const activeId = document.activeElement?.id;
    const selStart = document.activeElement?.selectionStart;

    const banner = !state.config.patConfigured ? setupBanner() : "";
    const error = state.error && state.config.patConfigured ? `<div class="banner error">${esc(state.error)}</div>` : "";

    root.className = ui.busy ? "busy" : "";
    root.innerHTML = `<div class="topbar">
  <h1>Azure DevOps PRs</h1>
  <span class="meta">${esc(state.config.org)}${state.identity ? ` · ${esc(state.identity.displayName)}` : ""}</span>
  <span class="spacer"></span>
  <span class="meta">${state.pullRequests.length} PRs${state.lastUpdated ? ` · updated ${esc(age(state.lastUpdated))}` : ""}${state.autoRefresh ? " · auto-refresh 60s" : ""}</span>
  <button id="refresh">Refresh</button>
</div>
${state.config.patConfigured ? filterBar() : ""}
${banner}${error}
<div class="split">
  <section class="list">${state.config.patConfigured ? listPane() : ""}</section>
  <section class="detail">${state.config.patConfigured ? detailPane() : ""}</section>
</div>`;

    const list = document.querySelector(".list");
    if (list) list.scrollTop = listScroll;
    const detail = document.querySelector(".detail");
    if (detail) detail.scrollTop = detailScroll;
    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
            el.focus();
            if (selStart != null && el.setSelectionRange) {
                try {
                    el.setSelectionRange(selStart, selStart);
                } catch {
                    /* not a text input */
                }
            }
        }
    }
    wire();
    wireAvatars();
}

/* ---------------- events ---------------- */

let titleTimer;

function wire() {
    document.getElementById("refresh")?.addEventListener("click", () => api("/api/refresh", {}));

    for (const id of ["project", "repository", "status"]) {
        document.getElementById(id)?.addEventListener("change", (e) => {
            const patch = { [id === "repository" ? "repositoryId" : id]: e.target.value };
            if (id === "project") patch.repositoryId = "";
            api("/api/filters", patch);
        });
    }
    for (const id of ["creator", "reviewer", "targetBranch"]) {
        document.getElementById(id)?.addEventListener("change", (e) => api("/api/filters", { [id]: e.target.value }));
    }

    const titleInput = document.getElementById("titleFilter");
    titleInput?.addEventListener("input", (e) => {
        ui.titleFilter = e.target.value;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(() => api("/api/filters", { titleFilter: ui.titleFilter, noRefetch: true }), 400);
        const listEl = document.querySelector(".list");
        if (listEl) listEl.innerHTML = listPane();
        wireRows();
        wireAvatars();
    });

    wireRows();

    for (const btn of document.querySelectorAll(".tab")) {
        btn.addEventListener("click", () => {
            ui.tab = btn.dataset.tab;
            render();
        });
    }

    for (const btn of document.querySelectorAll("[data-vote]")) {
        btn.addEventListener("click", () => api("/api/pr/vote", { vote: btn.dataset.vote }));
    }
    for (const btn of document.querySelectorAll("[data-draft]")) {
        btn.addEventListener("click", () => {
            const toDraft = btn.dataset.draft === "draft";
            if (!confirm(toDraft ? "Mark this pull request as a draft?" : "Publish this draft pull request?")) return;
            api("/api/pr/draft", { isDraft: toDraft });
        });
    }
    for (const btn of document.querySelectorAll("[data-autocomplete]")) {
        btn.addEventListener("click", () => {
            const enable = btn.dataset.autocomplete === "on";
            if (!confirm(enable ? "Set auto-complete on this pull request?" : "Cancel auto-complete on this pull request?")) return;
            api("/api/pr/auto-complete", { enable });
        });
    }
    document.querySelector("[data-external]")?.addEventListener("click", () => api("/api/pr/open-external", {}));

    for (const input of document.querySelectorAll("[data-reply-input]")) {
        input.addEventListener("input", (e) => {
            ui.drafts[input.dataset.replyInput] = e.target.value;
        });
    }
    for (const btn of document.querySelectorAll("[data-reply]")) {
        btn.addEventListener("click", () => {
            const threadId = Number(btn.dataset.reply);
            const content = (ui.drafts[threadId] || "").trim();
            if (!content) return;
            ui.drafts[threadId] = "";
            api("/api/pr/comment", { threadId, content });
        });
    }
    for (const btn of document.querySelectorAll("[data-thread-status]")) {
        btn.addEventListener("click", () => api("/api/pr/thread-status", { threadId: Number(btn.dataset.threadStatus), status: btn.dataset.next }));
    }
    for (const head of document.querySelectorAll("[data-file]")) {
        head.addEventListener("click", () => {
            const path = head.dataset.file;
            if (ui.openDiffs.has(path)) {
                ui.openDiffs.delete(path);
                render();
                return;
            }
            ui.openDiffs.add(path);
            render();
            loadDiff(path);
        });
    }
    const diffAll = document.querySelector("[data-diff-all]");
    diffAll?.addEventListener("click", () => {
        const paths = (state.selected?.changes || []).map((c) => c.path);
        if (diffAll.dataset.diffAll === "collapse") {
            ui.openDiffs = new Set();
            render();
            return;
        }
        ui.openDiffs = new Set(paths);
        render();
        for (const path of paths) loadDiff(path);
    });

    const newComment = document.getElementById("newComment");
    newComment?.addEventListener("input", (e) => {
        ui.newComment = e.target.value;
    });
    document.querySelector("[data-newcomment]")?.addEventListener("click", () => {
        const content = ui.newComment.trim();
        if (!content) return;
        ui.newComment = "";
        api("/api/pr/comment", { content });
    });
}

function wireRows() {
    for (const row of document.querySelectorAll(".pr")) {
        row.addEventListener("click", () => {
            ui.tab = "overview";
            api("/api/pr/select", {
                pullRequestId: Number(row.dataset.pr),
                repositoryId: row.dataset.repo,
                project: row.dataset.project,
            });
        });
    }
}

/* ---------------- boot ---------------- */

const source = new EventSource("./events");
source.addEventListener("state", (event) => {
    applyState(JSON.parse(event.data));
    render();
});
source.addEventListener("error", () => {
    /* EventSource retries on its own */
});

api("/api/state");
setInterval(() => {
    // keep relative timestamps honest without a server round-trip
    if (state && !ui.busy) render();
}, 30000);
