// Extension: ado-pr-dashboard
// Interactive Azure DevOps pull request dashboard canvas.
//
// This file is wiring only. The ADO REST client lives in ado-client.mjs, the
// loopback server + dashboard state machine in server.mjs, the iframe shell in
// renderer.mjs (with styles.css / client.js served as static assets), and
// durable user preferences in store.mjs.

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { DEFAULT_ORG, PAT_SETUP_MESSAGE, VOTE_VALUES, hasPat, parsePullRequestUrl } from "./ado-client.mjs";
import { closeAll, closeInstance, ensureInstance, getInstance } from "./server.mjs";

// stdout is reserved for JSON-RPC; stderr lands in the extension log file.
const log = (message) => process.stderr.write(`[ado-pr-dashboard] ${message}\n`);

/** Resolve the dashboard backing an action invocation. */
function dashboardFor(ctx) {
    const dashboard = getInstance(ctx.instanceId);
    if (!dashboard) throw new CanvasError("canvas_instance_missing", `No open canvas instance "${ctx.instanceId}".`);
    return dashboard;
}

function requirePat() {
    if (!hasPat()) throw new CanvasError("ado_pat_missing", PAT_SETUP_MESSAGE);
}

function compactPr(pr) {
    return {
        pullRequestId: pr.pullRequestId,
        title: pr.title,
        status: pr.status,
        isDraft: pr.isDraft,
        project: pr.project,
        repository: pr.repository,
        author: pr.createdBy.displayName,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        mergeStatus: pr.mergeStatus,
        createdAt: pr.creationDate,
        autoComplete: Boolean(pr.autoCompleteSetBy),
        reviewers: pr.reviewers.map((r) => ({ name: r.displayName, vote: r.voteLabel, required: r.isRequired })),
        url: pr.webUrl,
    };
}

const filterProperties = {
    project: { type: "string", description: "Azure DevOps project name. Omit to search the whole organization." },
    repository: { type: "string", description: "Repository name or id. Requires project." },
    status: { type: "string", enum: ["active", "completed", "abandoned", "all"], description: "Pull request status filter." },
    creator: { type: "string", description: "Creator identity id or descriptor." },
    reviewer: { type: "string", description: "Reviewer identity id or descriptor." },
};

const prLocatorProperties = {
    pullRequestId: { type: "integer", minimum: 1, description: "Azure DevOps pull request id." },
    project: { type: "string", description: "Project name, when the PR is not already loaded in the canvas." },
    repository: { type: "string", description: "Repository name or id, when the PR is not already loaded." },
    url: { type: "string", description: "Full Azure DevOps pull request URL; used instead of pullRequestId." },
};

/** Turn action input into a concrete { pullRequestId, project, repositoryId } reference. */
function resolveRef(dashboard, input) {
    const fromUrl = input.url ? parsePullRequestUrl(input.url) : undefined;
    const pullRequestId = fromUrl?.pullRequestId ?? input.pullRequestId;
    if (!pullRequestId) throw new CanvasError("ado_input_invalid", "Provide either pullRequestId or a pull request url.");

    const repoName = fromUrl?.repository ?? input.repository;
    const known = dashboard.pullRequests.find((pr) => pr.pullRequestId === pullRequestId);
    const repositoryId =
        dashboard.repositories.find((r) => r.id === repoName || r.name === repoName)?.id || known?.repositoryId || undefined;
    const project = fromUrl?.project ?? input.project ?? known?.project ?? dashboard.filters.project;

    return { pullRequestId, project: project || undefined, repositoryId };
}

