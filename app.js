// app.js — Hand Scene Studio main orchestrator

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { HandViewer3D } from '../hand-pose-studio/hand-viewer-3d.js';
import { SkeletonStore } from '../hand-pose-studio/skeleton-store.js';
import { TimelineEngine } from './timeline.js';
import { SpaceMouse } from './spacemouse.js';

// ── State ──

function defaultHandState(handedness) {
  return {
    handedness,      // which GLB model to use ('Right' or 'Left')
    enabled: handedness === 'Right',
    position: { x: handedness === 'Left' ? -0.15 : 0.15, y: 0.25, z: 0 },
    scale: 2,
    color: '#ffffff',
    curls: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    spread: { thumb: 0.5, index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 },
    wrist: { flex: 0, deviation: 0, pronation: 0 },
    cmc: { flex: 0, sweep: 0, rotation: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
}

const handStates = { Right: defaultHandState('Right'), Left: defaultHandState('Left') };
let selectedHand = 'Right';
function hs() { return handStates[selectedHand]; }

const lightState = {
  intensity: 8,
  angle: 45,
  penumbra: 0.3,
  position: { x: 0, y: 1, z: 1 },
  target: { x: 0, y: 0, z: 0 },
  color: '#ffffff',
  shadowMapSize: 1024,
};

const screenState = {
  width: 2,
  height: 1.5,
  position: { x: 0, y: 0.5, z: -1 },
  color: '#f0f0f0',
};

const sceneState = {
  ambientIntensity: 0.3,
  background: '#0f0f14',
};

let selectedObject = 'hand-Right';

// Per-slot cloned hand groups (independent of originals in viewer3d)
const slotHands = { Right: null, Left: null };

function createSlotHand(handedness) {
  const original = viewer3d.hands[handedness];
  const group = SkeletonUtils.clone(original.group);

  let mesh, forearmMesh;
  group.traverse(child => {
    if (child.isSkinnedMesh) mesh = child;
    else if (child.isMesh && !child.isSkinnedMesh) forearmMesh = child;
  });

  // Enable shadow casting on cloned meshes
  group.traverse(child => {
    if (child.isMesh || child.isSkinnedMesh) child.castShadow = true;
  });

  return { group, mesh, forearmMesh };
}

// ── Timeline State ──

let timeline = null;
let selectedLaneId = null;
let selectedKeyframeIdx = -1;
const PROP_REGISTRY = {};
const OBJECT_PATHS = {};

// ── Three.js refs ──

let scene, camera, renderer, controls;
let ambientLight, spotLight, spotTarget;
let screenMesh, groundPlane;
let viewer3d;
const skeletonStore = new SkeletonStore();

// ── SpaceMouse ──

const spacemouse = new SpaceMouse();
const SM_TRANSLATE_SPEED = 1.5;  // units/sec at sensitivity 1
const SM_ROTATE_SPEED = 2.0;     // rad/sec at sensitivity 1
let lastFrameTime = 0;

// ── DOM refs ──

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Scene Setup ──

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(sceneState.background);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
  camera.position.set(0, 0.5, 1.5);
  camera.lookAt(0, 0.15, 0);

  const viewport = $('#viewport');
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.15, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  // Ambient light
  ambientLight = new THREE.AmbientLight(0xffffff, sceneState.ambientIntensity);
  scene.add(ambientLight);

  // Spot light + target
  spotTarget = new THREE.Object3D();
  spotTarget.position.set(lightState.target.x, lightState.target.y, lightState.target.z);
  scene.add(spotTarget);

  spotLight = new THREE.SpotLight(0xffffff, lightState.intensity);
  spotLight.position.set(lightState.position.x, lightState.position.y, lightState.position.z);
  spotLight.angle = lightState.angle * Math.PI / 180;
  spotLight.penumbra = lightState.penumbra;
  spotLight.castShadow = true;
  spotLight.shadow.mapSize.set(lightState.shadowMapSize, lightState.shadowMapSize);
  spotLight.shadow.bias = -0.001;
  spotLight.shadow.camera.near = 0.1;
  spotLight.shadow.camera.far = 20;
  spotLight.target = spotTarget;
  scene.add(spotLight);

  // Grid helper
  const grid = new THREE.GridHelper(4, 20, 0x333348, 0x222238);
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // Ground plane (receives shadows)
  const groundGeo = new THREE.PlaneGeometry(10, 10);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.4 });
  groundPlane = new THREE.Mesh(groundGeo, groundMat);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.receiveShadow = true;
  scene.add(groundPlane);

  // Projection screen (vertical plane)
  const screenGeo = new THREE.PlaneGeometry(screenState.width, screenState.height);
  const screenMat = new THREE.MeshStandardMaterial({
    color: screenState.color,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  screenMesh = new THREE.Mesh(screenGeo, screenMat);
  screenMesh.position.set(screenState.position.x, screenState.position.y, screenState.position.z);
  screenMesh.receiveShadow = true;
  scene.add(screenMesh);

  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
}

// ── Hand Initialization ──

async function initHands() {
  // Create offscreen container for HandViewer3D (it needs a DOM element)
  const offscreen = document.createElement('div');
  offscreen.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;top:-9999px;overflow:hidden;';
  document.body.appendChild(offscreen);

  viewer3d = new HandViewer3D(offscreen);
  await viewer3d.init();

  // Clone hand meshes for each slot (originals stay offscreen for posing)
  for (const slotKey of ['Right', 'Left']) {
    slotHands[slotKey] = createSlotHand(handStates[slotKey].handedness);
    scene.add(slotHands[slotKey].group);
  }

  // Apply initial pose for both hands
  applyAllHands();

  // Update status
  const statusEl = $('#status-text');
  statusEl.innerHTML = '';
  statusEl.textContent = 'Hand Scene Studio';
  statusEl.classList.remove('loading');

  $('#footer-status').textContent = 'Hand models loaded';
}

// ── Hand Pose ──

function poseOneHand(slotKey) {
  const st = handStates[slotKey];
  const clone = slotHands[slotKey];
  if (!clone) return;

  // Pose the original (offscreen) — resets to rest first
  viewer3d.poseFromMIDI(st.curls, st.spread, st.wrist, {
    handedness: st.handedness,
    cmcFlex: st.cmc.flex,
    thumbSweep: st.cmc.sweep,
    cmcRotation: st.cmc.rotation,
    rotationX: st.rotation.x,
    rotationY: st.rotation.y,
    rotationZ: st.rotation.z,
  });

  const original = viewer3d.hands[st.handedness];

  // Copy bone transforms from original to clone
  const origBones = original.mesh.skeleton.bones;
  const cloneBones = clone.mesh.skeleton.bones;
  for (let i = 0; i < origBones.length; i++) {
    cloneBones[i].quaternion.copy(origBones[i].quaternion);
    cloneBones[i].position.copy(origBones[i].position);
  }

  // Copy group quaternion (baseOrientation + user rotation from poseFromMIDI)
  clone.group.quaternion.copy(original.group.quaternion);

  // Slot-specific position, scale, color
  clone.group.position.set(st.position.x, st.position.y, st.position.z);
  clone.mesh.scale.setScalar(st.scale);
  if (clone.forearmMesh) clone.forearmMesh.scale.setScalar(st.scale);
  const color = new THREE.Color(st.color);
  clone.mesh.material.color.set(color);
  if (clone.forearmMesh) clone.forearmMesh.material.color.set(color);

  clone.group.updateMatrixWorld(true);
  clone.mesh.skeleton.update();
}

function reassertVisibility() {
  for (const slotKey of ['Right', 'Left']) {
    if (slotHands[slotKey]) slotHands[slotKey].group.visible = handStates[slotKey].enabled;
  }
}

function applyAllHands() {
  if (!viewer3d || !viewer3d.ready) return;
  for (const h of ['Right', 'Left']) {
    if (handStates[h].enabled) poseOneHand(h);
  }
  reassertVisibility();
}

function applySelectedHand() {
  if (!viewer3d || !viewer3d.ready) return;
  poseOneHand(selectedHand);
  reassertVisibility();
}

// ── Pose Mirroring ──

function mirrorPoseParams(st) {
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    st.spread[finger] = 1 - st.spread[finger];
  }
  st.wrist.deviation = -st.wrist.deviation;
  st.wrist.pronation = -st.wrist.pronation;
  st.cmc.sweep = -st.cmc.sweep;
  st.cmc.rotation = -st.cmc.rotation;
  st.rotation.y = -st.rotation.y;
  st.rotation.z = -st.rotation.z;
}

