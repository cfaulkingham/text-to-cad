import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SOURCE_SIDECAR_SCHEMA_VERSION } from '@text-to-cad/core/common/sourceSidecar.js';
import { AnimationClockProvider, createAnimationClock } from '../../../../dist/renderers/step/workbench/animationClockStore.js';
import { stepPosableDofs } from '../../../../dist/renderers/step/workbench/jointHandles.js';
import { useStepMotion } from '../../../../dist/renderers/step/workbench/useStepMotion.js';

afterEach(cleanup);

const swing = { name: 'swing', kind: 'revolute', parent: '#base', child: '#flap',
  axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, limits: { value: [0, 120] } };
// One save of hinge.step as the catalog lists it: new STEP bytes, and the sidecar written again
// beside them (a new version on its URL, bound to those bytes). No mates, no sidecar.
function saved(revision: number, mates = [swing]) {
  const documentHash = String(revision).repeat(64);
  return { file: 'hinge.step', kind: 'part', hash: `tree-${revision}`, documentHash, ...(mates.length ? {
    poseUrl: `/__cad/asset?file=hinge.step.json&v=${revision}`,
    sourceSidecar: { schemaVersion: SOURCE_SIDECAR_SCHEMA_VERSION, documentHash, kinematics: { mates } } } : {}) };
}

it('a rebuild keeps Position, and the pose set on it, while its sidecar is read again', async () => {
  const clock = createAnimationClock();
  // Whether Position is offered (StepSurface's `poseAvailable`), at every render.
  const offered: boolean[] = [];
  const { result, rerender } = renderHook(({ entry }) => {
    const motion = useStepMotion({ entry, fileKey: entry.file, resources: null, meshData: null, meshPartial: false,
      readStored: () => ({ pose: null }), clipboard: null, reportError: () => {} });
    offered.push(stepPosableDofs(motion.definition).length > 0);
    return motion;
  }, { initialProps: { entry: saved(1) },
    wrapper: ({ children }) => <AnimationClockProvider value={clock}>{children}</AnimationClockProvider> });
  await waitFor(() => expect(result.current.definition?.url).toMatch(/v=1$/));
  act(() => result.current.onParameterChange('swing', 30));

  offered.length = 0;
  rerender({ entry: saved(2) });
  await waitFor(() => expect(result.current.definition?.url).toMatch(/v=2$/));
  expect(offered).not.toContain(false);
  expect(result.current.parameterValues).toEqual({ swing: 30 });

  // A joint the save changed keeps what still fits it.
  rerender({ entry: saved(3, [{ ...swing, limits: { value: [0, 20] } }]) });
  await waitFor(() => expect(result.current.parameterValues).toEqual({ swing: 20 }));

  // A save that takes the mates out takes Position with them.
  rerender({ entry: saved(4, []) });
  expect(stepPosableDofs(result.current.definition)).toEqual([]);
});
