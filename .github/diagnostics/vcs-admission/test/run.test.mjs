import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE, checkIdentity, exitCode } from "../run.mjs";

const pinned = [{ path: "packages/process-utils", head: "t1", base: "t1" }];
const clean = { base: BASE, parent: BASE, changed: [".github/workflows/diagnose-vcs-admission.yml", ".github/diagnostics/vcs-admission/run.mjs"], pinned, dirty: [] };

describe("source identity", () => {
  it("accepts a diagnostic-only commit on the pinned base", () => {
    assert.deepEqual(checkIdentity(clean), []);
  });

  it("refuses another parent, outside changes, a changed pinned path or a dirty tree", () => {
    assert.match(checkIdentity({ ...clean, parent: "other" }).join(), /HEAD\^ is other/u);
    assert.match(checkIdentity({ ...clean, changed: [...clean.changed, "packages/process-utils/src/spawn.ts"] }).join(), /outside the diagnostic: packages\/process-utils\/src\/spawn.ts/u);
    assert.match(checkIdentity({ ...clean, changed: [".github/workflows/ci.yml"] }).join(), /outside the diagnostic: .github\/workflows\/ci.yml/u);
    assert.match(checkIdentity({ ...clean, pinned: [{ path: "vitest.shared.ts", head: "a", base: "b" }] }).join(), /vitest.shared.ts differs/u);
    assert.match(checkIdentity({ ...clean, dirty: [" M pnpm-lock.yaml"] }).join(), /working tree differs/u);
  });
});

describe("outcome", () => {
  const complete = { complete: true, problems: [] };
  const incomplete = { complete: false, problems: ["the sampler exited unexpectedly"] };

  it("reports Vitest's own result only with a loaded trace and complete coverage", () => {
    assert.equal(exitCode({ traceLoaded: true, coverage: complete, vitestCode: 0 }), 0);
    assert.equal(exitCode({ traceLoaded: true, coverage: complete, vitestCode: 1 }), 1);
  });

  it("reports incomplete evidence as 3 even when Vitest passed, and a driver stop as 4", () => {
    assert.equal(exitCode({ traceLoaded: true, coverage: incomplete, vitestCode: 0 }), 3);
    assert.equal(exitCode({ traceLoaded: false, coverage: complete, vitestCode: 0 }), 3);
    assert.equal(exitCode({ limitHit: true, traceLoaded: true, coverage: complete, vitestCode: "no-exit" }), 4);
    assert.equal(exitCode({ identityRefused: true }), 2);
  });
});