// ── Light ──

function updateLight() {
  spotLight.intensity = lightState.intensity;
  spotLight.angle = lightState.angle * Math.PI / 180;
  spotLight.penumbra = lightState.penumbra;
  spotLight.position.set(lightState.position.x, lightState.position.y, lightState.position.z);
  spotLight.color.set(lightState.color);
  spotTarget.position.set(lightState.target.x, lightState.target.y, lightState.target.z);

  const size = lightState.shadowMapSize;
  if (spotLight.shadow.mapSize.x !== size) {
    spotLight.shadow.mapSize.set(size, size);
    if (spotLight.shadow.map) {
      spotLight.shadow.map.dispose();
      spotLight.shadow.map = null;
    }
  }
}

// ── Screen ──

function updateScreen() {
  // Only recreate geometry if dimensions changed
  const params = screenMesh.geometry.parameters;
  if (params.width !== screenState.width || params.height !== screenState.height) {
    screenMesh.geometry.dispose();
    screenMesh.geometry = new THREE.PlaneGeometry(screenState.width, screenState.height);
  }
  screenMesh.position.set(screenState.position.x, screenState.position.y, screenState.position.z);
  screenMesh.material.color.set(screenState.color);
}

// ── Ambient ──

function updateAmbient() {
  ambientLight.intensity = sceneState.ambientIntensity;
  scene.background = new THREE.Color(sceneState.background);
}

// ── Object List ──

const sceneObjects = [
  { id: 'hand-Right', slotKey: 'Right', icon: '\u{1F91A}' },
  { id: 'hand-Left',  slotKey: 'Left',  icon: '\u{1F91A}' },
  { id: 'light', label: 'Spot Light', icon: '\u{1F4A1}' },
  { id: 'screen', label: 'Screen', icon: '\u{1F5A5}' },
  { id: 'scene', label: 'Scene', icon: '\u{1F3AC}' },
  { id: 'camera', label: 'Camera', icon: '\u{1F4F7}' },
];

function buildObjectList() {
  const list = $('#object-list');
  list.innerHTML = '';
  for (const obj of sceneObjects) {
    const item = document.createElement('div');
    item.className = 'object-item' + (selectedObject === obj.id ? ' selected' : '');

    if (obj.slotKey) {
      const st = handStates[obj.slotKey];
      const eyeIcon = st.enabled ? '\u{1F441}' : '\u{1F441}\u200D\u{1F5E8}';
      const label = `Hand (${st.handedness})`;

      item.innerHTML = `<span class="icon">${obj.icon}</span><span class="label">${label}</span><span class="visibility-toggle">${eyeIcon}</span>`;

      // Eye toggle — toggle enabled, rebuild list, apply
      item.querySelector('.visibility-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        st.enabled = !st.enabled;
        applyAllHands();
        buildObjectList();
      });

      // Body click — select this hand for editing
      item.addEventListener('click', () => {
        selectedObject = obj.id;
        selectedHand = obj.slotKey;
        syncAllHandSliders();
        buildObjectList();
        showPropertiesFor(obj.id);
      });
    } else {
      item.innerHTML = `<span class="icon">${obj.icon}</span><span class="label">${obj.label}</span>`;
      item.addEventListener('click', () => {
        selectedObject = obj.id;
        buildObjectList();
        showPropertiesFor(obj.id);
      });
    }

    list.appendChild(item);
  }
}

function showPropertiesFor(id) {
  for (const panel of $$('.props-panel')) {
    panel.classList.remove('active');
  }
  // Both hand-Right and hand-Left map to the same props-hand panel
  const panelId = id.startsWith('hand-') ? 'hand' : id;
  const target = $(`#props-${panelId}`);
  if (target) target.classList.add('active');
}

// ── Landmarks → MIDI Conversion ──

function landmarksToMIDI(landmarks) {
  const lm = landmarks;
  const v3 = (i) => ({ x: lm[i].x, y: lm[i].y, z: lm[i].z || 0 });
  const dist = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
  const sub = (a, b) => ({ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z });
  const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
  const len = (a) => Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
  const norm = (a) => { const l = len(a); return l > 1e-8 ? { x: a.x/l, y: a.y/l, z: a.z/l } : { x:0, y:0, z:0 }; };
  const cross = (a, b) => ({ x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x });

  // Finger curl: ratio of direct MCP→TIP distance vs sum-of-segments
  const fingerDef = {
    thumb:  [1, 2, 3, 4],
    index:  [5, 6, 7, 8],
    middle: [9, 10, 11, 12],
    ring:   [13, 14, 15, 16],
    pinky:  [17, 18, 19, 20],
  };

  const curls = {};
  for (const [name, idx] of Object.entries(fingerDef)) {
    const pts = idx.map(v3);
    const segLen = dist(pts[0], pts[1]) + dist(pts[1], pts[2]) + dist(pts[2], pts[3]);
    const direct = dist(pts[0], pts[3]);
    const ratio = segLen > 1e-6 ? direct / segLen : 1;
    curls[name] = Math.max(0, Math.min(1, 1 - ratio));
  }

  // Finger spread
  const wrist = v3(0);
  const idxMcp = v3(5), midMcp = v3(9), ringMcp = v3(13), pnkMcp = v3(17);
  const palmNorm = norm(cross(sub(pnkMcp, wrist), sub(idxMcp, wrist)));
  const midDir = norm(sub(v3(12), midMcp));

  const spread = {};
  for (const [name, idx] of Object.entries(fingerDef)) {
    const dir = norm(sub(v3(idx[3]), v3(idx[0])));
    const projDir = norm(sub(dir, { x: palmNorm.x * dot(dir, palmNorm), y: palmNorm.y * dot(dir, palmNorm), z: palmNorm.z * dot(dir, palmNorm) }));
    const projMid = norm(sub(midDir, { x: palmNorm.x * dot(midDir, palmNorm), y: palmNorm.y * dot(midDir, palmNorm), z: palmNorm.z * dot(midDir, palmNorm) }));

    let angle = Math.acos(Math.max(-1, Math.min(1, dot(projDir, projMid))));
    const c = cross(projMid, projDir);
    if (dot(c, palmNorm) < 0) angle = -angle;

    spread[name] = Math.max(0, Math.min(1, 0.5 + angle / (Math.PI / 6)));
  }

  const wristParams = { flex: 0, deviation: 0, pronation: 0 };
  return { curls, spread, wrist: wristParams };
}

