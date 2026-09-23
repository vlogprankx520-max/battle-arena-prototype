# Battle Arena Prototype

A browser-based third-person shooter prototype (PUBG / BGMI style) built with [three.js](https://threejs.org).

- Realistic PBR town: procedural houses with Poly Haven textures, a 3D-scanned Smithsonian log cabin, barns, hangars, an airfield
- 150 procedural trees (ez-tree), HDRI sky lighting, bloom, soft shadows
- Aircraft: parked and crashed An-2, An-2 flyover, NASA Global Hawk drone
- Mixamo soldier holding an M4A1 with two-hand IK, finger grip and spine aiming
- Shooting: muzzle flash, tracers, recoil, brass ejection, bullet holes, impacts, headshots, kill feed
- 10 patrolling enemy bots that return fire
- Real gunshot recordings, surface-aware footsteps, 3D positional audio, reverb, wind and aircraft engine sound

## Run

Serve the folder over HTTP (ES modules and model loading don't work from `file://`):

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 and click **DEPLOY**.

**Controls:** WASD move · Shift sprint · Mouse look · LMB fire · RMB aim · R reload · M mute · Esc pause

`v1_index.html` is the first (stylized) prototype.

## Code

| File | What it does |
|---|---|
| `js/main.js` | Renderer, HDRI, camera, input, shooting, enemy AI, HUD, game loop |
| `js/world.js` | Map: terrain, roads, runway, houses, scanned buildings, props, trees, aircraft |
| `js/operator.js` | Character + weapon rig (two-bone IK, hand/finger pose, spine aim, death) |
| `js/fx.js` | Muzzle flash, tracers, smoke, sparks, decals, shell casings |
| `js/audio.js` | WebAudio engine: samples, 3D panning, reverb, synthesized wind and engine |

## Asset credits

| Asset | Source | License |
|---|---|---|
| HDRI sky, PBR textures, props | [Poly Haven](https://polyhaven.com) | CC0 |
| Log cabin (3D scan) | [Smithsonian Open Access](https://3d.si.edu) | CC0 |
| M4A1 rifle | [OpenGameArt – nisu](https://opengameart.org/content/m4a1-1) | CC0 |
| An-2 aircraft | [OpenGameArt – Mehozavr](https://opengameart.org) | CC0 |
| Old wood barn | [OpenGameArt – carlosjorgereis](https://opengameart.org) | CC0 |
| Global Hawk | [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) | NASA media usage guidelines |
| Firearm recordings | [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | CC0 |
| Reload sound | [OpenGameArt – Gun reload sounds](https://opengameart.org/content/gun-reload-sounds) | CC0 |
| Footsteps & impacts | [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | CC0 |
| Soldier character | [three.js examples](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf) (Mixamo) | Mixamo terms |
| Stylized v1 assets | [Quaternius via Poly Pizza](https://poly.pizza/u/Quaternius) | CC0 |
| Trees | [ez-tree](https://github.com/dgreenheck/ez-tree) | MIT |
