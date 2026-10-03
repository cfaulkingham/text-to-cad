import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { createStudioContactShadow } from "./studioContactShadow.js";

// The bake itself is GPU work; what is checked here is WHEN it runs and that it
// leaves the renderer, and every caster's material, exactly as it found them.
function rendererStub() {
  const calls = { heights: 0, passes: 0, sidesDuringHeights: [] };
  let target = null;
  const renderer = {
    calls,
    autoClear: true,
    shadowMap: {
      enabled: true,
      autoUpdate: false,
      needsUpdate: false,
      render(lights, scene) {
        calls.heights += 1;
        assert.equal(lights.length, 1);
        assert.equal(this.needsUpdate, true, "the probe's own pass is forced");
        scene.traverse((object) => {
          if (object.castShadow && object.material) calls.sidesDuringHeights.push(object.material.shadowSide);
        });
      }
    },
    getRenderTarget() { return target; },
    setRenderTarget(next) { target = next; },
    render() { calls.passes += 1; }
  };
  return renderer;
}

function studio() {
  const scene = new THREE.Scene();
  const keyLight = new THREE.SpotLight(0xffffff, 1);
  keyLight.castShadow = true;
  const contact = createStudioContactShadow(THREE, keyLight);
  scene.add(contact.object);
  const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  part.castShadow = true;
  scene.add(part);
  contact.place({ center: [0, 0, 0], half: 10, floorZ: 0, height: 5 });
  return { scene, keyLight, contact, part, camera: new THREE.PerspectiveCamera() };
}

test("the floor shadow bakes after the key's shadows re-render, never on a camera-only frame", () => {
  const { scene, keyLight, contact, camera } = studio();
  const renderer = rendererStub();
  const frame = () => contact.layer.onBeforeRender(renderer, scene, camera);
  assert.equal(contact.layer.material.uniforms.uReady.value, 0, "nothing shows before the first bake");

  frame();
  assert.equal(renderer.calls.heights, 1);
  assert.equal(renderer.calls.passes, 3, "one prepare and two blur passes");
  assert.equal(contact.layer.material.uniforms.uReady.value, 1);

  // Frames that only moved the camera re-render no shadows: nothing is baked.
  frame();
  frame();
  assert.equal(renderer.calls.heights, 1);

  // The probe's own shadow pass is not a reason to bake again.
  contact.sentinel.onBeforeShadow(renderer, contact.sentinel, camera, contact.probe.shadow.camera);
  frame();
  assert.equal(renderer.calls.heights, 1);

  // The key's shadow pass is.
  contact.sentinel.onBeforeShadow(renderer, contact.sentinel, camera, keyLight.shadow.camera);
  assert.equal(contact.stale, true);
  frame();
  assert.equal(renderer.calls.heights, 2);
  assert.equal(contact.stale, false);
});

test("the bake restores the renderer and draws single-sided casters double-sided for its own pass only", () => {
  const { scene, contact, part, camera } = studio();
  const renderer = rendererStub();
  const previousTarget = { name: "screen-target" };
  renderer.setRenderTarget(previousTarget);
  part.material.shadowSide = null;
  contact.layer.onBeforeRender(renderer, scene, camera);
  assert.ok(renderer.calls.sidesDuringHeights.includes(THREE.DoubleSide));
  assert.equal(part.material.shadowSide, null);
  assert.equal(renderer.getRenderTarget(), previousTarget);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.needsUpdate, false);
  assert.equal(renderer.shadowMap.autoUpdate, false);
});

test("an unchanged placement re-bakes nothing; a moved floor or model does", () => {
  const { scene, contact, camera } = studio();
  const renderer = rendererStub();
  contact.layer.onBeforeRender(renderer, scene, camera);
  contact.place({ center: [0, 0, 0], half: 10, floorZ: 0, height: 5 });
  assert.equal(contact.stale, false);
  contact.place({ center: [0, 0, 0], half: 10, floorZ: -2, height: 5 });
  assert.equal(contact.stale, true);
  assert.equal(contact.layer.position.z, -2);
  assert.ok(contact.layer.scale.x > 20, "the baked square leaves a margin for its faded edge");
  // The probe looks straight up through the floor from just below it.
  const probeCamera = contact.probe.shadow.camera;
  assert.ok(contact.probe.position.z < -2);
  assert.ok(contact.probe.target.position.z > -2);
  assert.equal(probeCamera.right, contact.layer.scale.x / 2);
});

test("a disabled floor shadow hides, and without shadow maps nothing is baked", () => {
  const { scene, contact, camera } = studio();
  const renderer = rendererStub();
  contact.layer.onBeforeRender(renderer, scene, camera);
  contact.setEnabled(false);
  assert.equal(contact.layer.visible, false);
  contact.setEnabled(true);
  assert.equal(contact.layer.visible, true);
  assert.equal(contact.stale, true, "re-enabled after the scene may have changed");

  renderer.shadowMap.enabled = false;
  contact.layer.onBeforeRender(renderer, scene, camera);
  assert.equal(renderer.calls.heights, 1);

  contact.setOpacity(0.25);
  assert.equal(contact.layer.material.uniforms.uOpacity.value, 0.25);
  contact.dispose();
  assert.equal(contact.object.parent, null);
});