// ── Controls Wiring ──

function bindRange(id, getter, setter) {
  const input = $(`#${id}`);
  if (!input) return;
  const display = $(`.value[data-for="${id}"]`);

  const updateDisplay = () => {
    if (!display) return;
    const v = getter();
    if (id.startsWith('light-angle')) {
      display.textContent = `${Math.round(v)}\u00B0`;
    } else if (Number.isInteger(v)) {
      display.textContent = String(v);
    } else {
      display.textContent = v.toFixed(2);
    }
  };

  input.addEventListener('input', () => {
    setter(parseFloat(input.value));
    updateDisplay();
  });

  // Sync initial display
  updateDisplay();
}

// Update a slider element + its display to match current state
function syncSlider(id, value) {
  const input = $(`#${id}`);
  if (!input) return;
  input.value = value;
  const display = $(`.value[data-for="${id}"]`);
  if (!display) return;
  if (id.startsWith('light-angle')) {
    display.textContent = `${Math.round(value)}\u00B0`;
  } else if (Number.isInteger(value)) {
    display.textContent = String(value);
  } else {
    display.textContent = Number(value).toFixed(2);
  }
}

function syncAllHandSliders() {
  const s = hs();
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    syncSlider(`curl-${finger}`, s.curls[finger]);
    syncSlider(`spread-${finger}`, s.spread[finger]);
  }
  syncSlider('cmc-flex', s.cmc.flex);
  syncSlider('thumb-sweep', s.cmc.sweep);
  syncSlider('cmc-rotation', s.cmc.rotation);
  syncSlider('wrist-flex', s.wrist.flex);
  syncSlider('wrist-deviation', s.wrist.deviation);
  syncSlider('wrist-pronation', s.wrist.pronation);
  syncSlider('hand-rot-x', s.rotation.x);
  syncSlider('hand-rot-y', s.rotation.y);
  syncSlider('hand-rot-z', s.rotation.z);
  syncSlider('hand-pos-x', s.position.x);
  syncSlider('hand-pos-y', s.position.y);
  syncSlider('hand-pos-z', s.position.z);
  syncSlider('hand-scale', s.scale);
  $('#hand-color').value = s.color;
  // Sync handedness toggle buttons
  for (const b of $$('.toggle-group [data-hand]')) {
    b.classList.toggle('active', b.dataset.hand === s.handedness);
  }
  const title = $('#hand-panel-title');
  if (title) title.textContent = `Hand (${s.handedness})`;
}

function syncLightSliders() {
  syncSlider('light-intensity', lightState.intensity);
  syncSlider('light-angle', lightState.angle);
  syncSlider('light-penumbra', lightState.penumbra);
  syncSlider('light-pos-x', lightState.position.x);
  syncSlider('light-pos-y', lightState.position.y);
  syncSlider('light-pos-z', lightState.position.z);
  syncSlider('light-target-x', lightState.target.x);
  syncSlider('light-target-y', lightState.target.y);
  syncSlider('light-target-z', lightState.target.z);
  $('#light-color').value = lightState.color;
}

function syncScreenSliders() {
  syncSlider('screen-width', screenState.width);
  syncSlider('screen-height', screenState.height);
  syncSlider('screen-pos-x', screenState.position.x);
  syncSlider('screen-pos-y', screenState.position.y);
  syncSlider('screen-pos-z', screenState.position.z);
  $('#screen-color').value = screenState.color;
}

function syncCameraSliders() {
  syncSlider('cam-pos-x', camera.position.x);
  syncSlider('cam-pos-y', camera.position.y);
  syncSlider('cam-pos-z', camera.position.z);
  syncSlider('cam-target-x', controls.target.x);
  syncSlider('cam-target-y', controls.target.y);
  syncSlider('cam-target-z', controls.target.z);
}

function syncSceneSliders() {
  syncSlider('ambient-intensity', sceneState.ambientIntensity);
  $('#scene-bg').value = sceneState.background;
}

