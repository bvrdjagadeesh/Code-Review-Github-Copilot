// Per-instance loopback HTTP server + dashboard state machine.
//
// Each open canvas instance gets its own http.Server bound to 127.0.0.1:0.
// The server serves the iframe shell/assets, JSON endpoints the iframe POSTs
// to, an SSE stream at /events, and an authenticated avatar proxy.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AdoClient, AdoError, PAT_SETUP_MESSAGE, VOTE_VALUES, hasPat, patEnvVarName, readPat } from "./ado-client.mjs";
import { diffLines, looksBinary } from "./diff.mjs";
import { renderHtml } from "./renderer.mjs";
import { loadPrefs, savePrefs } from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFRESH_MS = 60_000;

/** instanceId -> Dashboard */
const instances = new Map();

export function getInstance(instanceId) {
    return instances.get(instanceId);
}

export function anyInstance() {
    return instances.values().next().value;
}

export function listInstances() {
    return [...instances.values()];
}

class Dashboard {
    constructor(instanceId, log) {
        this.instanceId = instanceId;
        this.log = log;
        this.clients = new Set();
        this.timer = undefined;
        this.client = new AdoClient({ log });
        this.filters = { project: "", repositoryId: "", status: "active", creator: "", reviewer: "", targetBranch: "", titleFilter: "" };
        this.projects = [];
        this.repositories = [];
        this.pullRequests = [];
        this.selected = null;
        this.identity = null;
        this.loading = false;
        this.detailLoading = false;
        this.error = null;
        this.lastUpdated = "";
        this.diffCache = new Map();
        this.diffCommitKey = "";
    }

    snapshot() {
        return {
            config: { org: this.client.org, patConfigured: hasPat(), patEnvVar: patEnvVarName() || "" },
            filters: this.filters,
            projects: this.projects,
            repositories: this.repositories,
            pullRequests: this.pullRequests,
            selected: this.selected,
            identity: this.identity,
            loading: this.loading,
            detailLoading: this.detailLoading,
            error: this.error,
            lastUpdated: this.lastUpdated,
            autoRefresh: true,
        };
    }

