import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildModel } from '@text-to-cad/core/common/cadScene.js';
import { useStepExplode } from './useStepExplode.js';

afterEach(cleanup);

// Two flat parts side by side, as the STEP scene's records.
function twoParts() {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    bounds: { min: [0, 0, 0], max: [3, 1, 0] },
    parts: [
      { id: 'left', vertexOffset: 0, vertexCount: 3, triangleOffset: 0, triangleCount: 1, bounds: { min: [0, 0, 0], max: [1, 1, 0] } },
      { id: 'right', vertexOffset: 3, vertexCount: 3, triangleOffset: 1, triangleCount: 1, bounds: { min: [2, 0, 0], max: [3, 1, 0] } }
    ]
  };
}

// The stage (the lights, the key's shadow, the depth range) is fitted to the scene's bounds, which
// follow a pose because the pose pass refreshes them. The pose pass runs before this layer in a
// commit, so an explosion applied after it left the stage lighting the model as it had been: a
// snapshot of the same exploded view, whose stage is fitted to where the parts are, lit it differently.
it('an exploded view takes the stage with it: the scene is bounded where its parts are drawn, and the viewport refits', () => {
  const meshData = twoParts();
  const cadScene = buildModel(THREE, meshData, { renderPartsIndividually: true });
  const rest = structuredClone(cadScene.restBounds);
  const runtime = { THREE, cadScene, displayRecords: cadScene.displayRecords, zeroPoseBounds: rest, requestRender() {} };
  const syncSceneBounds = vi.fn();
  renderHook(() => useStepExplode({
    viewport: { runtimeRef: { current: runtime }, viewerReadyTick: 1, syncSceneBounds },
    props: { meshData, modelKey: 'two-parts', isLoading: false },
    policy: {
      explodedViewActive: true, explodeAmount: 1, normalizedExplodedSettings: { enabled: true, amount: 1 },
      focusedPartIds: [], normalizedThemeSettings: {}
    },
    displayRecordsToken: 1,
    setExplodedViewPoseTick: vi.fn(),
    explosionRef: { current: { progress: 0, modelKey: '', enabled: false, layout: null } }
  }));
  try {
    // Where the parts are drawn: each record's rest box moved by its explosion.
    const drawn = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const record of cadScene.displayRecords) {
      const offset = record.explodedViewMatrix?.elements.slice(12, 15) || [0, 0, 0];
      for (let axis = 0; axis < 3; axis += 1) {
        drawn.min[axis] = Math.min(drawn.min[axis], record.partBounds.min[axis] + offset[axis]);
        drawn.max[axis] = Math.max(drawn.max[axis], record.partBounds.max[axis] + offset[axis]);
      }
    }
    expect(drawn.max[0] - drawn.min[0]).toBeGreaterThan(rest.max[0] - rest.min[0]);
    for (const side of ['min', 'max'] as const) {
      cadScene.bounds[side].forEach((value: number, axis: number) => expect(value).toBeCloseTo(drawn[side][axis], 9));
    }
    expect(syncSceneBounds).toHaveBeenCalled();
  } finally {
    cadScene.dispose();
  }
});