function wireControls() {
  // ── Handedness toggle ──
  for (const btn of $$('.toggle-group [data-hand]')) {
    btn.addEventListener('click', () => {
      const newHandedness = btn.dataset.hand;
      const st = hs();
      if (st.handedness === newHandedness) return;

      // Mirror pose params so pose looks correct on the new GLB model
      mirrorPoseParams(st);
      st.handedness = newHandedness;

      // Remove old clone, create new from the new GLB
      scene.remove(slotHands[selectedHand].group);
      slotHands[selectedHand] = createSlotHand(newHandedness);
      scene.add(slotHands[selectedHand].group);

      syncAllHandSliders();
      applySelectedHand();
      buildObjectList();
    });
  }

  // ── Hand position ──
  bindRange('hand-pos-x', () => hs().position.x, (v) => { hs().position.x = v; applySelectedHand(); });
  bindRange('hand-pos-y', () => hs().position.y, (v) => { hs().position.y = v; applySelectedHand(); });
  bindRange('hand-pos-z', () => hs().position.z, (v) => { hs().position.z = v; applySelectedHand(); });
  bindRange('hand-scale', () => hs().scale, (v) => { hs().scale = v; applySelectedHand(); });

  // ── Hand color ──
  $('#hand-color').addEventListener('input', (e) => {
    hs().color = e.target.value;
    applySelectedHand();
  });

  // ── Finger curls ──
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    bindRange(`curl-${finger}`, () => hs().curls[finger], (v) => { hs().curls[finger] = v; applySelectedHand(); });
    bindRange(`spread-${finger}`, () => hs().spread[finger], (v) => { hs().spread[finger] = v; applySelectedHand(); });
  }

  // ── CMC ──
  bindRange('cmc-flex', () => hs().cmc.flex, (v) => { hs().cmc.flex = v; applySelectedHand(); });
  bindRange('thumb-sweep', () => hs().cmc.sweep, (v) => { hs().cmc.sweep = v; applySelectedHand(); });
  bindRange('cmc-rotation', () => hs().cmc.rotation, (v) => { hs().cmc.rotation = v; applySelectedHand(); });

  // ── Wrist ──
  bindRange('wrist-flex', () => hs().wrist.flex, (v) => { hs().wrist.flex = v; applySelectedHand(); });
  bindRange('wrist-deviation', () => hs().wrist.deviation, (v) => { hs().wrist.deviation = v; applySelectedHand(); });
  bindRange('wrist-pronation', () => hs().wrist.pronation, (v) => { hs().wrist.pronation = v; applySelectedHand(); });

  // ── Rotation ──
  bindRange('hand-rot-x', () => hs().rotation.x, (v) => { hs().rotation.x = v; applySelectedHand(); });
  bindRange('hand-rot-y', () => hs().rotation.y, (v) => { hs().rotation.y = v; applySelectedHand(); });
  bindRange('hand-rot-z', () => hs().rotation.z, (v) => { hs().rotation.z = v; applySelectedHand(); });

  // ── Light ──
  bindRange('light-intensity', () => lightState.intensity, (v) => { lightState.intensity = v; updateLight(); });
  bindRange('light-angle', () => lightState.angle, (v) => { lightState.angle = v; updateLight(); });
  bindRange('light-penumbra', () => lightState.penumbra, (v) => { lightState.penumbra = v; updateLight(); });
  bindRange('light-pos-x', () => lightState.position.x, (v) => { lightState.position.x = v; updateLight(); });
  bindRange('light-pos-y', () => lightState.position.y, (v) => { lightState.position.y = v; updateLight(); });
  bindRange('light-pos-z', () => lightState.position.z, (v) => { lightState.position.z = v; updateLight(); });
  bindRange('light-target-x', () => lightState.target.x, (v) => { lightState.target.x = v; updateLight(); });
  bindRange('light-target-y', () => lightState.target.y, (v) => { lightState.target.y = v; updateLight(); });
  bindRange('light-target-z', () => lightState.target.z, (v) => { lightState.target.z = v; updateLight(); });

  $('#light-color').addEventListener('input', (e) => {
    lightState.color = e.target.value;
    updateLight();
  });

  $('#light-shadow-size').addEventListener('change', (e) => {
    lightState.shadowMapSize = parseInt(e.target.value);
    updateLight();
  });

  // ── Screen ──
  bindRange('screen-width', () => screenState.width, (v) => { screenState.width = v; updateScreen(); });
  bindRange('screen-height', () => screenState.height, (v) => { screenState.height = v; updateScreen(); });
  bindRange('screen-pos-x', () => screenState.position.x, (v) => { screenState.position.x = v; updateScreen(); });
  bindRange('screen-pos-y', () => screenState.position.y, (v) => { screenState.position.y = v; updateScreen(); });
  bindRange('screen-pos-z', () => screenState.position.z, (v) => { screenState.position.z = v; updateScreen(); });

  $('#screen-color').addEventListener('input', (e) => {
    screenState.color = e.target.value;
    updateScreen();
  });

  // ── Camera ──
  bindRange('cam-pos-x', () => camera.position.x, (v) => { camera.position.x = v; controls.update(); });
  bindRange('cam-pos-y', () => camera.position.y, (v) => { camera.position.y = v; controls.update(); });
  bindRange('cam-pos-z', () => camera.position.z, (v) => { camera.position.z = v; controls.update(); });
  bindRange('cam-target-x', () => controls.target.x, (v) => { controls.target.x = v; controls.update(); });
  bindRange('cam-target-y', () => controls.target.y, (v) => { controls.target.y = v; controls.update(); });
  bindRange('cam-target-z', () => controls.target.z, (v) => { controls.target.z = v; controls.update(); });

  // Camera presets
  const camPresets = {
    home:  { pos: [0, 0.5, 1.5],   target: [0, 0.15, 0] },
    front: { pos: [0, 0.5, 2.5],   target: [0, 0.25, 0] },
    top:   { pos: [0, 3, 0.01],    target: [0, 0, 0] },
    right: { pos: [2.5, 0.5, 0],   target: [0, 0.25, 0] },
  };
  for (const btn of $$('[data-cam-preset]')) {
    btn.addEventListener('click', () => {
      const preset = camPresets[btn.dataset.camPreset];
      if (!preset) return;
      camera.position.set(...preset.pos);
      controls.target.set(...preset.target);
      controls.update();
      syncCameraSliders();
    });
  }

  // ── SpaceMouse ──
  const smDot = $('#spacemouse-dot');
  const smLabel = $('#spacemouse-label');
  const smBtn = $('#spacemouse-connect');

  spacemouse.onStatus = (connected, name) => {
    smDot.classList.toggle('connected', connected);
    smLabel.textContent = connected ? `SpaceMouse: ${name}` : 'SpaceMouse: not detected';
    smBtn.textContent = connected ? 'Connected' : 'Connect';
    smBtn.disabled = connected;
  };

  smBtn.addEventListener('click', async () => {
    try {
      await spacemouse.connect();
    } catch (err) {
      if (err.name === 'NotFoundError') return; // user cancelled picker
      console.error('SpaceMouse connect failed:', err);
      if (err.name === 'NotAllowedError') {
        smLabel.textContent = 'Quit 3DxWare first (Activity Monitor → 3DxService)';
      } else {
        smLabel.textContent = `SpaceMouse: ${err.message}`;
      }
    }
  });

  const speedSlider = $('#spacemouse-speed');
  const speedDisplay = $(`.value[data-for="spacemouse-speed"]`);
  speedSlider.addEventListener('input', () => {
    spacemouse.sensitivity = parseFloat(speedSlider.value);
    speedDisplay.textContent = spacemouse.sensitivity.toFixed(1);
  });

  // ── Scene ──
  bindRange('ambient-intensity', () => sceneState.ambientIntensity, (v) => { sceneState.ambientIntensity = v; updateAmbient(); });

  $('#scene-bg').addEventListener('input', (e) => {
    sceneState.background = e.target.value;
    updateAmbient();
  });

  // ── PNG Export ──
  $('#btn-export-png').addEventListener('click', exportPNG);

  // ── Save / Load Scene ──
  $('#btn-save-scene').addEventListener('click', saveScene);
  $('#btn-load-scene').addEventListener('click', async () => {
    // Use File System Access API if available for open dialog
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JSON Scene File', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        loadScene(await file.text());
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Fall through to input element
      }
    }
    $('#file-scene').click();
  });
  $('#file-scene').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      loadScene(await file.text());
    } catch (err) {
      console.error('Failed to load scene:', err);
      $('#footer-status').textContent = 'Failed to load scene file';
    }
    e.target.value = '';
  });
}

// ── Pose Library ──

function wireLibrary() {
  const fileInput = $('#file-library');
  $('#btn-load-library').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Library format: { skeletons: [...] } or raw array
      const skeletons = Array.isArray(data) ? data : (data.skeletons || []);
      skeletonStore.mergeFromLibrary(skeletons);
      renderSkeletonList();
      $('#footer-status').textContent = `Loaded ${skeletons.length} poses from ${file.name}`;
    } catch (err) {
      console.error('Failed to load library:', err);
      $('#footer-status').textContent = 'Failed to load library file';
    }

    // Reset so same file can be loaded again
    fileInput.value = '';
  });
}

