// Minimal dependency-free line differ producing unified-diff style hunks.
//
// Trims the common prefix/suffix first, then runs an LCS over what's left, so
// typical PR files stay cheap. Anything past the size guard is reported as
// too large rather than blocking the event loop.

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text) {
    if (!text) return [];
    const normalized = text.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    // A trailing newline yields an empty final element that isn't a real line.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

export function looksBinary(text) {
    if (!text) return false;
    const sample = text.slice(0, 8000);
    if (sample.includes("\u0000")) return true;
    let control = 0;
    for (let i = 0; i < sample.length; i += 1) {
        const code = sample.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13) continue;
        if (code < 32 || code === 65533) control += 1;
    }
    return control / Math.max(sample.length, 1) > 0.02;
}

/** Longest-common-subsequence backtrack over the trimmed middle sections. */
function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] =
                a[i] === b[j]
                    ? table[(i + 1) * width + (j + 1)] + 1
                    : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ type: "ctx", text: a[i] });
            i += 1;
            j += 1;
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
            ops.push({ type: "del", text: a[i] });
            i += 1;
        } else {
            ops.push({ type: "add", text: b[j] });
            j += 1;
        }
    }
    while (i < n) ops.push({ type: "del", text: a[i++] });
    while (j < m) ops.push({ type: "add", text: b[j++] });
    return ops;
}

/**
 * @param {string} oldText
 * @param {string} newText
 * @param {{ context?: number }} [options]
 * @returns {{ hunks: Array, additions: number, deletions: number, tooLarge?: boolean, identical?: boolean }}
 */
export function diffLines(oldText, newText, options = {}) {
    const context = options.context ?? 3;
    const a = splitLines(oldText);
    const b = splitLines(newText);

    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const midA = a.slice(prefix, a.length - suffix);
    const midB = b.slice(prefix, b.length - suffix);
    if (!midA.length && !midB.length) return { hunks: [], additions: 0, deletions: 0, identical: true };
    if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
        return { hunks: [], additions: midB.length, deletions: midA.length, tooLarge: true };
    }

    const ops = [
        ...a.slice(0, prefix).map((text) => ({ type: "ctx", text })),
        ...lcsOps(midA, midB),
        ...a.slice(a.length - suffix).map((text) => ({ type: "ctx", text })),
    ];

    // Number the lines, then keep only changes plus `context` lines around them.
    let oldNo = 0;
    let newNo = 0;
    const numbered = ops.map((op) => {
        if (op.type === "add") return { ...op, oldNo: null, newNo: ++newNo };
        if (op.type === "del") return { ...op, oldNo: ++oldNo, newNo: null };
        return { ...op, oldNo: ++oldNo, newNo: ++newNo };
    });

    const keep = new Array(numbered.length).fill(false);
    numbered.forEach((op, index) => {
        if (op.type === "ctx") return;
        for (let k = Math.max(0, index - context); k <= Math.min(numbered.length - 1, index + context); k += 1) {
            keep[k] = true;
        }
    });

    const hunks = [];
    let current = null;
    numbered.forEach((op, index) => {
        if (!keep[index]) {
            current = null;
            return;
        }
        if (!current) {
            current = { oldStart: op.oldNo ?? oldNoBefore(numbered, index), newStart: op.newNo ?? newNoBefore(numbered, index), lines: [] };
            hunks.push(current);
        }
        current.lines.push(op);
    });

    return {
        hunks,
        additions: numbered.filter((op) => op.type === "add").length,
        deletions: numbered.filter((op) => op.type === "del").length,
    };
}

function oldNoBefore(list, index) {
    for (let i = index; i >= 0; i -= 1) if (list[i].oldNo != null) return list[i].oldNo;
    return 1;
}

function newNoBefore(list, index) {
    for (let i = index; i >= 0; i -= 1) if (list[i].newNo != null) return list[i].newNo;
    return 1;
}
