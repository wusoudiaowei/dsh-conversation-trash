/**
 * dsh-conversation-trash — host half.
 *
 * Soft-deletes conversations for the Web GUI:
 *
 *   1. archive the session through the Workspace registry with
 *      `stopActivity: true` — that stops whatever the session is running and
 *      hides its row from the default sidebar immediately;
 *   2. move the session's log directory out of `~/.dsh/sessions/<workspace>/`
 *      into `~/.dsh/session-trash/<session-id>/`;
 *   3. record the move in `~/.dsh/session-trash/index.json` so the action can
 *      be undone or purged.
 *
 * Subagent descendants are trashed with their parent; forks are independent
 * conversations and are left alone.
 *
 * Routes (loopback-only, same-origin, JSON POST):
 *   GET  /dsh-conversation-trash/list       — trash entries + total size
 *   POST /dsh-conversation-trash/preview    — what a delete of one session would touch
 *   POST /dsh-conversation-trash/delete     — { sessionId, displayTitle }
 *   POST /dsh-conversation-trash/restore    — { sessionId }
 *   POST /dsh-conversation-trash/purge      — { sessionId }
 *   POST /dsh-conversation-trash/purge-all  — {}
 *
 * Windows note: a session log can still be open when the move runs, which
 * fails with EBUSY/EPERM. The delete then records the entry with
 * `moved: false` and retries in the background; the startup sweep finishes
 * the job before any session writer attaches.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-conversation-trash";
/** Optional seams: the Web server provides the routes, the rest degrade. */
export const inject = [];

const ROUTE_BASE = "/dsh-conversation-trash";
const DSH_HOME = join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const TRASH_DIR = join(DSH_HOME, "session-trash");
const INDEX_FILE = join(TRASH_DIR, "index.json");
const MOVE_RETRY_DELAYS_MS = [0, 1200, 2500, 5000, 8000, 12000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Same fence the shipped Web plugins use: the route must answer a loopback
 * Host only, a present Origin must match it, cross-site fetches are refused,
 * and a POST must be `application/json` (which kills CSRF simple requests).
 */
function fenceViolation(req) {
  const host = req.headers.host ?? "";
  const hostname = /^\[.*\](?::\d+)?$/.test(host) ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  if (!(hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))) return "host is not a loopback authority";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== host) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] ?? "";
    if (!/^\s*application\/json\s*(;|$)/.test(contentType)) return "POST requires an application/json body";
  }
  return undefined;
}

function fenceRejected(req, res) {
  const violation = fenceViolation(req);
  if (violation === undefined) return false;
  sendJson(res, 403, { error: `forbidden: ${violation}` });
  return true;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(target, limit = 20000) {
  let total = 0;
  let seen = 0;
  const stack = [target];
  while (stack.length > 0 && seen < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        seen += 1;
        try {
          total += (await stat(child)).size;
        } catch {
          /* a file that vanished mid-walk contributes nothing */
        }
      }
    }
  }
  return total;
}

/**
 * A Session's canonical id carries its storage prefix: the durable header says
 * `"id": "session-<uuid>"`, the log directory is named exactly that, and the
 * Workspace registry's known-set is keyed by it. The sidebar hands the menu
 * slot the same string, so the wire form is canonical already; this helper only
 * repairs a caller that passes the bare uuid.
 */
function normalizeSessionId(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return value;
  return value.startsWith("session-") ? value : `session-${value}`;
}

/** The uuid without its storage prefix — only used to find legacy trash folders. */
function bareSessionId(raw) {
  return normalizeSessionId(raw).replace(/^session-/, "");
}

/**
 * Locate a stored session directory. Session logs live under
 * `~/.dsh/sessions/<encoded cwd>/<session-id>/`; the encoding is the host's
 * business, so the id is matched by scanning one level of workspace folders.
 */
