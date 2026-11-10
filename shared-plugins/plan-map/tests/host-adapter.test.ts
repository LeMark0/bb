import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { createPlanLocation } from "../bb-host-adapter.ts";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
  window: { innerWidth: 1280 },
  Node: class {},
});

beforeEach(() => store.clear());

describe("createPlanLocation", () => {
  it("should keep upstream's URL shape in memory and save only the view reference under the plugin id", () => {
    const location = createPlanLocation({ pluginId: "plan-map", scope: "proj_a:map1" });
    location.push("?view=board&workstream=delivery#item/P2");
    assert.equal(location.url().search, "?view=board&workstream=delivery");
    assert.equal(location.url().hash, "#item/P2");
    assert.deepEqual([...store.entries()], [["plan-map:view:proj_a:map1", "?view=board&workstream=delivery#item/P2"]]);
    location.push("#recap");
    assert.equal(location.url().search, "?view=board&workstream=delivery");
    assert.equal(store.get("plan-map:view:proj_a:map1"), "?view=board&workstream=delivery#recap");
  });

  it("should restore a saved view for the same project and ADR only", () => {
    store.set("plan-map:view:proj_a:map1", "?view=steps#item/P3");
    assert.equal(createPlanLocation({ pluginId: "plan-map", scope: "proj_a:map1" }).url().hash, "#item/P3");
    assert.equal(createPlanLocation({ pluginId: "plan-map", scope: "proj_b:map1" }).url().hash, "");
    assert.equal(createPlanLocation({ pluginId: "other-copy", scope: "proj_a:map1" }).url().hash, "");
  });

  it("should ignore a saved value that is not a view reference", () => {
    store.set("plan-map:view:proj_a:map1", "https://example.com/elsewhere");
    assert.equal(createPlanLocation({ pluginId: "plan-map", scope: "proj_a:map1" }).url().href, "https://plan-map.invalid/");
    store.set("plan-map:view:proj_a:map1", `?${"x".repeat(3000)}`);
    assert.equal(createPlanLocation({ pluginId: "plan-map", scope: "proj_a:map1" }).url().search, "");
  });

  it("should not save anything without a scope", () => {
    createPlanLocation({ pluginId: "plan-map" }).push("#item/P1");
    assert.equal(store.size, 0);
  });

  it("should namespace other keys and describe the view as a path reference, not a link", () => {
    const location = createPlanLocation({ pluginId: "plan-map", scope: "proj_a:map1" });
    assert.equal(location.storageKey("panel"), "plan-map:panel");
    location.push("?view=steps#item/P2");
    assert.equal(location.reference("/repo/docs/adr/0003.md"), "/repo/docs/adr/0003.md?view=steps#item/P2");
  });

  it("should treat a target outside its root as not its own", () => {
    const location = createPlanLocation();
    assert.equal(location.contains(null), false);
    assert.equal(location.contains({} as EventTarget), false);
  });

  it("should fall back to the window width before the tab is mounted", () => {
    const location = createPlanLocation();
    assert.equal(location.isAtMost(1280), true);
    assert.equal(location.isAtMost(1000), false);
  });
});
