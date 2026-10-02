import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createHttpCadResourceProvider } from '@text-to-cad/core/client';
import { entryHasMesh, entryHasReferences } from '@text-to-cad/core/lib/entryAssets.js';
import { renderAssetCacheStats } from '@text-to-cad/core/lib/renderAssetClient.js';
import { createTessellationCache, encodeComponentTessellation, tessellationPayloadFacts,
  tessellationCacheKey, validateTessellationProbeRow } from '@text-to-cad/core/lib/surf/tessellationCache.js';
import { lodTessellationForLevel } from '@text-to-cad/core/lib/surf/lodPolicy.js';
import { completedPackages } from '../../../render/completedPackageCache.js';
import { viewerMemoryPolicy } from '../../../render/viewerMemoryPolicy.js';
import { useCadAssets } from './useCadAssets.js';

const triangle = `solid test
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid test`;

function entry(name: string, kind = 'stl') {
  return { file: `${name}.${kind}`, kind, hash: name, url: `https://cad-assets.test/${name}.${kind}` };
}

let defaultClient = {};
function assets(initialEntry: ReturnType<typeof entry>, client = defaultClient, tessellationCache = {}) {
  client.resources ||= createHttpCadResourceProvider();
  return useCadAssets({ initialEntry, client, tessellationCache,
    entryHasMesh, entryHasReferences,
    buildNormalizedReferenceState: () => null });
}

afterEach(() => {
  cleanup();
  defaultClient = {};
  completedPackages.clear();
  viewerMemoryPolicy.reset();
  vi.unstubAllGlobals();
});

