// Azure DevOps REST client.
//
// Auth uses a Personal Access Token read from the environment. The token is
// never written to disk, never logged, and never returned to the iframe or the
// agent. Only a boolean "is it configured" flag ever leaves this module.

import { execFileSync } from "node:child_process";

const PAT_ENV_VARS = ["AZURE_DEVOPS_PAT", "AZDO_PAT", "SYSTEM_ACCESSTOKEN"];

export const DEFAULT_ORG = "";

export const PAT_SETUP_MESSAGE = [
    "No Azure DevOps Personal Access Token found.",
    "Set one of AZURE_DEVOPS_PAT, AZDO_PAT or SYSTEM_ACCESSTOKEN, then restart the app.",
    "PowerShell:  $env:AZURE_DEVOPS_PAT = '<pat>'",
    "Required PAT scopes: Code (read & write), Work Items (read).",
].join(" ");

// Extension processes inherit the environment the app was launched with, so a
// variable set after launch is invisible to process.env. On Windows we can read
// the user's persisted environment directly, which lets a freshly-set PAT work
// without restarting the app. Held in memory only - never written to disk.
let registryPat = { value: undefined, checkedAt: 0 };
const REGISTRY_TTL_MS = 30_000;

function readWindowsUserEnvPat() {
    if (process.platform !== "win32") return undefined;
    if (registryPat.value) return registryPat.value;
    if (Date.now() - registryPat.checkedAt < REGISTRY_TTL_MS) return undefined;
    registryPat.checkedAt = Date.now();
    for (const name of PAT_ENV_VARS) {
        try {
            const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
            });
            const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/.exec(out);
            const value = match?.[1]?.trim();
            if (value) {
                registryPat = { value, checkedAt: Date.now() };
                return value;
            }
        } catch {
            /* variable not present at user scope */
        }
    }
    return undefined;
}

/** @returns {string | undefined} the PAT, or undefined when none is configured. */
export function readPat() {
    for (const name of PAT_ENV_VARS) {
        const value = process.env[name];
        if (value && value.trim()) return value.trim();
    }
    return readWindowsUserEnvPat();
}

export function patEnvVarName() {
    for (const name of PAT_ENV_VARS) {
        const value = process.env[name];
        if (value && value.trim()) return name;
    }
    return readWindowsUserEnvPat() ? "AZURE_DEVOPS_PAT (user environment)" : undefined;
}

export function hasPat() {
    return readPat() !== undefined;
}

export class AdoError extends Error {
    constructor(message, { status = 0, url = "", detail = "" } = {}) {
        super(message);
        this.name = "AdoError";
        this.status = status;
        this.url = url;
        this.detail = detail;
    }
}

function authHeader(pat) {
    return `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`;
}

function friendlyStatus(status, serverMessage) {
    if (status === 401 || status === 403) {
        return `Azure DevOps rejected the request (${status}) - check your PAT scopes: Code (read & write), Work Items (read).`;
    }
    if (status === 404) return `Not found (404). ${serverMessage || ""}`.trim();
    if (status === 203) {
        // ADO returns a sign-in HTML page with 203 when auth fails on some routes.
        return "Azure DevOps returned a sign-in redirect - the PAT is invalid or expired.";
    }
    return serverMessage || `Azure DevOps request failed with status ${status}.`;
}

export class AdoClient {
    /**
     * @param {{ org?: string, log?: (msg: string) => void }} [options]
     */
    constructor(options = {}) {
        this.org = options.org || DEFAULT_ORG;
        this.log = options.log || (() => {});
        this._identity = undefined;
    }

    get baseUrl() {
        return `https://dev.azure.com/${encodeURIComponent(this.org)}`;
    }

    get configured() {
        return hasPat();
    }