const canvas = createCanvas({
    id: "ado-pr-dashboard",
    displayName: "Azure DevOps PRs",
    description: "Interactive Azure DevOps pull request dashboard with filtering, review votes, comments and policy status.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            org: { type: "string", description: `Azure DevOps organization. Defaults to "${DEFAULT_ORG}".` },
            project: { type: "string", description: "Project to preselect in the filter bar." },
            repositoryId: { type: "string", description: "Repository id to preselect." },
            status: { type: "string", enum: ["active", "completed", "abandoned", "all"], description: "Initial status filter." },
        },
    },
    actions: [
        {
            name: "list_ado_pull_requests",
            description: "List Azure DevOps pull requests matching optional project/repository/status/creator/reviewer filters.",
            inputSchema: { type: "object", additionalProperties: false, properties: filterProperties },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                const input = ctx.input || {};
                if (input.project) dashboard.filters.project = input.project;
                if (input.status) dashboard.filters.status = input.status;
                if (input.creator !== undefined) dashboard.filters.creator = input.creator;
                if (input.reviewer !== undefined) dashboard.filters.reviewer = input.reviewer;
                if (input.repository) {
                    if (!dashboard.repositories.length && dashboard.filters.project) {
                        dashboard.repositories = await dashboard.client.listRepositories(dashboard.filters.project);
                    }
                    const match = dashboard.repositories.find((r) => r.id === input.repository || r.name === input.repository);
                    if (!match) {
                        throw new CanvasError(
                            "ado_repository_not_found",
                            `Repository "${input.repository}" not found in project "${dashboard.filters.project}".`,
                        );
                    }
                    dashboard.filters.repositoryId = match.id;
                }
                await dashboard.refresh({ reloadLists: false });
                await dashboard.persist();
                if (dashboard.error) throw new CanvasError("ado_request_failed", dashboard.error);
                return {
                    org: dashboard.client.org,
                    filters: dashboard.filters,
                    count: dashboard.pullRequests.length,
                    pullRequests: dashboard.pullRequests.map(compactPr),
                };
            },
        },
        {
            name: "show_ado_pr_detail",
            description: "Focus a pull request in the canvas and return its description, commits, changed files, checks and threads.",
            inputSchema: { type: "object", additionalProperties: false, properties: prLocatorProperties },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                const ref = resolveRef(dashboard, ctx.input || {});
                await dashboard.select(ref);
                if (!dashboard.selected) throw new CanvasError("ado_request_failed", dashboard.error || "Could not load the pull request.");
                const d = dashboard.selected;
                return {
                    pullRequest: compactPr(d.summary),
                    description: d.summary.description,
                    commits: d.commits.map((c) => ({ id: c.shortId, message: c.comment.split("\n")[0], author: c.author, date: c.date })),
                    changedFiles: d.changes.map((c) => ({ path: c.path, changeType: c.changeType })),
                    checks: [
                        ...d.policies.map((p) => ({ kind: "policy", name: p.displayName, status: p.status, blocking: p.isBlocking })),
                        ...d.statuses.map((s) => ({ kind: "status", name: s.context, status: s.state, description: s.description })),
                    ],
                    threads: d.threads
                        .filter((t) => !t.isSystem)
                        .map((t) => ({
                            threadId: t.id,
                            status: t.status,
                            filePath: t.filePath,
                            comments: t.comments.map((c) => ({ author: c.author, content: c.content, date: c.publishedDate })),
                        })),
                };
            },
        },
        {
            name: "show_ado_pr_file_diff",
            description: "Focus a pull request in the canvas and return the unified diff of one of its changed files.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: { ...prLocatorProperties, path: { type: "string", description: "Repository-relative path of the changed file." } },
            },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                const input = ctx.input || {};
                const ref = resolveRef(dashboard, input);
                if (!dashboard.selected || dashboard.selected.summary.pullRequestId !== ref.pullRequestId) {
                    await dashboard.select(ref);
                }
                if (!dashboard.selected) throw new CanvasError("ado_request_failed", dashboard.error || "Could not load the pull request.");
                try {
                    const diff = await dashboard.fileDiff(input.path);
                    return {
                        pullRequestId: dashboard.selected.summary.pullRequestId,
                        ...diff,
                        hunks: (diff.hunks || []).map((h) => ({
                            oldStart: h.oldStart,
                            newStart: h.newStart,
                            text: h.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n"),
                        })),
                    };
                } catch (error) {
                    throw new CanvasError("ado_diff_failed", error.message);
                }
            },
        },
        {
            name: "vote_on_ado_pull_request",
            description: "Cast the authenticated user's review vote on a pull request.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["vote"],
                properties: {
                    ...prLocatorProperties,
                    vote: { type: "string", enum: Object.keys(VOTE_VALUES), description: "Vote to cast." },
                },
            },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                const input = ctx.input || {};
                const ref = resolveRef(dashboard, input);
                if (dashboard.selected?.summary?.pullRequestId !== ref.pullRequestId) await dashboard.select(ref);
                if (!dashboard.selected) throw new CanvasError("ado_request_failed", dashboard.error || "Could not load the pull request.");
                try {
                    await dashboard.vote(input.vote);
                } catch (err) {
                    throw new CanvasError("ado_vote_failed", err.message);
                }
                dashboard.broadcast();
                return {
                    pullRequestId: ref.pullRequestId,
                    vote: input.vote,
                    reviewers: dashboard.selected.summary.reviewers.map((r) => ({ name: r.displayName, vote: r.voteLabel })),
                };
            },
        },
        {
            name: "comment_on_ado_pull_request",
            description: "Add a new comment thread on a pull request, or reply to an existing thread.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["content"],
                properties: {
                    ...prLocatorProperties,
                    content: { type: "string", minLength: 1, description: "Comment body (markdown)." },
                    threadId: { type: "integer", minimum: 1, description: "Existing thread to reply to. Omit to start a new thread." },
                },
            },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                const input = ctx.input || {};
                const ref = resolveRef(dashboard, input);
                if (dashboard.selected?.summary?.pullRequestId !== ref.pullRequestId) await dashboard.select(ref);
                if (!dashboard.selected) throw new CanvasError("ado_request_failed", dashboard.error || "Could not load the pull request.");
                try {
                    await dashboard.comment(input.content, input.threadId);
                } catch (err) {
                    throw new CanvasError("ado_comment_failed", err.message);
                }
                dashboard.broadcast();
                return {
                    pullRequestId: ref.pullRequestId,
                    threadId: input.threadId ?? null,
                    threadCount: dashboard.selected.threads.filter((t) => !t.isSystem).length,
                };
            },
        },
        {
            name: "refresh_ado_pull_requests",
            description: "Re-fetch pull requests from Azure DevOps and push the update to the open canvas.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const dashboard = dashboardFor(ctx);
                requirePat();
                await dashboard.refresh();
                if (dashboard.error) throw new CanvasError("ado_request_failed", dashboard.error);
                return { count: dashboard.pullRequests.length, lastUpdated: dashboard.lastUpdated, filters: dashboard.filters };
            },
        },
    ],
    // Idempotent: re-invoked with reason "rehydrate" after a reload. Durable
    // preferences are reloaded from $COPILOT_HOME, never keyed by instanceId.
    open: async (ctx) => {
        const dashboard = await ensureInstance(ctx.instanceId, ctx.input || {}, log);
        return {
            title: `Azure DevOps PRs · ${dashboard.client.org}`,
            status: hasPat() ? undefined : "PAT not configured",
            url: dashboard.url,
        };
    },
    onClose: async (ctx) => {
        await closeInstance(ctx.instanceId);
    },
});

const session = await joinSession({ canvases: [canvas] });

if (!hasPat()) {
    await session
        .log(`Azure DevOps PR dashboard: ${PAT_SETUP_MESSAGE}`, { level: "warning", ephemeral: true })
        .catch(() => {});
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        closeAll().finally(() => process.exit(0));
    });
}
