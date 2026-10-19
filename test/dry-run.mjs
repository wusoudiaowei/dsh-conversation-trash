/**
 * Read-only dry run against the real `~/.dsh`: boots the host half with a fake
 * Cordis context, then only calls the non-mutating routes (`/list`,
 * `/preview`). Nothing under `~/.dsh` is created, moved, or deleted.
 *
 *   node test/dry-run.mjs
 *
 * It proves three things before install: the module loads outside DSH, the
 * routes register, and session directories are found in the real tree.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Read-only: never finish a pending move from a diagnostic run.
process.env.DSH_SESSION_TRASH_NO_SWEEP = "1";

const { apply } = await import("../lib/index.mjs?" + Date.now());

const routes = new Map();
const ctx = {
  logger: { warn: (message) => console.warn("[warn]", message), info() {} },
  get() {
    return undefined; // no registry / session store in a dry run
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
assert.equal(routes.size, 6, "six routes registered");

function call(path, { method = "GET", body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = {
    method,
    headers: { host: "127.0.0.1:9", origin: "http://127.0.0.1:9", "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload !== "") yield Buffer.from(payload);
    }
  };
  return new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end(text) {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      }
    };
    Promise.resolve(routes.get(path)(req, res)).catch(reject);
  });
}

// Discover one real session on disk.
const sessionsRoot = join(homedir(), ".dsh", "sessions");
const workspaces = await readdir(sessionsRoot, { withFileTypes: true });
let sample;
for (const workspace of workspaces) {
  if (!workspace.isDirectory()) continue;
  const entries = await readdir(join(sessionsRoot, workspace.name), { withFileTypes: true });
  const session = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("session-"));
  if (session !== undefined) {
    sample = { id: session.name.slice("session-".length), workspace: workspace.name };
    break;
  }
}

assert.ok(sample !== undefined, "at least one stored session exists");

const listed = await call("/dsh-conversation-trash/list");
assert.ok(Array.isArray(listed.entries), "list answers");
assert.ok(
  listed.entries.every((entry) => typeof entry.id === "string" && entry.id.startsWith("session-")),
  "index speaks canonical session ids"
);

const known = await call("/dsh-conversation-trash/preview", { method: "POST", body: { sessionId: sample.id } });
assert.equal(known.known, true, `session directory found for ${sample.id}`);
assert.equal(known.sessionId, `session-${sample.id}`, "a bare uuid is repaired to the canonical id");

const missing = await call("/dsh-conversation-trash/preview", { method: "POST", body: { sessionId: "00000000-dead-beef-0000-000000000000" } });
assert.equal(missing.known, false, "an unknown id is reported as unknown");

console.log(`dry-run: ok (sample session ${sample.id} in ${sample.workspace}; nothing was modified)`);