    /**
     * @param {string} path path relative to the org base url, starting with "/"
     * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown,
     *           apiVersion?: string, base?: string, contentType?: string }} [options]
     */
    async request(path, options = {}) {
        const pat = readPat();
        if (!pat) throw new AdoError(PAT_SETUP_MESSAGE, { status: 0 });

        const base = options.base || this.baseUrl;
        const url = new URL(`${base}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value === undefined || value === null || value === "") continue;
            url.searchParams.set(key, String(value));
        }
        url.searchParams.set("api-version", options.apiVersion || "7.1");

        const headers = {
            Authorization: authHeader(pat),
            Accept: "application/json",
        };
        let body;
        if (options.body !== undefined) {
            headers["Content-Type"] = options.contentType || "application/json";
            body = JSON.stringify(options.body);
        }

        let response;
        try {
            response = await fetch(url, { method: options.method || "GET", headers, body });
        } catch (cause) {
            throw new AdoError(`Network error contacting Azure DevOps: ${cause.message}`, {
                url: url.pathname,
            });
        }

        const text = await response.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            parsed = undefined;
        }

        // ADO answers unauthenticated requests on some routes with a 203 sign-in
        // HTML page rather than a 401, so treat a non-JSON body as a failure too.
        const looksLikeJson = parsed !== undefined;
        if (!response.ok || response.status === 203 || !looksLikeJson) {
            const serverMessage = parsed && typeof parsed.message === "string" ? parsed.message : "";
            if (response.ok && response.status !== 203 && !text.trim()) return undefined;
            throw new AdoError(friendlyStatus(response.status, serverMessage), {
                status: response.status,
                url: url.pathname,
                detail: serverMessage || text.slice(0, 300),
            });
        }
        return parsed;
    }

    /** Identity of the PAT owner; used as the reviewer id when voting. */
    async currentIdentity() {
        if (this._identity) return this._identity;
        const data = await this.request("/_apis/connectionData", {
            query: { connectOptions: "none" },
            apiVersion: "7.1-preview",
        });
        const user = data?.authenticatedUser;
        if (!user?.id) throw new AdoError("Could not resolve the authenticated Azure DevOps identity.");
        this._identity = {
            id: user.id,
            displayName: user.providerDisplayName || user.customDisplayName || user.id,
            uniqueName: user.properties?.Account?.$value || "",
        };
        return this._identity;
    }

    async listProjects() {
        const data = await this.request("/_apis/projects", { query: { $top: 500, stateFilter: "wellFormed" } });
        return (data?.value || [])
            .map((p) => ({ id: p.id, name: p.name, description: p.description || "" }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async listRepositories(project) {
        if (!project) return [];
        const data = await this.request(`/${encodeURIComponent(project)}/_apis/git/repositories`);
        return (data?.value || [])
            .map((r) => ({ id: r.id, name: r.name, defaultBranch: r.defaultBranch || "", webUrl: r.webUrl || "" }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * @param {{ project?: string, repositoryId?: string, status?: string, creatorId?: string,
     *           reviewerId?: string, targetBranch?: string, top?: number }} filters
     */
    async listPullRequests(filters = {}) {
        const status = filters.status && filters.status !== "all" ? filters.status : "all";
        const query = {
            "searchCriteria.status": status,
            "searchCriteria.creatorId": filters.creatorId,
            "searchCriteria.reviewerId": filters.reviewerId,
            "searchCriteria.targetRefName": normalizeRef(filters.targetBranch),
            $top: filters.top || 100,
        };

        let path;
        if (filters.project && filters.repositoryId) {
            path = `/${encodeURIComponent(filters.project)}/_apis/git/repositories/${encodeURIComponent(filters.repositoryId)}/pullrequests`;
        } else if (filters.project) {
            path = `/${encodeURIComponent(filters.project)}/_apis/git/pullrequests`;
        } else {
            path = "/_apis/git/pullrequests";
        }

        const data = await this.request(path, { query });
        return (data?.value || []).map((pr) => summarizePullRequest(pr, this.org));
    }

    async getPullRequest(pullRequestId, { project, repositoryId } = {}) {
        const path = project && repositoryId
            ? `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`
            : `/_apis/git/pullrequests/${pullRequestId}`;
        const pr = await this.request(path);
        return { raw: pr, summary: summarizePullRequest(pr, this.org) };
    }

    /** Repo-scoped path builder used by every per-PR endpoint. */
    _prPath(pr, suffix) {
        const project = pr.project?.id || pr.project || pr.repository?.project?.id;
        const repositoryId = pr.repository?.id || pr.repositoryId;
        return `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pr.pullRequestId}${suffix}`;
    }

    async getCommits(pr) {
        const data = await this.request(this._prPath(pr, "/commits"), { query: { $top: 100 } });
        return (data?.value || []).map((c) => ({
            commitId: c.commitId,
            shortId: (c.commitId || "").slice(0, 8),
            comment: c.comment || "",
            author: c.author?.name || "",
            date: c.author?.date || c.committer?.date || "",
        }));
    }

    async getChanges(pr) {
        const iterations = await this.request(this._prPath(pr, "/iterations"));
        const list = iterations?.value || [];
        if (!list.length) return { iteration: 0, changes: [], commits: {} };
        const latest = list[list.length - 1];
        const data = await this.request(this._prPath(pr, `/iterations/${latest.id}/changes`), {
            query: { $top: 500 },
        });
        const changes = (data?.changeEntries || data?.value || []).map((c) => ({
            path: c.item?.path || c.originalPath || "",
            changeType: c.changeType || "edit",
            isFolder: Boolean(c.item?.isFolder),
        }));
        return {
            iteration: latest.id,
            // Diffing the merge base against the latest source commit is what
            // the ADO web UI shows as "the changes in this PR".
            commits: {
                base: latest.commonRefCommit?.commitId || latest.targetRefCommit?.commitId || "",
                source: latest.sourceRefCommit?.commitId || "",
            },
            changes: changes.filter((c) => c.path && !c.isFolder),
        };
    }

    /**
     * Text content of a file at a specific commit.
     * @returns {Promise<{ content: string } | { missing: true } | { unavailable: string }>}
     */
    async getFileContent(pr, filePath, commitId) {
        if (!commitId) return { missing: true };
        const project = pr.repository?.project?.id || pr.project?.id || pr.project;
        const repositoryId = pr.repository?.id || pr.repositoryId;
        try {
            const data = await this.request(
                `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`,
                {
                    query: {
                        path: filePath,
                        includeContent: true,
                        "versionDescriptor.versionType": "commit",
                        "versionDescriptor.version": commitId,
                    },
                },
            );
            return { content: typeof data?.content === "string" ? data.content : "" };
        } catch (err) {
            if (err instanceof AdoError && err.status === 404) return { missing: true };
            return { unavailable: err.message };
        }
    }

    async getStatuses(pr) {
        const data = await this.request(this._prPath(pr, "/statuses"));
        return (data?.value || []).map((s) => ({
            id: s.id,
            state: s.state || "pending",
            description: s.description || "",
            context: [s.context?.genre, s.context?.name].filter(Boolean).join("/"),
            targetUrl: s.targetUrl || "",
        }));
    }

    async getPolicyEvaluations(pr) {
        const projectId = pr.repository?.project?.id || pr.project?.id;
        if (!projectId) return [];
        const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}`;
        const projectSegment = pr.repository?.project?.name || pr.project?.name || projectId;
        const data = await this.request(`/${encodeURIComponent(projectSegment)}/_apis/policy/evaluations`, {
            query: { artifactId },
            apiVersion: "7.1-preview.1",
        });
        return (data?.value || []).map((e) => ({
            id: e.evaluationId,
            status: e.status,
            displayName: e.configuration?.type?.displayName || "Policy",
            isBlocking: Boolean(e.configuration?.isBlocking),
            description: e.context?.displayName || e.configuration?.settings?.displayName || "",
        }));
    }