    broadcast() {
        const payload = `event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
        for (const res of this.clients) {
            try {
                res.write(payload);
            } catch {
                this.clients.delete(res);
            }
        }
    }

    fail(err) {
        this.error = err instanceof AdoError || err instanceof Error ? err.message : String(err);
        this.log(`error: ${this.error}`);
    }

    /** Restore durable, user-global preferences. Safe to call repeatedly. */
    async hydrate(input = {}) {
        const prefs = await loadPrefs();
        if (prefs.org) this.client.org = prefs.org;
        this.filters = {
            project: input.project ?? prefs.project ?? "",
            repositoryId: input.repositoryId ?? prefs.repositoryId ?? "",
            status: input.status ?? prefs.status ?? "active",
            creator: prefs.creator ?? "",
            reviewer: prefs.reviewer ?? "",
            targetBranch: prefs.targetBranch ?? "",
            titleFilter: prefs.titleFilter ?? "",
        };
        if (input.org) this.client.org = input.org;
    }

    async persist() {
        await savePrefs({
            org: this.client.org,
            project: this.filters.project,
            repositoryId: this.filters.repositoryId,
            repositoryName: this.repositories.find((r) => r.id === this.filters.repositoryId)?.name || "",
            status: this.filters.status,
            creator: this.filters.creator,
            reviewer: this.filters.reviewer,
            targetBranch: this.filters.targetBranch,
            titleFilter: this.filters.titleFilter,
        });
    }

    async refresh({ reloadLists = true } = {}) {
        if (!hasPat()) {
            this.error = PAT_SETUP_MESSAGE;
            this.broadcast();
            return;
        }
        this.loading = true;
        this.error = null;
        this.broadcast();
        try {
            if (!this.identity) {
                this.identity = await this.client.currentIdentity().catch(() => null);
            }
            if (reloadLists || !this.projects.length) {
                this.projects = await this.client.listProjects();
            }
            if (this.filters.project) {
                this.repositories = await this.client.listRepositories(this.filters.project);
                if (this.filters.repositoryId && !this.repositories.some((r) => r.id === this.filters.repositoryId)) {
                    this.filters.repositoryId = "";
                }
            } else {
                this.repositories = [];
                this.filters.repositoryId = "";
            }
            this.pullRequests = await this.client.listPullRequests({
                project: this.filters.project,
                repositoryId: this.filters.repositoryId,
                status: this.filters.status,
                creatorId: this.filters.creator || undefined,
                reviewerId: this.filters.reviewer || undefined,
                targetBranch: this.filters.targetBranch || undefined,
            });
            this.lastUpdated = new Date().toISOString();
            if (this.selected) await this.loadDetail(this.selected.summary, { silent: true });
        } catch (err) {
            this.fail(err);
        } finally {
            this.loading = false;
            this.broadcast();
        }
    }

    /** @param {{pullRequestId:number, project?:string, repositoryId?:string}} ref */
    async select(ref) {
        this.detailLoading = true;
        this.error = null;
        this.broadcast();
        try {
            const { raw } = await this.client.getPullRequest(ref.pullRequestId, {
                project: ref.project,
                repositoryId: ref.repositoryId,
            });
            await this.loadDetail(raw, { silent: true });
        } catch (err) {
            this.fail(err);
            this.selected = null;
        } finally {
            this.detailLoading = false;
            this.broadcast();
        }
    }

    /** Load every detail panel for a PR. `pr` may be a raw PR or a summary. */
    async loadDetail(pr, { silent = false } = {}) {
        const ref = {
            pullRequestId: pr.pullRequestId,
            project: pr.repository?.project?.id || pr.projectId || pr.project,
            repositoryId: pr.repository?.id || pr.repositoryId,
        };
        const { raw, summary } = await this.client.getPullRequest(ref.pullRequestId, {
            project: ref.project,
            repositoryId: ref.repositoryId,
        });
        const [commits, changes, statuses, policies, threads] = await Promise.all([
            this.client.getCommits(raw).catch(() => []),
            this.client.getChanges(raw).catch(() => ({ changes: [], commits: {} })),
            this.client.getStatuses(raw).catch(() => []),
            this.client.getPolicyEvaluations(raw).catch(() => []),
            this.client.getThreads(raw).catch(() => []),
        ]);
        const diffCommits = changes.commits || {};
        // Drop cached diffs when the source commit moved (new push).
        if (this.diffCommitKey !== `${ref.pullRequestId}:${diffCommits.source}`) {
            this.diffCommitKey = `${ref.pullRequestId}:${diffCommits.source}`;
            this.diffCache = new Map();
        }
        this.selected = {
            summary,
            raw,
            commits,
            changes: changes.changes || [],
            diffCommits,
            statuses,
            policies,
            threads,
        };
        if (!silent) this.broadcast();
        return this.selected;
    }

    /** Unified diff for one changed file in the selected PR. Cached per source commit. */
    async fileDiff(filePath) {
        const selected = this.selected;
        if (!selected) throw new AdoError("No pull request is selected.");
        const entry = selected.changes.find((c) => c.path === filePath);
        if (!entry) throw new AdoError(`"${filePath}" is not part of this pull request.`);

        const cached = this.diffCache.get(filePath);
        if (cached) return cached;

        const changeType = String(entry.changeType || "edit").toLowerCase();
        const { base, source } = selected.diffCommits || {};
        const [oldSide, newSide] = await Promise.all([
            changeType.includes("add") ? { missing: true } : this.client.getFileContent(selected.raw, filePath, base),
            changeType.includes("delete") ? { missing: true } : this.client.getFileContent(selected.raw, filePath, source),
        ]);

        const unavailable = oldSide.unavailable || newSide.unavailable;
        let result;
        if (unavailable) {
            result = { path: filePath, changeType, unavailable };
        } else if (looksBinary(oldSide.content) || looksBinary(newSide.content)) {
            result = { path: filePath, changeType, binary: true };
        } else {
            result = { path: filePath, changeType, ...diffLines(oldSide.content || "", newSide.content || "") };
        }
        this.diffCache.set(filePath, result);
        return result;
    }

    requireSelection() {
        if (!this.selected) throw new AdoError("No pull request is selected.");
        return this.selected.raw;
    }

    async vote(voteKey) {
        const value = VOTE_VALUES[voteKey];
        if (value === undefined) throw new AdoError(`Unknown vote "${voteKey}".`);
        const raw = this.requireSelection();
        await this.client.vote(raw, value);
        await this.loadDetail(raw, { silent: true });
        await this.refreshListOnly();
    }

    async comment(content, threadId) {
        const raw = this.requireSelection();
        if (threadId) await this.client.replyToThread(raw, threadId, content);
        else await this.client.createThread(raw, content);
        await this.loadDetail(raw, { silent: true });
    }

    async threadStatus(threadId, status) {
        const raw = this.requireSelection();
        await this.client.setThreadStatus(raw, threadId, status);
        await this.loadDetail(raw, { silent: true });
    }

    async setDraft(isDraft) {
        const raw = this.requireSelection();
        await this.client.updatePullRequest(raw, { isDraft });
        await this.loadDetail(raw, { silent: true });
        await this.refreshListOnly();
    }

    async setAutoComplete(enable) {
        const raw = this.requireSelection();
        await this.client.setAutoComplete(raw, enable);
        await this.loadDetail(raw, { silent: true });
        await this.refreshListOnly();
    }

    async refreshListOnly() {
        this.pullRequests = await this.client
            .listPullRequests({
                project: this.filters.project,
                repositoryId: this.filters.repositoryId,
                status: this.filters.status,
                creatorId: this.filters.creator || undefined,
                reviewerId: this.filters.reviewer || undefined,
                targetBranch: this.filters.targetBranch || undefined,
            })
            .catch(() => this.pullRequests);
        this.lastUpdated = new Date().toISOString();
    }

    startPolling() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.refresh({ reloadLists: false }).catch((err) => this.fail(err));
        }, REFRESH_MS);
        this.timer.unref?.();
    }

    async close() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        for (const res of this.clients) {
            try {
                res.end();
            } catch {
                /* already gone */
            }
        }
        this.clients.clear();
        if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    }
}

/* ---------------- http plumbing ---------------- */

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(payload);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return {};
    }
}

function openExternal(url) {
    if (!url) return;
    if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
}

async function serveAsset(res, file, contentType) {
    try {
        const body = await readFile(path.join(HERE, file), "utf8");
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        res.end(body);
    } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Failed to read ${file}: ${err.message}`);
    }
}

