/**
 * Structural test for the browser bundle: it must register itself through
 * `window.__ModuleLoader__.load`, export `apply`/`inject`, and register exactly
 * the two slots the feature needs. Rendering is covered by the real GUI.
 *
 *   node test/client-shape.mjs
 */

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = await readFile(new URL("../lib/client.cjs", import.meta.url), "utf8");

let captured;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      }
    }
  },
  navigator: { language: "zh-CN" },
  console,
  fetch: async () => {
    throw new Error("not used");
  }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.cjs" });

assert.ok(captured !== undefined, "bundle registered with the module loader");
assert.equal(captured.id, "dsh-conversation-trash");

const stubComponent = () => null;
const primitives = new Proxy(
  { default: undefined },
  {
    get(target, key) {
      if (key === "default") return undefined;
      return target[key] ?? stubComponent;
    }
  }
);

const moduleExports = captured.factory((name) => {
  if (name === "react") {
    return {
      createElement: () => null,
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      Fragment: "Fragment"
    };
  }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require: ${name}`);
});

assert.equal(typeof moduleExports.apply, "function");
assert.equal(Array.from(moduleExports.inject).join(","), "slots");

const registered = [];
const ctx = {
  slots: {
    inject(name, factory) {
      const iterator = factory();
      for (const entry of iterator) registered.push({ slot: name, entry });
    },
    register(spec, component) {
      return { spec, component };
    }
  }
};

moduleExports.apply(ctx);

assert.equal(registered.length, 2);
const menu = registered.find((entry) => entry.slot === "sidebar.workspaces.session.menu.item");
const overlay = registered.find((entry) => entry.slot === "shell.overlay");
assert.ok(menu !== undefined, "menu item registered");
assert.equal(menu.entry.spec.id, "trash-delete");
assert.equal(menu.entry.spec.order, 500);
assert.equal(typeof menu.entry.component, "function");
assert.ok(overlay !== undefined, "overlay registered");
assert.equal(overlay.entry.spec.id, "session-trash-overlay");

console.log("client-shape: ok");