function renderSkeletonList() {
  const list = $('#skeleton-list');
  const all = skeletonStore.getAll();

  if (all.length === 0) {
    list.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; padding: 4px;">No library loaded</div>';
    return;
  }

  list.innerHTML = '';
  for (const skeleton of all) {
    const item = document.createElement('div');
    item.className = 'skeleton-item';
    item.textContent = skeleton.label || `Pose ${skeleton.id}`;
    item.addEventListener('click', () => {
      const s = hs();

      if (skeleton.poseParams) {
        // Use poseFromMIDI with stored parameters — perfect reproduction
        const p = skeleton.poseParams;
        s.curls = { ...p.curls };
        s.spread = { ...p.spread };
        s.wrist = {
          flex: p.wristFlex ?? 0,
          deviation: p.wristDeviation ?? 0,
          pronation: p.wristPronation ?? 0,
        };
        s.cmc = {
          flex: p.cmcFlex ?? 0,
          sweep: p.thumbSweep ?? 0,
          rotation: p.cmcRotation ?? 0,
        };
        syncAllHandSliders();
        applySelectedHand();
      } else {
        // Fallback: poseFromLandmarks for legacy skeletons without MIDI data
        viewer3d.poseFromLandmarks(skeleton.landmarks, {
          handedness: s.handedness,
        });

        // Copy bone transforms from original to clone
        const original = viewer3d.hands[s.handedness];
        const clone = slotHands[selectedHand];
        if (original && clone) {
          const origBones = original.mesh.skeleton.bones;
          const cloneBones = clone.mesh.skeleton.bones;
          for (let i = 0; i < origBones.length; i++) {
            cloneBones[i].quaternion.copy(origBones[i].quaternion);
            cloneBones[i].position.copy(origBones[i].position);
          }
          clone.group.quaternion.copy(original.group.quaternion);
          clone.group.position.set(s.position.x, s.position.y, s.position.z);
          clone.mesh.scale.setScalar(s.scale);
          if (clone.forearmMesh) clone.forearmMesh.scale.setScalar(s.scale);
          const color = new THREE.Color(s.color);
          clone.mesh.material.color.set(color);
          if (clone.forearmMesh) clone.forearmMesh.material.color.set(color);
          clone.group.updateMatrixWorld(true);
          clone.mesh.skeleton.update();
        }

        reassertVisibility();

        // Update sliders with approximate MIDI values for display
        const midi = landmarksToMIDI(skeleton.landmarks);
        s.curls = midi.curls;
        s.spread = midi.spread;
        s.wrist = midi.wrist;
        s.cmc = { flex: 0, sweep: 0, rotation: 0 };
        syncAllHandSliders();
      }

      // Highlight active
      for (const el of list.querySelectorAll('.skeleton-item')) el.classList.remove('active');
      item.classList.add('active');

      $('#footer-status').textContent = `Applied pose: ${skeleton.label || skeleton.id}`;
    });
    list.appendChild(item);
  }
}

// ── Property Registry ──

function buildPropRegistry() {
  // Hand properties (Right + Left)
  for (const slotKey of ['Right', 'Left']) {
    const prefix = `hand.${slotKey}`;
    const apply = () => poseOneHand(slotKey);

    for (const axis of ['x', 'y', 'z']) {
      PROP_REGISTRY[`${prefix}.position.${axis}`] = {
        state: () => handStates[slotKey], keys: ['position', axis], apply,
      };
    }

    PROP_REGISTRY[`${prefix}.scale`] = {
      state: () => handStates[slotKey], keys: ['scale'], apply,
    };

    PROP_REGISTRY[`${prefix}.color`] = {
      state: () => handStates[slotKey], keys: ['color'], apply,
    };

    for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      PROP_REGISTRY[`${prefix}.curls.${finger}`] = {
        state: () => handStates[slotKey], keys: ['curls', finger], apply,
      };
      PROP_REGISTRY[`${prefix}.spread.${finger}`] = {
        state: () => handStates[slotKey], keys: ['spread', finger], apply,
      };
    }

    for (const param of ['flex', 'deviation', 'pronation']) {
      PROP_REGISTRY[`${prefix}.wrist.${param}`] = {
        state: () => handStates[slotKey], keys: ['wrist', param], apply,
      };
    }

    for (const param of ['flex', 'sweep', 'rotation']) {
      PROP_REGISTRY[`${prefix}.cmc.${param}`] = {
        state: () => handStates[slotKey], keys: ['cmc', param], apply,
      };
    }

    for (const axis of ['x', 'y', 'z']) {
      PROP_REGISTRY[`${prefix}.rotation.${axis}`] = {
        state: () => handStates[slotKey], keys: ['rotation', axis], apply,
      };
    }
  }

  // Light
  PROP_REGISTRY['light.intensity'] = { state: () => lightState, keys: ['intensity'], apply: updateLight };
  PROP_REGISTRY['light.angle'] = { state: () => lightState, keys: ['angle'], apply: updateLight };
  PROP_REGISTRY['light.penumbra'] = { state: () => lightState, keys: ['penumbra'], apply: updateLight };
  PROP_REGISTRY['light.color'] = { state: () => lightState, keys: ['color'], apply: updateLight };
  for (const axis of ['x', 'y', 'z']) {
    PROP_REGISTRY[`light.position.${axis}`] = { state: () => lightState, keys: ['position', axis], apply: updateLight };
    PROP_REGISTRY[`light.target.${axis}`] = { state: () => lightState, keys: ['target', axis], apply: updateLight };
  }

  // Screen
  PROP_REGISTRY['screen.width'] = { state: () => screenState, keys: ['width'], apply: updateScreen };
  PROP_REGISTRY['screen.height'] = { state: () => screenState, keys: ['height'], apply: updateScreen };
  PROP_REGISTRY['screen.color'] = { state: () => screenState, keys: ['color'], apply: updateScreen };
  for (const axis of ['x', 'y', 'z']) {
    PROP_REGISTRY[`screen.position.${axis}`] = { state: () => screenState, keys: ['position', axis], apply: updateScreen };
  }

  // Scene
  PROP_REGISTRY['scene.ambientIntensity'] = { state: () => sceneState, keys: ['ambientIntensity'], apply: updateAmbient };
  PROP_REGISTRY['scene.background'] = { state: () => sceneState, keys: ['background'], apply: updateAmbient };

  // Camera
  for (const axis of ['x', 'y', 'z']) {
    PROP_REGISTRY[`camera.position.${axis}`] = {
      state: () => camera.position, keys: [axis], apply: () => controls.update(),
    };
    PROP_REGISTRY[`camera.target.${axis}`] = {
      state: () => controls.target, keys: [axis], apply: () => controls.update(),
    };
  }

  // Build OBJECT_PATHS (keyed by selectedObject IDs)
  OBJECT_PATHS['hand-Right'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('hand.Right.'));
  OBJECT_PATHS['hand-Left'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('hand.Left.'));
  OBJECT_PATHS['light'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('light.'));
  OBJECT_PATHS['screen'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('screen.'));
  OBJECT_PATHS['scene'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('scene.'));
  OBJECT_PATHS['camera'] = Object.keys(PROP_REGISTRY).filter(p => p.startsWith('camera.'));
}