    async getThreads(pr) {
        const data = await this.request(this._prPath(pr, "/threads"));
        return (data?.value || [])
            .filter((t) => !t.isDeleted)
            .map((t) => ({
                id: t.id,
                status: t.status || "unknown",
                filePath: t.threadContext?.filePath || "",
                line: t.threadContext?.rightFileStart?.line || t.threadContext?.leftFileStart?.line || 0,
                isSystem: (t.comments || []).every((c) => c.commentType === "system"),
                comments: (t.comments || [])
                    .filter((c) => !c.isDeleted)
                    .map((c) => ({
                        id: c.id,
                        author: c.author?.displayName || "",
                        avatar: c.author?._links?.avatar?.href || "",
                        content: c.content || "",
                        commentType: c.commentType || "text",
                        publishedDate: c.publishedDate || "",
                    })),
            }));
    }

    async vote(pr, voteValue, reviewerId) {
        const id = reviewerId || (await this.currentIdentity()).id;
        return this.request(this._prPath(pr, `/reviewers/${encodeURIComponent(id)}`), {
            method: "PUT",
            body: { vote: voteValue },
        });
    }

    async createThread(pr, content) {
        return this.request(this._prPath(pr, "/threads"), {
            method: "POST",
            body: { comments: [{ parentCommentId: 0, content, commentType: "text" }], status: "active" },
        });
    }

