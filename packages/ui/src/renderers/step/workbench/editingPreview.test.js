import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_SIDECAR_SCHEMA_VERSION, validateSourceSidecar } from "@text-to-cad/core/common/sourceSidecar.js";
import { editingBuildActive, initialEditingPreview, previewEntry, reduceEditingPreview } from "./editingPreview.js";

const update = (revision, extra = {}) => ({ epoch: "a", revision, output: "/part.step", state: "building", ...extra });

test("the newest build is followed and a late answer about an older one is ignored", () => {
  const first = reduceEditingPreview(initialEditingPreview(), update(1));
  const second = reduceEditingPreview(first, update(2));
  assert.equal(second.revision, 2);
  assert.equal(reduceEditingPreview(second, update(1, { state: "failed", error: "late" })), second);
});

test("a daemon epoch change restarts the ordering", () => {
  const before = reduceEditingPreview(initialEditingPreview(), update(99, { state: "failed", error: "Disk full" }));
  const restarted = reduceEditingPreview(before, { ...update(1), epoch: "b" });
  assert.equal(restarted.revision, 1);
  assert.equal(restarted.error, "");
});

test("a running build keeps its phase narration and a finished or quiet one clears it", () => {
  const building = reduceEditingPreview(initialEditingPreview(), update(7, {
    phase: "Building geometry", detail: "finger linkage", updatedAt: 1234,
  }));
  const later = reduceEditingPreview(building, update(7, { phase: "", detail: "", updatedAt: null }));
  assert.deepEqual([later.phase, later.detail, later.updatedAt], ["Building geometry", "finger linkage", 1234]);
  const done = reduceEditingPreview(later, update(7, { state: "done" }));
  assert.deepEqual([done.phase, done.detail, done.updatedAt], ["", "", 0]);
  const quiet = reduceEditingPreview(done, { state: "disconnected" });
  assert.deepEqual([quiet.state, quiet.phase], ["disconnected", ""]);
});

test("a build the file moved past keeps no failure", () => {
  const failed = reduceEditingPreview(initialEditingPreview(), update(3, { state: "failed", error: "Disk full" }));
  assert.equal(failed.error, "Disk full");
  const moved = reduceEditingPreview(failed, update(3, { state: "failed", superseded: true, error: null }));
  assert.deepEqual([moved.superseded, moved.error], [true, ""]);
});

test("only a queued or running build is active", () => {
  for (const state of ["submitted", "queued", "building"]) assert.equal(editingBuildActive({ state }), true, state);
  for (const state of ["done", "failed", "disconnected", undefined]) assert.equal(editingBuildActive({ state }), false, String(state));
});

test("a build names the file's next tree only while the feed does", () => {
  const preview = { tree: "next", url: "/__cad/store?file=next" };
  const announced = reduceEditingPreview(initialEditingPreview(), update(4, { preview }));
  assert.deepEqual(announced.preview, preview);
  assert.equal(reduceEditingPreview(announced, update(4, { state: "failed", error: "boom" })).preview, null);
  assert.equal(reduceEditingPreview(announced, { state: "disconnected" }).preview, null);
  assert.equal(reduceEditingPreview(announced, update(5)).preview, null, "a newer build has announced nothing yet");
});

test("the file is shown as its announced tree, and is its own entry once written", () => {
  const saved = { file: "car.step", url: "/__cad/store?file=old&documentHash=x", hash: "old", documentHash: "x" };
  const state = { preview: { tree: "next", url: "/__cad/store?file=next" } };
  const shown = previewEntry(saved, state);
  assert.deepEqual([shown.file, shown.url, shown.hash, shown.documentHash], ["car.step", "/__cad/store?file=next", "next", ""]);
  const written = { ...saved, url: "/__cad/store?file=next&documentHash=y", hash: "next", documentHash: "y" };
  assert.equal(previewEntry(written, state), written);
  assert.equal(previewEntry(saved, initialEditingPreview()), saved);
});

test("a file with a sidecar is shown as saved until its save lands", () => {
  // The viewer validates the sidecar against the entry's STEP bytes, which the announced tree precedes.
  const documentHash = "a".repeat(64);
  const sourceSidecar = { schemaVersion: SOURCE_SIDECAR_SCHEMA_VERSION, documentHash };
  const saved = {
    file: "car.step", url: `/__cad/store?file=old&documentHash=${documentHash}`, hash: "old", documentHash,
    sourceUrl: "/__cad/asset?file=car.step.json", sourceSidecar,
  };
  const shown = previewEntry(saved, { preview: { tree: "next", url: "/__cad/store?file=next" } });
  assert.equal(shown, saved);
  assert.doesNotThrow(() => validateSourceSidecar(shown.sourceSidecar, { documentHash: shown.documentHash }));
});