function readProp(path) {
  const entry = PROP_REGISTRY[path];
  if (!entry) return undefined;
  let obj = entry.state();
  for (const key of entry.keys) {
    obj = obj[key];
  }
  return obj;
}

function writeProp(path, value) {
  const entry = PROP_REGISTRY[path];
  if (!entry) return;
  let obj = entry.state();
  for (let i = 0; i < entry.keys.length - 1; i++) {
    obj = obj[entry.keys[i]];
  }
  obj[entry.keys[entry.keys.length - 1]] = value;
}

// ── Animation Frame Application ──

function applyAnimationFrame(time) {
  const merged = timeline.resolveAtTime(time);

  const applyFns = new Set();
  let cameraAnimated = false;

  for (const [path, value] of Object.entries(merged)) {
    writeProp(path, value);
    const entry = PROP_REGISTRY[path];
    if (entry) {
      applyFns.add(entry.apply);
      if (path.startsWith('camera.')) cameraAnimated = true;
    }
  }

  for (const fn of applyFns) fn();
  reassertVisibility();

  // Sync sliders for whichever object is selected
  if (selectedObject.startsWith('hand-')) syncAllHandSliders();
  else if (selectedObject === 'light') syncLightSliders();
  else if (selectedObject === 'screen') syncScreenSliders();
  else if (selectedObject === 'scene') syncSceneSliders();
  else if (selectedObject === 'camera') syncCameraSliders();

  updatePlayhead(time);

  // Update play button if playback ended
  if (!timeline.playing) {
    $('#btn-play').textContent = '\u25B6';
  }

  // Disable orbit controls while camera is being animated
  if (controls) controls.enabled = !cameraAnimated;
}

// ── Property Capture Groups ──

function getCaptureGroups(objectId) {
  if (objectId.startsWith('hand-')) {
    const slotKey = objectId === 'hand-Right' ? 'Right' : 'Left';
    const p = `hand.${slotKey}`;
    return [
      { id: 'curls', label: 'Curls', paths: ['thumb','index','middle','ring','pinky'].map(f => `${p}.curls.${f}`) },
      { id: 'spread', label: 'Spread', paths: ['thumb','index','middle','ring','pinky'].map(f => `${p}.spread.${f}`) },
      { id: 'wrist', label: 'Wrist', paths: [`${p}.wrist.flex`, `${p}.wrist.deviation`, `${p}.wrist.pronation`] },
      { id: 'cmc', label: 'CMC', paths: [`${p}.cmc.flex`, `${p}.cmc.sweep`, `${p}.cmc.rotation`] },
      { id: 'position', label: 'Position', paths: ['x','y','z'].map(a => `${p}.position.${a}`) },
      { id: 'rotation', label: 'Rotation', paths: ['x','y','z'].map(a => `${p}.rotation.${a}`) },
      { id: 'scale', label: 'Scale', paths: [`${p}.scale`] },
      { id: 'color', label: 'Color', paths: [`${p}.color`] },
    ];
  }
  if (objectId === 'light') {
    return [
      { id: 'settings', label: 'Settings', paths: ['light.intensity', 'light.angle', 'light.penumbra'] },
      { id: 'color', label: 'Color', paths: ['light.color'] },
      { id: 'position', label: 'Position', paths: ['x','y','z'].map(a => `light.position.${a}`) },
      { id: 'target', label: 'Target', paths: ['x','y','z'].map(a => `light.target.${a}`) },
    ];
  }
  if (objectId === 'screen') {
    return [
      { id: 'size', label: 'Size', paths: ['screen.width', 'screen.height'] },
      { id: 'color', label: 'Color', paths: ['screen.color'] },
      { id: 'position', label: 'Position', paths: ['x','y','z'].map(a => `screen.position.${a}`) },
    ];
  }
  if (objectId === 'scene') {
    return [
      { id: 'ambient', label: 'Ambient', paths: ['scene.ambientIntensity'] },
      { id: 'background', label: 'Background', paths: ['scene.background'] },
    ];
  }
  if (objectId === 'camera') {
    return [
      { id: 'position', label: 'Position', paths: ['x','y','z'].map(a => `camera.position.${a}`) },
      { id: 'target', label: 'Target', paths: ['x','y','z'].map(a => `camera.target.${a}`) },
    ];
  }
  return [];
}

function objectDisplayName(objectId) {
  if (objectId === 'hand-Right') return 'Right Hand';
  if (objectId === 'hand-Left') return 'Left Hand';
  const obj = sceneObjects.find(o => o.id === objectId);
  return obj?.label || objectId;
}

// ── Keyframe Capture ──

function captureKeyframe() {
  if (!timeline) return;

  // Auto-create lane if none exist
  if (timeline.lanes.length === 0) {
    const lane = timeline.addLane();
    selectedLaneId = lane.id;
  }

  // Auto-select first lane if none selected
  if (!selectedLaneId || !timeline.getLane(selectedLaneId)) {
    selectedLaneId = timeline.lanes[0].id;
  }

  const lane = timeline.getLane(selectedLaneId);

  // If lane has no capture filter, show dialog to configure it
  if (!lane.captureFilter) {
    showCaptureDialog(lane);
    return;
  }

  doCaptureKeyframe(lane);
}

function doCaptureKeyframe(lane) {
  const filter = lane.captureFilter;
  const groups = getCaptureGroups(filter.objectId);
  const activeGroups = groups.filter(g => filter.groupIds.includes(g.id));

  const properties = {};
  for (const group of activeGroups) {
    for (const path of group.paths) {
      properties[path] = readProp(path);
    }
  }

  timeline.addKeyframe(lane.id, timeline.currentTime, properties);
  renderTimeline();
  $('#footer-status').textContent = `Keyframe added at ${timeline.currentTime.toFixed(2)}s`;
}

// ── Capture Dialog ──