    async replyToThread(pr, threadId, content) {
        return this.request(this._prPath(pr, `/threads/${threadId}/comments`), {
            method: "POST",
            body: { parentCommentId: 1, content, commentType: "text" },
        });
    }

    async setThreadStatus(pr, threadId, status) {
        return this.request(this._prPath(pr, `/threads/${threadId}`), {
            method: "PATCH",
            body: { status },
        });
    }

    /** @param {{ isDraft?: boolean, autoCompleteSetBy?: object, completionOptions?: object }} patch */
    async updatePullRequest(pr, patch) {
        const project = pr.repository?.project?.id || pr.project?.id || pr.project;
        const repositoryId = pr.repository?.id || pr.repositoryId;
        return this.request(
            `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pr.pullRequestId}`,
            { method: "PATCH", body: patch },
        );
    }

    async setAutoComplete(pr, enable) {
        if (!enable) return this.updatePullRequest(pr, { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } });
        const identity = await this.currentIdentity();
        return this.updatePullRequest(pr, {
            autoCompleteSetBy: { id: identity.id },
            completionOptions: { deleteSourceBranch: false, mergeStrategy: "noFastForward" },
        });
    }
}

export function normalizeRef(branch) {
    if (!branch) return undefined;
    return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function shortRef(ref) {
    if (!ref) return "";
    return ref.replace(/^refs\/heads\//, "").replace(/^refs\/pull\//, "pull/");
}

export const VOTE_LABELS = {
    10: "approved",
    5: "approved-with-suggestions",
    0: "no-vote",
    "-5": "waiting-for-author",
    "-10": "rejected",
};

export const VOTE_VALUES = {
    approve: 10,
    approve_with_suggestions: 5,
    reset: 0,
    wait_for_author: -5,
    reject: -10,
};

export function summarizePullRequest(pr, org) {
    const project = pr.repository?.project?.name || pr.repository?.project?.id || "";
    const repo = pr.repository?.name || "";
    return {
        pullRequestId: pr.pullRequestId,
        title: pr.title || "",
        description: pr.description || "",
        status: pr.status || "",
        isDraft: Boolean(pr.isDraft),
        mergeStatus: pr.mergeStatus || "",
        project,
        projectId: pr.repository?.project?.id || "",
        repository: repo,
        repositoryId: pr.repository?.id || "",
        createdBy: {
            displayName: pr.createdBy?.displayName || "",
            uniqueName: pr.createdBy?.uniqueName || "",
            avatar: pr.createdBy?._links?.avatar?.href || pr.createdBy?.imageUrl || "",
            id: pr.createdBy?.id || "",
        },
        sourceBranch: shortRef(pr.sourceRefName),
        targetBranch: shortRef(pr.targetRefName),
        creationDate: pr.creationDate || "",
        closedDate: pr.closedDate || "",
        autoCompleteSetBy: pr.autoCompleteSetBy?.displayName || "",
        reviewers: (pr.reviewers || []).map((r) => ({
            id: r.id,
            displayName: r.displayName || "",
            avatar: r._links?.avatar?.href || r.imageUrl || "",
            vote: r.vote ?? 0,
            voteLabel: VOTE_LABELS[String(r.vote ?? 0)] || "no-vote",
            isRequired: Boolean(r.isRequired),
            isContainer: Boolean(r.isContainer),
        })),
        webUrl: project && repo
            ? `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`
            : "",
    };
}

/** Parse an ADO PR web url into its parts. */
export function parsePullRequestUrl(url) {
    if (!url) return undefined;
    const match = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(url);
    if (!match) return undefined;
    return {
        org: decodeURIComponent(match[1]),
        project: decodeURIComponent(match[2]),
        repository: decodeURIComponent(match[3]),
        pullRequestId: Number(match[4]),
    };
}
