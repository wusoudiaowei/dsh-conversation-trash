/**
 * Smoke test for the host half: a fake Cordis context, a fake Web server, and a
 * throwaway HOME. Run with:
 *
 *   node test/smoke.mjs
 *
 * It exercises preview → delete → list → restore → delete → purge and the
 * loopback/origin fence, without touching the real `~/.dsh`.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "session-trash-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.USERPROFILE.toLowerCase();

const dsh = join(root, ".dsh");
const workspaceDir = join(dsh, "sessions", "--C-work--");
const parentDir = join(workspaceDir, "session-parent");
const childDir = join(workspaceDir, "session-child");

await mkdir(parentDir, { recursive: true });
await mkdir(childDir, { recursive: true });
await writeFile(join(parentDir, "session.v4.jsonl.zstd"), "parent-log");
await writeFile(join(childDir, "session.v4.jsonl.zstd"), "child-log");

const { apply } = await import("../lib/index.mjs?" + Date.now());

const archived = [];
const unarchived = [];
const routes = new Map();

const ctx = {
  logger: { warn() {}, info() {} },
  get(key) {
    if (key === "workspaceRegistry") {
      return {
        archiveSession: async (id, options) => {
          archived.push({ id, options });
        },
        unarchiveSession: async (id) => {
          unarchived.push(id);
        }
      };
    }
    if (key === "sessions") {
      return {
        list: () => [],
        get: (id) => (id === "session-parent" ? { header: { id: "session-parent", title: "Parent talk" } } : undefined)
      };
    }
    if (key === "sessionQuery") {
      return {
        listSessions: () => [
          { header: { id: "session-parent", title: "Parent talk" } },
          { header: { id: "session-child", parentSession: "session-parent", title: "Child run" } }
        ]
      };
    }
    return undefined;
  },
  inject(names, callback) {
    assert.deepEqual(names, ["webServer"]);
    callback({
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    });
    return () => {};
  }
};

apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.ok(routes.has("/dsh-conversation-trash/list"), "routes registered");

/** Minimal IncomingMessage/ServerResponse pair. */
function call(path, { method = "GET", body, headers = {} } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = {
    method,
    headers: {
      host: "127.0.0.1:65162",
      origin: "http://127.0.0.1:65162",
      "content-type": "application/json",
      ...headers
    },
    async *[Symbol.asyncIterator]() {
      if (payload !== "") yield Buffer.from(payload);
    }
  };
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      body: "",
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.body = text;
        try {
          resolve({ status: this.status, json: text === "" ? undefined : JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      }
    };
    Promise.resolve(routes.get(path)(req, res)).catch(reject);
  });
}

// fence: a non-loopback Host is refused
const refused = await call("/dsh-conversation-trash/list", { headers: { host: "example.com:80", origin: "http://example.com" } });
assert.equal(refused.status, 403, "non-loopback refused");

const empty = await call("/dsh-conversation-trash/list");
assert.equal(empty.status, 200);
assert.equal(empty.json.entries.length, 0);

// A Session id carries its storage prefix end to end: the sidebar hands the
// slot `session-<uuid>`, the header says the same, and the log directory is
// named exactly that. A bare uuid from an older caller must still resolve.
const preview = await call("/dsh-conversation-trash/preview", { method: "POST", body: { sessionId: "session-parent" } });
assert.equal(preview.status, 200);
assert.equal(preview.json.title, "Parent talk");
assert.equal(preview.json.known, true, "prefixed id resolves to the stored directory");
assert.equal(preview.json.sessionId, "session-parent", "the wire id stays canonical");
assert.deepEqual(preview.json.children, ["session-child"]);

const deleted = await call("/dsh-conversation-trash/delete", { method: "POST", body: { sessionId: "session-parent", displayTitle: "Parent talk" } });
assert.equal(deleted.status, 200);
assert.deepEqual(deleted.json.deleted.sort(), ["session-child", "session-parent"]);
assert.equal(archived.length, 2, "parent and child archived");
assert.ok(archived.every((entry) => entry.options.stopActivity === true));
assert.ok(archived.every((entry) => entry.id.startsWith("session-")), "the registry sees canonical ids");
assert.deepEqual((await readdir(workspaceDir)).sort(), [], "both session dirs left the sessions tree");

const listed = await call("/dsh-conversation-trash/list");
assert.equal(listed.json.entries.length, 2);
assert.ok(listed.json.entries.every((entry) => entry.moved === true));
assert.ok(listed.json.entries.every((entry) => entry.id.startsWith("session-")), "index stores canonical ids");

// A bare uuid is repaired at the boundary, so old callers keep working.
const restored = await call("/dsh-conversation-trash/restore", { method: "POST", body: { sessionId: "parent" } });
assert.equal(restored.status, 200);
assert.deepEqual((await readdir(workspaceDir)).sort(), ["session-child", "session-parent"], "parent and child restored");
assert.deepEqual(unarchived.sort(), ["session-child", "session-parent"]);

await call("/dsh-conversation-trash/delete", { method: "POST", body: { sessionId: "parent" } });
const purged = await call("/dsh-conversation-trash/purge", { method: "POST", body: { sessionId: "parent" } });
assert.equal(purged.status, 200);
assert.deepEqual(await readdir(workspaceDir), [], "purge removed the logs");
const afterPurge = await call("/dsh-conversation-trash/list");
assert.equal(afterPurge.json.entries.length, 0);

// method guard
const wrongMethod = await call("/dsh-conversation-trash/delete", { method: "GET" });
assert.equal(wrongMethod.status, 405);

await rm(root, { recursive: true, force: true });
console.log("smoke: ok");