function showCaptureDialog(lane) {
  const groups = getCaptureGroups(selectedObject);
  if (groups.length === 0) return;

  const dialog = $('#capture-dialog');
  const container = $('#capture-groups');
  container.innerHTML = '';

  // Pre-check from existing filter, or all checked for new
  const existingIds = lane.captureFilter?.groupIds || [];

  for (const group of groups) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = group.id;
    cb.checked = existingIds.length > 0 ? existingIds.includes(group.id) : true;
    lbl.append(cb, ` ${group.label}`);
    container.appendChild(lbl);
  }

  dialog.classList.add('open');

  $('#capture-confirm').onclick = () => {
    const checked = [...container.querySelectorAll('input:checked')].map(el => el.value);
    if (checked.length === 0) {
      hideCaptureDialog();
      return;
    }

    lane.captureFilter = { objectId: selectedObject, groupIds: checked };

    // Auto-name lane if still using default label
    if (lane.label.match(/^Lane \d+$/)) {
      const objName = objectDisplayName(selectedObject);
      const groupLabels = groups.filter(g => checked.includes(g.id)).map(g => g.label);
      if (groupLabels.length === groups.length) {
        lane.label = objName;
      } else {
        const joined = groupLabels.join(', ');
        lane.label = joined.length > 22 ? `${objName}: ${groupLabels.length} groups` : `${objName}: ${joined}`;
      }
      timeline.setLaneLabel(lane.id, lane.label);
    }

    hideCaptureDialog();
    doCaptureKeyframe(lane);
  };

  $('#capture-cancel').onclick = () => {
    hideCaptureDialog();
  };
}

function hideCaptureDialog() {
  $('#capture-dialog').classList.remove('open');
}

// ── Timeline UI ──

function renderTimeline() {
  const container = $('#timeline-lanes');
  container.innerHTML = '';

  for (const lane of timeline.lanes) {
    const row = document.createElement('div');
    row.className = 'timeline-lane' + (selectedLaneId === lane.id ? ' selected' : '');
    row.dataset.laneId = lane.id;

    // Lane header
    const header = document.createElement('div');
    header.className = 'lane-header';

    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.checked = lane.enabled;
    enableCb.className = 'lane-enable';
    enableCb.addEventListener('change', () => {
      timeline.setLaneEnabled(lane.id, enableCb.checked);
    });

    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = lane.label;
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      label.contentEditable = true;
      label.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(label);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    label.addEventListener('blur', () => {
      label.contentEditable = false;
      timeline.setLaneLabel(lane.id, label.textContent.trim() || lane.label);
    });
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
    });

    // Reorder arrows
    const arrows = document.createElement('span');
    arrows.className = 'lane-arrows';
    const upArr = document.createElement('span');
    upArr.textContent = '\u25B2';
    upArr.addEventListener('click', (e) => {
      e.stopPropagation();
      timeline.moveLaneUp(lane.id);
      renderTimeline();
    });
    const downArr = document.createElement('span');
    downArr.textContent = '\u25BC';
    downArr.addEventListener('click', (e) => {
      e.stopPropagation();
      timeline.moveLaneDown(lane.id);
      renderTimeline();
    });
    arrows.append(upArr, downArr);

    const del = document.createElement('span');
    del.className = 'lane-delete';
    del.textContent = '\u2715';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      timeline.removeLane(lane.id);
      if (selectedLaneId === lane.id) {
        selectedLaneId = timeline.lanes.length > 0 ? timeline.lanes[0].id : null;
      }
      selectedKeyframeIdx = -1;
      renderTimeline();
    });

    // Click header to select lane
    header.addEventListener('click', (e) => {
      if (e.target.closest('.lane-arrows') || e.target === enableCb || e.target === del || label.contentEditable === 'true') return;
      selectedLaneId = lane.id;
      selectedKeyframeIdx = -1;
      renderTimeline();
    });

    header.append(enableCb, label, arrows, del);

    // Track bar
    const track = document.createElement('div');
    track.className = 'lane-track';

    // Keyframe markers
    for (let i = 0; i < lane.keyframes.length; i++) {
      const kf = lane.keyframes[i];
      const marker = document.createElement('div');
      marker.className = 'keyframe-marker';
      if (selectedLaneId === lane.id && selectedKeyframeIdx === i) {
        marker.classList.add('selected');
      }
      marker.style.left = `${(kf.time / timeline.duration) * 100}%`;
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedLaneId = lane.id;
        selectedKeyframeIdx = i;
        renderTimeline();
      });
      track.appendChild(marker);
    }

    // Playhead
    const playhead = document.createElement('div');
    playhead.className = 'timeline-playhead';
    playhead.style.left = `${(timeline.currentTime / timeline.duration) * 100}%`;
    track.appendChild(playhead);

    // Click/drag on track to scrub
    track.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('keyframe-marker')) return;
      selectedLaneId = lane.id;
      const scrub = (ev) => {
        const rect = track.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        timeline.seek(pct * timeline.duration);
      };
      scrub(e);
      const onMove = (ev) => scrub(ev);
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    row.append(header, track);
    container.appendChild(row);
  }

  updateKeyframeInfo();
}

function updatePlayhead(time) {
  const pct = `${(time / timeline.duration) * 100}%`;
  for (const ph of document.querySelectorAll('.timeline-playhead')) {
    ph.style.left = pct;
  }
  const timeEl = $('#timeline-time');
  if (timeEl) timeEl.textContent = time.toFixed(2) + 's';
}

function updateKeyframeInfo() {
  const infoEl = $('#keyframe-info');
  const delBtn = $('#btn-del-keyframe');

  if (selectedLaneId && selectedKeyframeIdx >= 0) {
    const lane = timeline.getLane(selectedLaneId);
    const kf = lane?.keyframes[selectedKeyframeIdx];
    if (kf) {
      const propCount = Object.keys(kf.properties).length;
      infoEl.textContent = `${kf.time.toFixed(2)}s \u00B7 ${propCount} props`;
      delBtn.style.display = '';
      return;
    }
  }

  infoEl.textContent = '';
  delBtn.style.display = 'none';
}

// ── Timeline Controls ──

function wireTimeline() {
  $('#btn-play').addEventListener('click', () => {
    timeline.toggle();
    $('#btn-play').textContent = timeline.playing ? '\u23F8' : '\u25B6';
  });

  $('#timeline-duration').addEventListener('change', (e) => {
    timeline.duration = Math.max(0.5, parseFloat(e.target.value) || 5);
    renderTimeline();
  });

  $('#timeline-loop').addEventListener('change', (e) => {
    timeline.loop = e.target.checked;
  });

  $('#btn-add-lane').addEventListener('click', () => {
    const lane = timeline.addLane();
    selectedLaneId = lane.id;
    renderTimeline();
  });

  $('#btn-add-keyframe').addEventListener('click', () => {
    captureKeyframe();
  });

  $('#btn-del-keyframe').addEventListener('click', () => {
    if (selectedLaneId && selectedKeyframeIdx >= 0) {
      timeline.removeKeyframe(selectedLaneId, selectedKeyframeIdx);
      selectedKeyframeIdx = -1;
      renderTimeline();
    }
  });

  // Close capture dialog on outside click
  document.addEventListener('mousedown', (e) => {
    const dialog = $('#capture-dialog');
    if (dialog.classList.contains('open') && !dialog.contains(e.target) && e.target.id !== 'btn-add-keyframe') {
      hideCaptureDialog();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Skip if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.contentEditable === 'true') return;

    if (e.key === ' ') {
      e.preventDefault();
      timeline.toggle();
      $('#btn-play').textContent = timeline.playing ? '\u23F8' : '\u25B6';
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLaneId && selectedKeyframeIdx >= 0) {
      timeline.removeKeyframe(selectedLaneId, selectedKeyframeIdx);
      selectedKeyframeIdx = -1;
      renderTimeline();
    }
  });
}