async function findSessionDir(sessionId) {
  let workspaces;
  try {
    workspaces = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const folder = normalizeSessionId(sessionId);
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const candidate = join(SESSIONS_DIR, entry.name, folder);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a trash folder by canonical id, falling back to the bare-uuid name a
 * 0.1.x build used before ids were normalized.
 */
async function trashPathFor(sessionId) {
  const canonical = join(TRASH_DIR, normalizeSessionId(sessionId));
  if (await pathExists(canonical)) return canonical;
  const legacy = join(TRASH_DIR, bareSessionId(sessionId));
  if (await pathExists(legacy)) return legacy;
  return canonical;
}

/* -------------------------------------------------------------------------- */
/* Trash controller                                                           */
/* -------------------------------------------------------------------------- */

class SessionTrash {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = Promise.resolve();
    this.cache = undefined;
  }

  /** Serialize every mutation: the index file must never interleave writes. */
  enqueue(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async index() {
    if (this.cache !== undefined) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(INDEX_FILE, "utf8"));
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.cache = {
        version: 1,
        // Older builds recorded the sidebar's `session-<uuid>` wire id; the
        // index speaks bare uuids so a migrated entry can still be restored.
        entries: entries.map((entry) =>
          entry !== null && typeof entry === "object" ? { ...entry, id: normalizeSessionId(entry.id) } : entry
        )
      };
    } catch {
      this.cache = { version: 1, entries: [] };
    }
    return this.cache;
  }

  async save(next) {
    this.cache = next;
    await mkdir(TRASH_DIR, { recursive: true });
    const temp = `${INDEX_FILE}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, INDEX_FILE);
  }

  /* -- host seams ---------------------------------------------------------- */

  registry() {
    return this.ctx.get("workspaceRegistry");
  }

  sessionStore() {
    return this.ctx.get("sessions");
  }

  /**
   * Subagent descendants of one session: a session belongs to a parent through
   * its durable header. Both sources are consulted because `sessions.list()`
   * only sees live sessions while the query service sees every stored one.
   */
  async descendantsOf(sessionId) {
    const parentOf = (item) =>
      item?.header?.parentSession ?? item?.parentSession ?? item?.summary?.parentSession ?? item?.summary?.header?.parentSession;
    const idOf = (item) => item?.header?.id ?? item?.id ?? item?.sessionId;

    const items = [];
    const query = this.ctx.get("sessionQuery");
    if (query?.listSessions) {
      try {
        const listed = await Promise.resolve(query.listSessions());
        if (Array.isArray(listed)) items.push(...listed);
      } catch {
        /* the query backend is optional */
      }
    }
    const store = this.sessionStore();
    if (store?.list) items.push(...store.list());

    const childrenOf = new Map();
    for (const item of items) {
      const id = idOf(item);
      const parent = parentOf(item);
      if (typeof id !== "string" || typeof parent !== "string" || id === parent) continue;
      if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
      childrenOf.get(parent).add(id);
    }

    const out = [];
    const queue = [sessionId];
    const seen = new Set([sessionId]);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of childrenOf.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  }

  /**
   * Archive (which also stops running work) without letting the archive step
   * abort the delete. The move is the real deletion; archiving only hides the
   * row and stops work, so a refusal here is logged and the delete proceeds.
   */
  async archiveQuietly(sessionId) {
    const registry = this.registry();
    if (typeof registry?.archiveSession !== "function") return false;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
      return true;
    } catch (error) {
      this.ctx.logger?.warn?.(`[session-trash] archive skipped for ${sessionId}: ${String(error?.message ?? error)}`);
      return false;
    }
  }

  async unarchiveQuietly(sessionId) {
    const registry = this.registry();
    if (typeof registry?.unarchiveSession !== "function") return;
    try {
      await registry.unarchiveSession(sessionId);
    } catch {
      /* an id that is not archived is a no-op for the registry */
    }
  }

  /* -- moves --------------------------------------------------------------- */

  async moveTo(entry) {
    const source = await findSessionDir(entry.id);
    if (source === undefined) {
      entry.moved = false;
      entry.missing = true;
      return entry;
    }
    entry.origin = source;
    const destination = join(TRASH_DIR, normalizeSessionId(entry.id));
    let lastError;
    for (const delay of MOVE_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        await rm(destination, { recursive: true, force: true });
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
        entry.moved = true;
        entry.missing = false;
        entry.size = await directorySize(destination);
        return entry;
      } catch (error) {
        lastError = error;
      }
    }
    entry.moved = false;
    entry.pending = true;
    entry.error = String(lastError?.message ?? lastError);
    entry.size = await directorySize(source);
    this.ctx.logger?.warn?.(`[session-trash] could not move ${entry.id} yet: ${entry.error}`);
    return entry;
  }

  async restoreEntry(entry) {
    let moved = true;
    if (entry.moved === true) {
      const destination = await trashPathFor(entry.id);
      const target = entry.origin ?? (await findSessionDir(entry.id));
      if (target !== undefined) {
        if (!(await pathExists(target))) {
          await mkdir(dirname(target), { recursive: true });
          await rename(destination, target);
        }
      } else {
        // The session directory never made it out of the sessions tree.
        moved = false;
      }
    }
    await this.unarchiveQuietly(entry.id);
    return moved;
  }

  async purgeEntry(entry) {
    await rm(await trashPathFor(entry.id), { recursive: true, force: true });
    if (entry.moved === false && typeof entry.origin === "string") {
      // The move never happened, so the live log is still the source of truth.
      await rm(entry.origin, { recursive: true, force: true });
    }
  }
  /* -- operations ---------------------------------------------------------- */

  async preview(rawSessionId) {
    const sessionId = normalizeSessionId(rawSessionId);
    const sessions = this.sessionStore();
    const store = sessions?.get?.(sessionId);
    const directory = await findSessionDir(sessionId);
    return {
      sessionId,
      title: store?.header?.title ?? undefined,
      children: await this.descendantsOf(sessionId),
      archived: archivedSet(this.ctx).has(sessionId),
      known: store !== undefined || directory !== undefined
    };
  }

  async delete(rawSessionId, displayTitle) {
    const sessionId = normalizeSessionId(rawSessionId);
    const current = await this.index();
    const previous = current.entries.filter((entry) => entry.id === sessionId);
    // A previous attempt that actually moved the logs means the job is done.
    // One that failed (missing directory, locked file) is retried below.
    if (previous.some((entry) => entry.moved === true)) return { already: true };

    const children = await this.descendantsOf(sessionId);
    const store = this.sessionStore();
    const title = store?.get?.(sessionId)?.header?.title ?? displayTitle ?? "";

    const created = [];
    for (const id of [sessionId, ...children]) {
      await this.archiveQuietly(id);
      const entry = {
        id,
        title: id === sessionId ? title : (store?.get?.(id)?.header?.title ?? ""),
        parent: id === sessionId ? undefined : sessionId,
        deletedAt: Date.now(),
        moved: false,
        size: 0
      };
      created.push(await this.moveTo(entry));
    }

    const next = { ...(await this.index()) };
    const replaced = new Set(created.map((entry) => entry.id));
    next.entries = [...created, ...next.entries.filter((entry) => !replaced.has(entry.id))];
    await this.save(next);
    return { deleted: created.map((entry) => entry.id), moved: created.every((entry) => entry.moved), children };
  }

  async restore(rawSessionId) {
    const sessionId = normalizeSessionId(rawSessionId);
    const current = await this.index();
    const entry = current.entries.find((item) => item.id === sessionId);
    if (entry === undefined) throw httpError(404, "not-in-trash");
    // Restoring a parent brings back the children it owns.
    const doomed = [entry, ...current.entries.filter((item) => item.parent === sessionId)];
    for (const item of doomed) await this.restoreEntry(item);
    const ids = new Set(doomed.map((item) => item.id));
    await this.save({ ...current, entries: current.entries.filter((item) => !ids.has(item.id)) });
    return { restored: [...ids] };
  }

  async purge(rawSessionId) {
    const sessionId = normalizeSessionId(rawSessionId);
    const current = await this.index();
    const entry = current.entries.find((item) => item.id === sessionId);
    if (entry === undefined) throw httpError(404, "not-in-trash");
    const doomed = [entry, ...current.entries.filter((item) => item.parent === sessionId)];
    for (const item of doomed) await this.purgeEntry(item);
    const ids = new Set(doomed.map((item) => item.id));
    await this.save({ ...current, entries: current.entries.filter((item) => !ids.has(item.id)) });
    return { purged: [...ids] };
  }

  async purgeAll() {
    const current = await this.index();
    for (const entry of current.entries) await this.purgeEntry(entry);
    await this.save({ ...current, entries: [] });
    return { purged: current.entries.length };
  }

  async list() {
    const current = await this.index();
    const entries = [...current.entries].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        title: entry.title ?? "",
        parent: entry.parent,
        deletedAt: entry.deletedAt,
        moved: entry.moved === true,
        pending: entry.pending === true,
        size: entry.size ?? 0
      })),
      totalSize: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
    };
  }

  /** Finish moves that a Windows file lock refused at delete time. */
  async sweep() {
    const current = await this.index();
    let changed = false;
    for (const entry of current.entries) {
      if (entry.moved === true) continue;
      const finished = await this.moveTo(entry);
      if (finished.moved === true) changed = true;
    }
    if (changed) await this.save(current);
  }
}

function archivedSet(ctx) {
  const registry = ctx.get("workspaceRegistry");
  const ids = registry?.archivedSessionIds;
  return new Set(Array.isArray(ids) ? ids : []);
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

function registerRoutes(webServer, trash) {
  const disposers = [];
  const route = (method, path, handler) => {
    disposers.push(
      webServer.register({
        kind: "exact",
        path: `${ROUTE_BASE}${path}`,
        handler: async (req, res) => {
          if (req.method !== method) {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          if (fenceRejected(req, res)) return;
          try {
            const body = method === "POST" ? await readJson(req) : {};
            const result = await handler(body);
            sendJson(res, 200, result ?? { ok: true });
          } catch (error) {
            const status = typeof error?.status === "number" ? error.status : 500;
            sendJson(res, status, {
              error: String(error?.message ?? error),
              details: error?.details
            });
          }
        }
      })
    );
  };

  route("GET", "/list", () => trash.list());

  route("POST", "/preview", async (body) => {
    if (typeof body.sessionId !== "string" || body.sessionId === "") throw httpError(400, "sessionId required");
    return trash.preview(body.sessionId);
  });

  route("POST", "/delete", async (body) => {
    if (typeof body.sessionId !== "string" || body.sessionId === "") throw httpError(400, "sessionId required");
    return trash.enqueue(() => trash.delete(body.sessionId, typeof body.displayTitle === "string" ? body.displayTitle : ""));
  });

  route("POST", "/restore", async (body) => {
    if (typeof body.sessionId !== "string" || body.sessionId === "") throw httpError(400, "sessionId required");
    return trash.enqueue(() => trash.restore(body.sessionId));
  });

  route("POST", "/purge", async (body) => {
    if (typeof body.sessionId !== "string" || body.sessionId === "") throw httpError(400, "sessionId required");
    return trash.enqueue(() => trash.purge(body.sessionId));
  });

  route("POST", "/purge-all", () => trash.enqueue(() => trash.purgeAll()));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* a route removed with its server needs no cleanup */
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export function apply(ctx) {
  const trash = new SessionTrash(ctx);
  // Never let a failed sweep or a missing Web server cost the whole plugin tree.
  // `DSH_SESSION_TRASH_NO_SWEEP=1` keeps read-only harnesses (the dry-run test)
  // from finishing a pending move.
  if (process.env.DSH_SESSION_TRASH_NO_SWEEP !== "1") {
    trash.sweep().catch((error) => ctx.logger?.warn?.(`[session-trash] sweep failed: ${String(error)}`));
  }
  try {
    ctx.inject(["webServer"], (injected) => registerRoutes(injected.webServer, trash));
  } catch (error) {
    ctx.logger?.warn?.(`[session-trash] web routes unavailable: ${String(error)}`);
  }
}
