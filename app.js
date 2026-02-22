// app.js — Hand Scene Studio main orchestrator

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HandViewer3D } from '../hand-pose-studio/hand-viewer-3d.js';
import { SkeletonStore } from '../hand-pose-studio/skeleton-store.js';

// ── State ──

const handState = {
  handedness: 'Right',
  position: { x: 0, y: 0.25, z: 0 },
  scale: 2,
  color: '#ffffff',
  curls: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
  spread: { thumb: 0.5, index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 },
  wrist: { flex: 0, deviation: 0, pronation: 0 },
  cmc: { flex: 0, sweep: 0, rotation: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

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

let selectedObject = 'hand';

// ── Three.js refs ──

let scene, camera, renderer, controls;
let ambientLight, spotLight, spotTarget;
let screenMesh, groundPlane;
let viewer3d;
const skeletonStore = new SkeletonStore();

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

  // Reparent both hand groups into our scene
  for (const handedness of ['Left', 'Right']) {
    const hand = viewer3d.hands[handedness];
    if (!hand) continue;

    scene.add(hand.group);

    // Enable shadow casting on all meshes in the hand group
    hand.group.traverse((child) => {
      if (child.isMesh || child.isSkinnedMesh) {
        child.castShadow = true;
      }
    });
  }

  // Apply initial pose
  applyHandPose();

  // Update status
  const statusEl = $('#status-text');
  statusEl.innerHTML = '';
  statusEl.textContent = 'Hand Scene Studio';
  statusEl.classList.remove('loading');

  $('#footer-status').textContent = 'Hand models loaded';
}

// ── Hand Pose ──

function applyHandPose() {
  if (!viewer3d || !viewer3d.ready) return;

  viewer3d.poseFromMIDI(
    handState.curls,
    handState.spread,
    handState.wrist,
    {
      handedness: handState.handedness,
      cmcFlex: handState.cmc.flex,
      thumbSweep: handState.cmc.sweep,
      cmcRotation: handState.cmc.rotation,
      rotationX: handState.rotation.x,
      rotationY: handState.rotation.y,
      rotationZ: handState.rotation.z,
    }
  );

  // Position group but keep group.scale=1 — scale the mesh instead.
  // Scaling the group amplifies bone-position displacements from rest in
  // the skinning computation, which distorts poseFromLandmarks results.
  // Scaling the mesh applies after skinning (in modelViewMatrix) so the
  // bone matrix computation stays clean.
  const hand = viewer3d.hands[handState.handedness];
  if (hand) {
    hand.group.position.set(handState.position.x, handState.position.y, handState.position.z);
    hand.mesh.scale.setScalar(handState.scale);
    hand.forearmMesh.scale.setScalar(handState.scale);

    hand.group.updateMatrixWorld(true);
    hand.mesh.skeleton.update();
  }

  // Apply color
  viewer3d.setColor(handState.color);
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
  screenMesh.geometry.dispose();
  screenMesh.geometry = new THREE.PlaneGeometry(screenState.width, screenState.height);
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
  { id: 'hand', label: 'Hand', icon: '✋' },
  { id: 'light', label: 'Spot Light', icon: '💡' },
  { id: 'screen', label: 'Screen', icon: '🖥' },
];

function buildObjectList() {
  const list = $('#object-list');
  list.innerHTML = '';
  for (const obj of sceneObjects) {
    const item = document.createElement('div');
    item.className = 'object-item' + (selectedObject === obj.id ? ' selected' : '');
    item.innerHTML = `<span class="icon">${obj.icon}</span><span class="label">${obj.label}</span>`;
    item.addEventListener('click', () => {
      selectedObject = obj.id;
      buildObjectList();
      showPropertiesFor(obj.id);
    });
    list.appendChild(item);
  }
}

function showPropertiesFor(id) {
  for (const panel of $$('.props-panel')) {
    panel.classList.remove('active');
  }
  const target = $(`#props-${id}`);
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

  // Finger spread: angle of each finger's MCP→TIP relative to middle MCP→TIP,
  // projected onto the palm plane
  const wrist = v3(0);
  const idxMcp = v3(5), midMcp = v3(9), ringMcp = v3(13), pnkMcp = v3(17);
  const palmNorm = norm(cross(sub(pnkMcp, wrist), sub(idxMcp, wrist)));
  const midDir = norm(sub(v3(12), midMcp));

  const spread = {};
  for (const [name, idx] of Object.entries(fingerDef)) {
    const dir = norm(sub(v3(idx[3]), v3(idx[0])));
    // Project onto palm plane
    const projDir = norm(sub(dir, { x: palmNorm.x * dot(dir, palmNorm), y: palmNorm.y * dot(dir, palmNorm), z: palmNorm.z * dot(dir, palmNorm) }));
    const projMid = norm(sub(midDir, { x: palmNorm.x * dot(midDir, palmNorm), y: palmNorm.y * dot(midDir, palmNorm), z: palmNorm.z * dot(midDir, palmNorm) }));

    let angle = Math.acos(Math.max(-1, Math.min(1, dot(projDir, projMid))));
    const c = cross(projMid, projDir);
    if (dot(c, palmNorm) < 0) angle = -angle;

    // Map ±30° → 0..1 (0.5 = neutral)
    spread[name] = Math.max(0, Math.min(1, 0.5 + angle / (Math.PI / 6)));
  }

  // Wrist: approximate flex from angle between forearm direction and hand plane
  // Using wrist→middle-MCP as hand direction, keep deviation/pronation at 0
  const handDir = norm(sub(midMcp, wrist));
  const fingerPlaneNorm = norm(cross(sub(idxMcp, wrist), sub(pnkMcp, wrist)));

  // Flex: how much the hand bends forward (negative dot with palm normal)
  // Hard to extract without forearm reference, leave at 0
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
      display.textContent = `${Math.round(v)}°`;
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
    display.textContent = `${Math.round(value)}°`;
  } else if (Number.isInteger(value)) {
    display.textContent = String(value);
  } else {
    display.textContent = Number(value).toFixed(2);
  }
}

