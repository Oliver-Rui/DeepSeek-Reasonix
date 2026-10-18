// The contributor board's pure parts: what a name may look like on the page, and the
// rows built from the public answer. Names come from users, so every one is cleaned
// and set as text; nothing here makes markup.

export const NAME_LIMIT = 60;

// Bidirectional controls and other invisible formatting characters can make a name
// read as something else (a right-to-left override flips what follows it), so none
// reaches the page.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/gu;

export function cleanName(raw) {
  const text = String(raw ?? "").normalize("NFKC").replace(/[\t\n\r]+/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > NAME_LIMIT ? chars.slice(0, NAME_LIMIT - 1).join("") + "…" : text;
}

export function newestFirst(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}

export function versionsOf(entries) {
  return [...new Set(entries.flatMap((e) => e.releases.map((r) => r.version)))].sort(newestFirst);
}

// One row as plain parts, whatever the document is: the caller sets each as text.
export function rowOf(entry, ranked) {
  return {
    rank: ranked ? String(entry.rank ?? "") : null,
    name: cleanName(entry.displayName),
    credits: Number.isFinite(entry.credits) ? entry.credits : 0,
    chips: ranked ? [] : (entry.releases ?? []).slice(0, 3).map((r) => (r.count > 1 ? `${r.version} ×${r.count}` : r.version)),
  };
}

// buildRow draws a row with the given document. It writes only through
// textContent, so a name can never become markup.
export function buildRow(entry, ranked, doc) {
  const row = rowOf(entry, ranked);
  const li = doc.createElement("li");
  const part = (cls, text) => {
    const el = doc.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  if (row.rank !== null) li.append(part("board-rank", row.rank));
  li.append(part("board-name", row.name));
  const credits = doc.createElement("span");
  credits.className = "board-credits";
  credits.append(part("l-en", `${row.credits} adopted`), part("l-zh", `${row.credits} 条被采纳`));
  li.append(credits);
  if (!ranked) {
    const where = doc.createElement("span");
    where.className = "board-where";
    for (const chip of row.chips) where.append(part("board-chip", chip));
    li.append(where);
  }
  return li;
}
