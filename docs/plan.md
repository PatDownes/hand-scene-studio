# Hand Scene Studio — Plan

## Vision

A browser-based 3D scene composer with **posable hands as the core primitive**. Built on Three.js, sharing hand posing modules with Hand Pose Studio.

## Use Cases

1. **Shadow puppets** — 1–2 hands between a spot light and a projection screen with real-time shadow casting
2. **Hands holding objects** — Import textured glTF models (instruments, props), position relative to hands
3. **Seasonal/decorative** — Hands with seasonal props or decorations
4. **Logo compositions** — Hands emerging from a palm tree trunk mesh
5. **Material variety** — Swap hand textures: realistic skin, palm tree leaves, bark, stylized

## Architecture

### Scene Graph

```
Scene
├── Lights
│   ├── SpotLight (shadow-casting, positionable)
│   ├── AmbientLight
│   └── DirectionalLight (optional fill)
├── Hands
│   ├── Hand L (HandViewer3D instance, posable)
│   └── Hand R (HandViewer3D instance, posable)
├── Props (imported glTF models)
│   ├── Instrument
│   ├── Tree trunk
│   └── ...
├── Screen (shadow puppet projection plane)
└── Camera (orbitable)
```

### Shared Modules (from Hand Pose Studio)

- `skeleton-store.js` — skeleton/library persistence
- `hand-viewer-3d.js` — 3D hand mesh, FK posing, joint projection
- `hand-renderer.js` — 2D overlay rendering (optional)
- `animation.js` — keyframe engine
- `pose-store.js` — layer/pose state management
- `apng-encoder.js` — animated export
- `zip-encoder.js` — frame export
- `bevel-emboss.js` — post-processing

### New Capabilities

- **Scene object management** — add/remove/transform lights, props, screen
- **glTF import** — drag-and-drop 3D models into the scene
- **Material editor** — swap hand mesh materials/textures
- **Shadow mapping** — Three.js `SpotLight` with `castShadow`/`receiveShadow`
- **Orbit camera** — OrbitControls for scene navigation
- **Multi-hand support** — two independent HandViewer3D instances

## Shared Code Strategy

Symlink shared modules from a common `../shared/` directory (or import directly from `../hand-pose-studio/`). This avoids code duplication while keeping repos independent.