function syncAllHandSliders() {
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    syncSlider(`curl-${finger}`, handState.curls[finger]);
    syncSlider(`spread-${finger}`, handState.spread[finger]);
  }
  syncSlider('cmc-flex', handState.cmc.flex);
  syncSlider('thumb-sweep', handState.cmc.sweep);
  syncSlider('cmc-rotation', handState.cmc.rotation);
  syncSlider('wrist-flex', handState.wrist.flex);
  syncSlider('wrist-deviation', handState.wrist.deviation);
  syncSlider('wrist-pronation', handState.wrist.pronation);
  syncSlider('hand-rot-x', handState.rotation.x);
  syncSlider('hand-rot-y', handState.rotation.y);
  syncSlider('hand-rot-z', handState.rotation.z);
}

function wireControls() {
  // ── Hand position ──
  bindRange('hand-pos-x', () => handState.position.x, (v) => { handState.position.x = v; applyHandPose(); });
  bindRange('hand-pos-y', () => handState.position.y, (v) => { handState.position.y = v; applyHandPose(); });
  bindRange('hand-pos-z', () => handState.position.z, (v) => { handState.position.z = v; applyHandPose(); });
  bindRange('hand-scale', () => handState.scale, (v) => { handState.scale = v; applyHandPose(); });

  // ── Hand color ──
  $('#hand-color').addEventListener('input', (e) => {
    handState.color = e.target.value;
    applyHandPose();
  });

  // ── Handedness toggle ──
  for (const btn of $$('.toggle-group [data-hand]')) {
    btn.addEventListener('click', () => {
      handState.handedness = btn.dataset.hand;
      for (const b of $$('.toggle-group [data-hand]')) b.classList.remove('active');
      btn.classList.add('active');
      applyHandPose();
    });
  }

  // ── Finger curls ──
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    bindRange(`curl-${finger}`, () => handState.curls[finger], (v) => { handState.curls[finger] = v; applyHandPose(); });
    bindRange(`spread-${finger}`, () => handState.spread[finger], (v) => { handState.spread[finger] = v; applyHandPose(); });
  }

  // ── CMC ──
  bindRange('cmc-flex', () => handState.cmc.flex, (v) => { handState.cmc.flex = v; applyHandPose(); });
  bindRange('thumb-sweep', () => handState.cmc.sweep, (v) => { handState.cmc.sweep = v; applyHandPose(); });
  bindRange('cmc-rotation', () => handState.cmc.rotation, (v) => { handState.cmc.rotation = v; applyHandPose(); });

  // ── Wrist ──
  bindRange('wrist-flex', () => handState.wrist.flex, (v) => { handState.wrist.flex = v; applyHandPose(); });
  bindRange('wrist-deviation', () => handState.wrist.deviation, (v) => { handState.wrist.deviation = v; applyHandPose(); });
  bindRange('wrist-pronation', () => handState.wrist.pronation, (v) => { handState.wrist.pronation = v; applyHandPose(); });

  // ── Rotation ──
  bindRange('hand-rot-x', () => handState.rotation.x, (v) => { handState.rotation.x = v; applyHandPose(); });
  bindRange('hand-rot-y', () => handState.rotation.y, (v) => { handState.rotation.y = v; applyHandPose(); });
  bindRange('hand-rot-z', () => handState.rotation.z, (v) => { handState.rotation.z = v; applyHandPose(); });

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

  // ── Scene ──
  bindRange('ambient-intensity', () => sceneState.ambientIntensity, (v) => { sceneState.ambientIntensity = v; updateAmbient(); });

  $('#scene-bg').addEventListener('input', (e) => {
    sceneState.background = e.target.value;
    updateAmbient();
  });

  // ── PNG Export ──
  $('#btn-export-png').addEventListener('click', exportPNG);
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
      if (skeleton.poseParams) {
        // Use poseFromMIDI with stored parameters — perfect reproduction
        const p = skeleton.poseParams;
        handState.curls = { ...p.curls };
        handState.spread = { ...p.spread };
        handState.wrist = {
          flex: p.wristFlex ?? 0,
          deviation: p.wristDeviation ?? 0,
          pronation: p.wristPronation ?? 0,
        };
        handState.cmc = {
          flex: p.cmcFlex ?? 0,
          sweep: p.thumbSweep ?? 0,
          rotation: p.cmcRotation ?? 0,
        };
        if (skeleton.handedness) {
          handState.handedness = skeleton.handedness;
          for (const b of $$('.toggle-group [data-hand]')) {
            b.classList.toggle('active', b.dataset.hand === skeleton.handedness);
          }
        }
        syncAllHandSliders();
        applyHandPose();
      } else {
        // Fallback: poseFromLandmarks for legacy skeletons without MIDI data
        viewer3d.poseFromLandmarks(skeleton.landmarks, {
          handedness: handState.handedness,
        });

        const hand = viewer3d.hands[handState.handedness];
        if (hand) {
          hand.group.position.set(
            handState.position.x, handState.position.y, handState.position.z
          );
          hand.mesh.scale.setScalar(handState.scale);
          hand.forearmMesh.scale.setScalar(handState.scale);
          hand.group.updateMatrixWorld(true);
          hand.mesh.skeleton.update();
        }

        viewer3d.setColor(handState.color);

        // Update sliders with approximate MIDI values for display
        const midi = landmarksToMIDI(skeleton.landmarks);
        handState.curls = midi.curls;
        handState.spread = midi.spread;
        handState.wrist = midi.wrist;
        handState.cmc = { flex: 0, sweep: 0, rotation: 0 };
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

function animate() {
  requestAnimationFrame(animate);
  controls.update();
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

// ── Init ──

async function init() {
  initScene();
  wireControls();
  wireLibrary();
  buildObjectList();
  showPropertiesFor('hand');
  animate();
  await initHands();
}

init().catch((err) => {
  console.error('Init failed:', err);
  $('#footer-status').textContent = `Error: ${err.message}`;
});
