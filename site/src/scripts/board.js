// The contributor board: people whose feedback shipped, read from the public board
// endpoint. The rows are built in lib/board.mjs, which only ever sets text.
import { buildRow, versionsOf } from "../lib/board.mjs";

const API = (import.meta.env.PUBLIC_FEEDBACK_API || "https://crash.reasonix.io").replace(/\/$/, "");
const el = (id) => document.getElementById(id);

class NotOpen extends Error {}

async function read(release) {
  const res = await fetch(`${API}/v1/feedback/board${release ? `?release=${encodeURIComponent(release)}` : ""}`);
  if (res.status === 404) throw new NotOpen();
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

let filled = false;

function fillVersions(entries) {
  if (filled) return;
  filled = true;
  const select = el("board-release");
  for (const v of versionsOf(entries)) {
    const option = document.createElement("option");
    option.value = v;
    option.textContent = v;
    select.append(option);
  }
}

async function show(release) {
  const list = el("board-list");
  el("board-error").hidden = true;
  el("board-off").hidden = true;
  try {
    const board = await read(release);
    if (!release) fillVersions(board.entries);
    const ranked = board.view === "release";
    list.replaceChildren(...board.entries.map((e) => buildRow(e, ranked, document)));
    if (ranked) list.dataset.ranked = "";
    else delete list.dataset.ranked;
    el("board-empty").hidden = board.entries.length > 0;
  } catch (err) {
    list.replaceChildren();
    el("board-empty").hidden = true;
    (err instanceof NotOpen ? el("board-off") : el("board-error")).hidden = false;
  }
}

el("board-release").addEventListener("change", (e) => void show(e.target.value));
void show("");