// ── Save / Load Scene ──

async function saveScene() {
  const data = {
    version: 1,
    scene: {
      handStates: {
        Right: JSON.parse(JSON.stringify(handStates.Right)),
        Left: JSON.parse(JSON.stringify(handStates.Left)),
      },
      lightState: JSON.parse(JSON.stringify(lightState)),
      screenState: JSON.parse(JSON.stringify(screenState)),
      sceneState: JSON.parse(JSON.stringify(sceneState)),
      camera: {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      },
    },
    animation: timeline.toJSON(),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });

  // Use File System Access API if available (Chrome/Edge) for save-as dialog
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'hand-scene.json',
        types: [{
          description: 'JSON Scene File',
          accept: { 'application/json': ['.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      $('#footer-status').textContent = 'Scene saved';
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fall through to legacy download
    }
  }

  // Fallback: auto-download to Downloads folder
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'hand-scene.json';
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);

  $('#footer-status').textContent = 'Scene saved';
}

function loadScene(jsonText) {
  try {
    const data = JSON.parse(jsonText);

    // Restore hand states
    for (const slotKey of ['Right', 'Left']) {
      const saved = data.scene?.handStates?.[slotKey];
      if (!saved) continue;

      const current = handStates[slotKey];
      const handednessChanged = current.handedness !== saved.handedness;

      Object.assign(current, JSON.parse(JSON.stringify(saved)));

      // Recreate clone if handedness changed
      if (handednessChanged && slotHands[slotKey]) {
        scene.remove(slotHands[slotKey].group);
        slotHands[slotKey] = createSlotHand(current.handedness);
        scene.add(slotHands[slotKey].group);
      }
    }

    // Restore light/screen/scene state
    if (data.scene?.lightState) Object.assign(lightState, JSON.parse(JSON.stringify(data.scene.lightState)));
    if (data.scene?.screenState) Object.assign(screenState, JSON.parse(JSON.stringify(data.scene.screenState)));
    if (data.scene?.sceneState) Object.assign(sceneState, JSON.parse(JSON.stringify(data.scene.sceneState)));

    // Restore camera
    if (data.scene?.camera) {
      camera.position.set(data.scene.camera.position.x, data.scene.camera.position.y, data.scene.camera.position.z);
      controls.target.set(data.scene.camera.target.x, data.scene.camera.target.y, data.scene.camera.target.z);
      controls.update();
    }

    // Apply all state
    updateLight();
    updateScreen();
    updateAmbient();
    applyAllHands();

    // Restore animation
    if (data.animation) {
      timeline = TimelineEngine.fromJSON(data.animation, applyAnimationFrame);
      selectedLaneId = timeline.lanes.length > 0 ? timeline.lanes[0].id : null;
      selectedKeyframeIdx = -1;
    }

    // Sync all UI
    syncAllHandSliders();
    syncLightSliders();
    syncScreenSliders();
    syncSceneSliders();
    syncCameraSliders();
    buildObjectList();
    renderTimeline();

    // Sync timeline controls
    $('#timeline-duration').value = timeline.duration;
    $('#timeline-loop').checked = timeline.loop;

    $('#footer-status').textContent = 'Scene loaded';
  } catch (err) {
    console.error('Failed to load scene:', err);
    $('#footer-status').textContent = `Load failed: ${err.message}`;
  }
}

// ── PNG Export ──

function exportPNG() {
  // Force a render to ensure preserveDrawingBuffer has current frame
  renderer.render(scene, camera);

  const dataURL = renderer.domElement.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = 'hand-scene-studio.png';
  link.href = dataURL;
  link.click();

  $('#footer-status').textContent = 'PNG exported';
}

// ── Render Loop ──

function animate(now) {
  requestAnimationFrame(animate);

  const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
  lastFrameTime = now;

  controls.update();

  // SpaceMouse 6DoF — skip during animation playback
  if (controls.enabled && spacemouse.connected) {
    const axes = spacemouse.poll();
    if (axes && dt > 0 && dt < 0.5) {
      const tSpeed = SM_TRANSLATE_SPEED * dt;
      const rSpeed = SM_ROTATE_SPEED * dt;

      // Camera-local axes
      const mat = camera.matrixWorld;
      const right = new THREE.Vector3(mat.elements[0], mat.elements[1], mat.elements[2]).normalize();
      const forward = new THREE.Vector3(-mat.elements[8], -mat.elements[9], -mat.elements[10]).normalize();
      const worldUp = new THREE.Vector3(0, 1, 0);

      // Translation (object mode — motions feel like grabbing the object)
      // tx+: push right → object right → camera trucks left
      // ty-: push forward (In) → object comes toward you → camera dollies out
      // tz-: lift up → object up → camera pedestals down
      const offset = new THREE.Vector3();
      offset.addScaledVector(right, -axes.tx * tSpeed);
      offset.addScaledVector(forward, axes.ty * tSpeed);
      offset.addScaledVector(worldUp, axes.tz * tSpeed);

      camera.position.add(offset);
      controls.target.add(offset);

      // Rotation (object mode — orbit around scene origin, like Fusion360)
      const pivot = new THREE.Vector3(0, 0, 0);

      if (axes.rz !== 0) {
        // Twist CW (rz+) → object spins CW → camera orbits CCW
        const angle = axes.rz * rSpeed;
        const camOff = camera.position.clone().sub(pivot);
        const tgtOff = controls.target.clone().sub(pivot);
        camOff.applyAxisAngle(worldUp, angle);
        tgtOff.applyAxisAngle(worldUp, angle);
        camera.position.copy(pivot).add(camOff);
        controls.target.copy(pivot).add(tgtOff);
      }

      if (axes.rx !== 0) {
        // Tilt forward (rx-) → object tilts away → camera orbits up (see top)
        const angle = -axes.rx * rSpeed;
        const camOff = camera.position.clone().sub(pivot);
        const tgtOff = controls.target.clone().sub(pivot);
        camOff.applyAxisAngle(right, angle);
        tgtOff.applyAxisAngle(right, angle);
        camera.position.copy(pivot).add(camOff);
        controls.target.copy(pivot).add(tgtOff);
      }

      controls.update();
      syncCameraSliders();
    }
  }

  renderer.render(scene, camera);
}

// ── Resize ──

function resizeRenderer() {
  const viewport = $('#viewport');
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (w === 0 || h === 0) return;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ── Timeline Init ──

function initTimeline() {
  buildPropRegistry();
  timeline = new TimelineEngine(applyAnimationFrame);
  wireTimeline();
  renderTimeline();
}

// ── Init ──

async function init() {
  initScene();
  wireControls();
  wireLibrary();
  initTimeline();
  buildObjectList();
  showPropertiesFor('hand-Right');
  animate();
  await initHands();
}

init().catch((err) => {
  console.error('Init failed:', err);
  $('#footer-status').textContent = `Error: ${err.message}`;
});