/** Avatar images need the PAT, so proxy them instead of exposing the token. */
async function proxyAvatar(res, rawUrl) {
    const pat = readPat();
    if (!pat || !rawUrl) {
        res.writeHead(404).end();
        return;
    }
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        res.writeHead(400).end();
        return;
    }
    const host = target.hostname.toLowerCase();
    const allowed = host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com");
    if (!allowed) {
        res.writeHead(400).end();
        return;
    }
    try {
        const upstream = await fetch(target, {
            headers: { Authorization: `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}` },
        });
        if (!upstream.ok) {
            res.writeHead(upstream.status).end();
            return;
        }
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
            "Content-Type": upstream.headers.get("content-type") || "image/png",
            "Cache-Control": "private, max-age=600",
        });
        res.end(buffer);
    } catch {
        res.writeHead(502).end();
    }
}

function handleSse(dashboard, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(dashboard.snapshot())}\n\n`);
    dashboard.clients.add(res);
    res.on("close", () => dashboard.clients.delete(res));
}

async function handleApi(dashboard, url, req, res) {
    const route = url.pathname;
    if (route === "/api/state") {
        return json(res, 200, { state: dashboard.snapshot() });
    }

    const body = await readBody(req);
    dashboard.error = null;
    try {
        switch (route) {
            case "/api/refresh":
                await dashboard.refresh();
                break;
            case "/api/filters": {
                const { noRefetch, ...patch } = body;
                Object.assign(dashboard.filters, patch);
                if (patch.project !== undefined) dashboard.selected = null;
                await dashboard.persist();
                if (!noRefetch) await dashboard.refresh({ reloadLists: false });
                break;
            }
            case "/api/pr/select":
                await dashboard.select(body);
                break;
            case "/api/pr/vote":
                await dashboard.vote(body.vote);
                break;
            case "/api/pr/comment":
                if (!body.content || !String(body.content).trim()) throw new AdoError("Comment content is required.");
                await dashboard.comment(String(body.content), body.threadId);
                break;
            case "/api/pr/thread-status":
                await dashboard.threadStatus(body.threadId, body.status);
                break;
            case "/api/pr/draft":
                await dashboard.setDraft(Boolean(body.isDraft));
                break;
            case "/api/pr/auto-complete":
                await dashboard.setAutoComplete(Boolean(body.enable));
                break;
            case "/api/pr/diff": {
                const diff = await dashboard.fileDiff(String(body.path || ""));
                return json(res, 200, { diff });
            }
            case "/api/pr/open-external":
                openExternal(dashboard.selected?.summary?.webUrl);
                break;
            default:
                return json(res, 404, { error: "Unknown endpoint" });
        }
        dashboard.broadcast();
        return json(res, 200, { state: dashboard.snapshot(), error: dashboard.error });
    } catch (err) {
        dashboard.fail(err);
        dashboard.broadcast();
        return json(res, 200, { state: dashboard.snapshot(), error: dashboard.error });
    }
}

/**
 * Create (or reuse) the dashboard + loopback server for a canvas instance.
 * Idempotent: repeat opens for the same instanceId reuse the running server.
 */
export async function ensureInstance(instanceId, input, log) {
    let dashboard = instances.get(instanceId);
    if (dashboard) {
        await dashboard.hydrate(input);
        dashboard.refresh().catch((err) => dashboard.fail(err));
        return dashboard;
    }

    dashboard = new Dashboard(instanceId, log);
    await dashboard.hydrate(input);

    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/events") return handleSse(dashboard, res);
        if (url.pathname === "/avatar") return void proxyAvatar(res, url.searchParams.get("url"));
        if (url.pathname.startsWith("/api/")) return void handleApi(dashboard, url, req, res).catch(() => json(res, 500, { error: "Internal error" }));
        if (url.pathname === "/app.css") return void serveAsset(res, "styles.css", "text/css; charset=utf-8");
        if (url.pathname === "/app.js") return void serveAsset(res, "client.js", "text/javascript; charset=utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderHtml());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    dashboard.server = server;
    dashboard.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

    instances.set(instanceId, dashboard);
    dashboard.startPolling();
    dashboard.refresh().catch((err) => dashboard.fail(err));
    return dashboard;
}

export async function closeInstance(instanceId) {
    const dashboard = instances.get(instanceId);
    if (!dashboard) return;
    instances.delete(instanceId);
    await dashboard.close();
}

export async function closeAll() {
    await Promise.all([...instances.keys()].map(closeInstance));
}
