// Durable, user-global preference storage.
//
// Preferences follow the user across sessions and panels, so they live under
// $COPILOT_HOME/extensions/ado-pr-dashboard/artifacts/ (never in the repo, and
// never keyed by instanceId).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const EXTENSION_NAME = "ado-pr-dashboard";

export function artifactsDir() {
    const home = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
    return path.join(home, "extensions", EXTENSION_NAME, "artifacts");
}

export function prefsPath() {
    return path.join(artifactsDir(), "preferences.json");
}

export const DEFAULT_PREFS = {
    org: "",
    project: "",
    repositoryId: "",
    repositoryName: "",
    status: "active",
    creator: "",
    reviewer: "",
    targetBranch: "",
    titleFilter: "",
    presets: [],
};

let cache;

export async function loadPrefs() {
    if (cache) return { ...cache };
    try {
        const raw = await readFile(prefsPath(), "utf8");
        const parsed = JSON.parse(raw);
        cache = { ...DEFAULT_PREFS, ...parsed, presets: Array.isArray(parsed.presets) ? parsed.presets : [] };
    } catch {
        cache = { ...DEFAULT_PREFS };
    }
    return { ...cache };
}

export async function savePrefs(patch) {
    const current = await loadPrefs();
    const next = { ...current, ...patch };
    // Preferences must never carry secrets.
    delete next.pat;
    delete next.token;
    cache = next;
    await mkdir(artifactsDir(), { recursive: true });
    await writeFile(prefsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { ...next };
}

export async function savePreset(name, filters) {
    const prefs = await loadPrefs();
    const presets = prefs.presets.filter((p) => p.name !== name);
    presets.push({ name, filters });
    return savePrefs({ presets });
}

export async function deletePreset(name) {
    const prefs = await loadPrefs();
    return savePrefs({ presets: prefs.presets.filter((p) => p.name !== name) });
}