// A 317-component STEP whose every component has a warm standard entry: its descriptor, served
// by a stubbed fetch, and the encoded entries by tessellation key.
function warmLargeStep() {
  const client = { workspaceId: 'large-step-root', origin: 'https://cad-assets.test' };
  const model = { ...entry('warm-large-step', 'assembly'), sourceFormat: 'step',
    file: 'warm-large-step.step', url: 'https://cad-assets.test/__cad/asset?file=/warm-large-step&v=one', documentHash: 'document-one' };
  const tessellation = lodTessellationForLevel(1);
  const encoded = new Map();
  const components = {}, occurrences = [];
  for (let i = 0; i < 317; i++) {
    const cid = `c${i}`;
    const surfaceInput = createHash('sha256').update(`317-component-${cid}`).digest('hex');
    const surfaceObject = 'a'.repeat(64);
    const bytes = encodeComponentTessellation({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      faceOrds: new Float32Array([1, 1, 1]), indices: new Uint32Array([0, 1, 2]),
      sideOrds: new Uint32Array([1, 2, 3]),
      faceRanges: [{ ord: 1, color: null, indexStart: 0, indexCount: 3 }],
      edges: [], bounds: { min: [0, 0, 0], max: [1, 1, 0] }, scale: 1,
    }, { surfaceInput, surfaceObject, tessellation, edgeClasses: [] });
    const row = validateTessellationProbeRow({ schemaVersion: 1,
      object: createHash('sha256').update(bytes).digest('hex'), ...tessellationPayloadFacts(bytes) });
    encoded.set(tessellationCacheKey(surfaceInput, tessellation), { bytes, row });
    components[cid] = { surfaceInput };
    occurrences.push({ id: `o${i}`, name: cid, component: cid,
      transform: [1, 0, 0, i * 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  }
  const descriptor = { kind: 'assembly-package', viewId: 'large-step-view', components, occurrences,
    assembly: { root: { id: 'root', nodeType: 'assembly', children: occurrences.map(({ id }) => ({ id, nodeType: 'part', children: [] })) } } };
  const fetch = vi.fn(async (url: string) => {
    expect(url).toContain('assembly.json');
    return new Response(JSON.stringify(descriptor));
  });
  vi.stubGlobal('fetch', fetch);
  return { client, model, encoded, fetch };
}

it('restores all 317 STEP components after remount without a descriptor, SURF or TESS read', async () => {
  const { client, model, encoded, fetch } = warmLargeStep();
  const probe = vi.fn(async keys => keys.map(key => encoded.get(key)?.row || null));
  const bodies = vi.fn(async row => encoded.get(row.tessellationInput)?.bytes.slice() || null);
  const owner = createTessellationCache({ provider: { probeMany: probe, getProbed: bodies } });
  try {
    const session = owner.createSession();
    const first = renderHook(() => assets(model, client, session));
    await act(() => first.result.current.loadMeshForEntry(model));
    expect(first.result.current.error).toBe('');
    expect(first.result.current.meshState.assemblyInteractionReady).toBe(true);
    expect(first.result.current.meshState.meshData.parts).toHaveLength(317);
    expect(first.result.current.lodPackage.components).toHaveLength(317);
    const firstVertices = first.result.current.meshState.meshData.parts[0].sourceMesh.vertices;
    expect(bodies).toHaveBeenCalledTimes(317);
    expect(renderAssetCacheStats().surfLeash.limit).toBe(24);
    expect(renderAssetCacheStats().surfLeash.entries).toBeLessThanOrEqual(24);
    first.unmount();
    session.dispose();
    expect(completedPackages.stats().entries).toBe(1);
    const before = { fetch: fetch.mock.calls.length, probes: probe.mock.calls.length, bodies: bodies.mock.calls.length };
    const reopenSession = owner.createSession();
    const reopen = renderHook(() => assets(model, { ...client }, reopenSession));
    expect(reopen.result.current.meshState.meshData.parts).toHaveLength(317);
    expect(reopen.result.current.meshState.meshData.parts[0].sourceMesh.vertices).toBe(firstVertices);
    expect(reopen.result.current.lodPackage.components).toHaveLength(317);
    expect(reopen.result.current.meshLoadInProgress).toBe(false);
    expect(reopen.result.current.meshLoadProgress).toBeNull();
    await act(() => reopen.result.current.loadMeshForEntry(model));
    expect(fetch).toHaveBeenCalledTimes(before.fetch);
    expect(probe).toHaveBeenCalledTimes(before.probes);
    expect(bodies).toHaveBeenCalledTimes(before.bodies);
    reopen.unmount();
    reopenSession.dispose();
    const changed = renderHook(() => assets({ ...model, hash: 'new-document' }, client, owner.createSession()));
    expect(changed.result.current.meshState).toBeNull();
    expect(changed.result.current.lodPackage).toBeNull();
    changed.unmount();
  } finally { owner.dispose(); }
});

// The open itself: where each component probed its cache and read its body alone, a chunk of
// components shares one probe and a batch of them one read, growing from the first publish's eight.
it('opens a warm 317-component STEP with a probe per chunk and its bodies in batches, none read alone', async () => {
  const { client, model, encoded } = warmLargeStep();
  const probe = vi.fn(async keys => keys.map(key => encoded.get(key)?.row || null));
  const single = vi.fn(async row => encoded.get(row.tessellationInput)?.bytes.slice() || null);
  const many = vi.fn(async rows => rows.map(row => encoded.get(row.tessellationInput)?.bytes.slice() || null));
  const owner = createTessellationCache({ provider: { probeMany: probe, getProbed: single, getManyProbed: many } });
  try {
    const opened = renderHook(() => assets(model, client, owner.createSession()));
    await act(() => opened.result.current.loadMeshForEntry(model));
    expect(opened.result.current.error).toBe('');
    expect(opened.result.current.meshState.assemblyInteractionReady).toBe(true);
    expect(opened.result.current.meshState.meshData.parts).toHaveLength(317);
    expect(probe.mock.calls.map(([keys]) => keys.length)).toEqual([8, 16, 32, 64, 128, 69]);
    expect(many.mock.calls.map(([rows]) => rows.length)).toEqual([8, 16, 32, 64, 128, 69]);
    expect(single).not.toHaveBeenCalled();
    expect(viewerMemoryPolicy.snapshot().inFlightBytes).toBe(0);
    opened.unmount();
  } finally { owner.dispose(); }
});
