import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AudioManager } from "./audio";

const SKY_CLEAR_COLOR = 0xbfe6f5;
const SKY_STORM_COLOR = 0x6a7d96;
const FOG_CLEAR_COLOR = 0xd6eef7;
const FOG_STORM_COLOR = 0x3a4860;
const TARGET_RENDER_FPS = 60;
const MAX_RENDER_PIXEL_RATIO = 1.0;

// --- BIOME SYSTEM ---

/** All terrain biomes the world generator can produce. */
type BiomeName = "city" | "base" | "refinery" | "desert" | "forest" | "ruins";

/**
 * Number of consecutive chunks that share a biome. Grouping chunks into bands
 * makes each biome read as a deliberate "stretch" the player flies through
 * instead of flickering from chunk to chunk.
 */
const BIOME_BAND_LENGTH = 5;

/** Order biomes cycle through as the player progresses. */
const BIOME_SEQUENCE: BiomeName[] = [
  "city",
  "desert",
  "ruins",
  "forest",
  "base",
  "refinery",
];

/** Visual atmosphere applied per biome: clear-weather sky/fog tint and base fog density. */
type BiomeAtmosphere = {
  sky: number;
  fog: number;
  fogDensity: number;
  /** Hemisphere light sky/ground tints used to shade the world for the biome. */
  ambientSky: number;
  ambientGround: number;
};

const BIOME_ATMOSPHERE: Record<BiomeName, BiomeAtmosphere> = {
  city: {
    sky: 0xbfe6f5,
    fog: 0xd6eef7,
    fogDensity: 0.0024,
    ambientSky: 0xffffff,
    ambientGround: 0xb3c0c8,
  },
  desert: {
    sky: 0xf2e2bd,
    fog: 0xf0e3c6,
    fogDensity: 0.0022,
    ambientSky: 0xfff6e2,
    ambientGround: 0xcdb487,
  },
  ruins: {
    sky: 0xc7cdd4,
    fog: 0xcfd4da,
    fogDensity: 0.0032,
    ambientSky: 0xf2f4f6,
    ambientGround: 0x9a9ea6,
  },
  forest: {
    sky: 0xcdeed5,
    fog: 0xd5edda,
    fogDensity: 0.0028,
    ambientSky: 0xf3fbf2,
    ambientGround: 0x8fae93,
  },
  base: {
    sky: 0xd2e4f0,
    fog: 0xdce9f2,
    fogDensity: 0.0024,
    ambientSky: 0xf6fbff,
    ambientGround: 0xa9b6c0,
  },
  refinery: {
    sky: 0xe6dcc8,
    fog: 0xe2d8c4,
    fogDensity: 0.0034,
    ambientSky: 0xfff2dc,
    ambientGround: 0xb3a488,
  },
};



// --- TEXTURE SYSTEM ---
export class TextureManager {
  static loader = new THREE.TextureLoader();
  static textures: Record<string, THREE.Texture> = {};

  static load(name: string, url: string): THREE.Texture {
    if (this.textures[name]) return this.textures[name];
    const texture = this.loader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    this.textures[name] = texture;
    return texture;
  }
}

// --- SHADERS ---

const LowPolyVert = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalMatrix * normal;
      vViewPosition = -mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const LowPolyFrag = `
  uniform vec3 baseColor;
  uniform float uDamage; // 0.0 to 1.0 range for visuals
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
      vec3 normal = normalize(vNormal);
      vec3 viewDir = normalize(vViewPosition);

      // Lights
      vec3 keyLightDir = normalize(vec3(0.5, 1.0, 0.5));
      vec3 fillLightDir = normalize(vec3(-0.5, 0.2, -0.5));
      
      float keyDiff = max(dot(normal, keyLightDir), 0.0);
      float fillDiff = max(dot(normal, fillLightDir), 0.0) * 0.3;
      float ambient = 0.3;

      // Stylized Rim Light
      float rim = 1.0 - max(dot(viewDir, normal), 0.0);
      rim = smoothstep(0.65, 1.0, rim);

      vec3 lighting = vec3(keyDiff + fillDiff + ambient);
      
      // Darken color based on damage
      vec3 damagedColor = mix(baseColor, vec3(0.05, 0.05, 0.08), uDamage * 0.85);
      vec3 color = damagedColor * lighting + vec3(0.8, 0.9, 1.0) * rim * (0.5 * (1.0 - uDamage * 0.5));
      
      gl_FragColor = vec4(color, 1.0);
  }
`;

function createLowPolyMaterial(colorHex: number) {
  const material = new THREE.MeshLambertMaterial({
    color: colorHex,
    flatShading: true,
    emissive: colorHex,
    emissiveIntensity: 0.025,
  });
  material.userData.baseColor = new THREE.Color(colorHex);
  return material;
}

function createGlowMaterial(colorHex: number, opacity = 0.72) {
  return new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function createGlowBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
  opacity = 0.72,
) {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, createGlowMaterial(colorHex, opacity));
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function createSkyDome() {
  const geometry = new THREE.SphereGeometry(340, 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x5fa8e6) },
      horizonColor: { value: new THREE.Color(0xd6eef7) },
      sunColor: { value: new THREE.Color(0xfff2cf) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunColor;
      varying vec3 vWorldPosition;

      void main() {
        vec3 dir = normalize(vWorldPosition);
        float horizon = smoothstep(-0.12, 0.72, dir.y);
        vec3 color = mix(horizonColor, topColor, horizon);
        float sun = pow(max(dot(dir, normalize(vec3(-0.38, 0.58, -0.72))), 0.0), 52.0);
        color += sunColor * sun * 0.55;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = "ArcadeSkyDome";
  dome.frustumCulled = false;
  return dome;
}

function createBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
) {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, createLowPolyMaterial(colorHex));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

type RooftopSpot = {
  x: number;
  y: number;
  z: number;
};

type CityBlock = {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  chunkId: number;
  meshes: THREE.Mesh[];
  body?: CANNON.Body;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  collapseProgress?: number;
  initialHeights?: number[];
};

type EnemyLock = {
  body: CANNON.Body;
  active: boolean;
};

type WorldChunk = {
  id: number;
  group: THREE.Group;
  bodies: CANNON.Body[];
  blocks: CityBlock[];
  spots: RooftopSpot[];
};

type StickInput = {
  x: number;
  y: number;
  active: boolean;
};

class CityEnvironment {
  group = new THREE.Group();
  rooftopSpots: RooftopSpot[] = [];
  blocks: CityBlock[] = [];
  chunks: Map<number, WorldChunk> = new Map();
  particles: any = null;
  cellSize = 22;
  chunkDepth = 132;
  halfWidthCells = 5;
  activeBehind = 1;
  activeAhead = 2;
  onBuildingDestroyed: ((x: number, y: number, z: number) => void) | null = null;

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.group.name = "ModularBlockCity";
    scene.add(this.group);

    this.update(0, world);
  }

  getSpawnSpot(playerPos: CANNON.Vec3): RooftopSpot {
    const candidates = this.rooftopSpots.filter((spot) => {
      const dx = spot.x - playerPos.x;
      const dz = spot.z - playerPos.z;
      const distSq = dx * dx + dz * dz;
      return spot.z < playerPos.z - 22 && distSq > 1600 && distSq < 22000;
    });
    const pool = candidates.length > 0 ? candidates : this.rooftopSpots;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  getAmbushSpot(playerPos: CANNON.Vec3, aheadMin = 45, aheadMax = 165) {
    const candidates = this.rooftopSpots.filter((spot) => {
      const ahead = playerPos.z - spot.z;
      return ahead > aheadMin && ahead < aheadMax && Math.abs(spot.x - playerPos.x) < 145;
    });
    return candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : this.getSpawnSpot(playerPos);
  }

  update(playerZ: number, world: CANNON.World, delta = 0.016) {
    const center = Math.floor(playerZ / this.chunkDepth);
    let cacheDirty = false;
    for (let id = center - this.activeAhead; id <= center + this.activeBehind; id++) {
      if (!this.chunks.has(id)) {
        this.generateChunk(id, world);
        cacheDirty = true;
      }
    }

    for (const [id, chunk] of this.chunks) {
      if (id < center - this.activeAhead - 1 || id > center + this.activeBehind + 1) {
        this.group.remove(chunk.group);
        for (const body of chunk.bodies) world.removeBody(body);
        this.chunks.delete(id);
        cacheDirty = true;
      }
    }

    // Crumbling building animations removed in favor of instant arcade destruction

    if (cacheDirty) this.rebuildCaches();
  }

  damageNearby(x: number, z: number, radius: number, amount: number) {
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      const distSq = this.distanceToBlockFootprintSq(x, z, block);
      if (distSq > radius * radius) continue;
      const falloff = 1 - Math.sqrt(distSq) / Math.max(radius, 0.001);
      this.damageBlock(block, amount * (0.35 + falloff * 0.65));
    }
  }

  damageProjectilePath(
    from: CANNON.Vec3,
    to: CANNON.Vec3,
    amount: number,
  ): CityBlock | null {
    let closestBlock: CityBlock | null = null;
    let closestT = Infinity;

    for (const block of this.blocks) {
      if (block.destroyed) continue;
      // Arcade style: Projectiles hit any building in their path, regardless of height
      if (Math.max(from.y, to.y) < -1) {
        continue;
      }
      const t = this.segmentIntersectsBlockFootprint(from, to, block, 1.1);
      if (t === null || t >= closestT) continue;
      closestT = t;
      closestBlock = block;
    }

    if (closestBlock) this.damageBlock(closestBlock, amount);
    return closestBlock;
  }

  getHeightAt(x: number, z: number, clearanceRadius = 0) {
    let height = 0;
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      if (
        Math.abs(x - block.x) <= block.width * 0.5 + clearanceRadius &&
        Math.abs(z - block.z) <= block.depth * 0.5 + clearanceRadius
      ) {
        height = Math.max(height, block.height);
      }
    }
    return height;
  }

  /** Returns the biome at a given world-Z (maps Z to its chunk, then to a biome). */
  getBiomeAt(z: number): BiomeName {
    const id = Math.floor(z / this.chunkDepth);
    return this.zoneForChunk(id);
  }

  private generateChunk(id: number, world: CANNON.World) {
    const chunk: WorldChunk = {
      id,
      group: new THREE.Group(),
      bodies: [],
      blocks: [],
      spots: [],
    };
    chunk.group.name = `BattlefieldChunk_${id}`;
    this.group.add(chunk.group);

    const zone = this.zoneForChunk(id);
    const chunkCenterZ = id * this.chunkDepth;
    // Grass/terrain ground tones per biome (bright, like the reference art).
    const groundColors: Record<string, number> = {
      city: 0x8ed16a,
      base: 0x9bcf72,
      refinery: 0xb8b89c,
      desert: 0xe3cd92,
      forest: 0x6fb23f,
      ruins: 0xb0b4a8,
    };
    const ground = createBox(420, 0.8, this.chunkDepth - 0.4, groundColors[zone]);
    ground.position.set(0, -0.62, chunkCenterZ);
    chunk.group.add(ground);

    const road = createBox(18, 0.12, this.chunkDepth - 0.4, 0x6c7178);
    road.position.set(this.hash(id, 99) > 0.5 ? -34 : 34, -0.16, chunkCenterZ);
    chunk.group.add(road);
    this.addGroundDressing(chunk, zone, chunkCenterZ, road.position.x, id);

    for (let gx = -this.halfWidthCells; gx <= this.halfWidthCells; gx++) {
      for (let local = -2; local <= 3; local++) {
        const isFlightLane = Math.abs(gx) <= 1;
        if (isFlightLane && (id === 0 || this.hash(id, gx * 53 + local * 19) < 0.25)) continue;
        const roll = this.hash(id, gx * 13 + local * 37);
        const density = zone === "city" ? 0.28 : 0.20;
        if (roll > density) continue;

        const x = gx * this.cellSize + (this.hash(id, gx + local) - 0.5) * 4;
        const z = chunkCenterZ + local * this.cellSize + (this.hash(id, gx - local) - 0.5) * 5;
        this.addProceduralStructure(chunk, world, zone, x, z, gx, local);
      }
    }

    if (Math.abs(id) % 5 === 2) this.addBridge(chunk, chunkCenterZ);
    if (Math.abs(id) % 7 === 4) this.addSmokeColumn(chunk, chunkCenterZ);

    this.chunks.set(id, chunk);
  }

  private addProceduralStructure(
    chunk: WorldChunk,
    world: CANNON.World,
    zone: string,
    x: number,
    z: number,
    gx: number,
    local: number,
  ) {
    const seed = this.hash(chunk.id, gx * 97 + local * 131);
    // Bright, clean building tints inspired by isometric city art:
    // mostly white/light with subtle blue, beige, and grey variants.
    const palettes: Record<string, number[]> = {
      city: [0xf3f6fa, 0xe6edf5, 0xd8e2ee, 0xeef2f7, 0xc9d6e6],
      base: [0xeef1f4, 0xdfe5ea, 0xf4f6f8, 0xcdd5dc],
      refinery: [0xe4e7ea, 0xd2d7dc, 0xcdb89a, 0xbfc4c9],
      desert: [0xf0e6c8, 0xe7d6a8, 0xddc790, 0xf5ecd2],
      forest: [0xeef2ee, 0xdbe6da, 0xc7d8c6, 0xf2f5f1],
      ruins: [0xdadcd8, 0xc6c8c2, 0xe2e3df, 0xb7b9b3],
    };
    const colors = palettes[zone];
    const color = colors[Math.floor(seed * colors.length)];
    const skyscraper = (zone === "city" || zone === "ruins") && Math.abs(gx) > 1 && seed > 0.72;
    const height = skyscraper ? 22 + seed * 32 : 9 + seed * 14;
    const width = zone === "base" ? 9 + seed * 5 : 6 + this.hash(chunk.id, gx) * 8;
    const depth = zone === "refinery" ? 5 + this.hash(chunk.id, local) * 8 : 6 + this.hash(chunk.id, gx + 4) * 8;

    const building = createBox(width, height, depth, color);
    building.position.set(x, height / 2, z);
    chunk.group.add(building);

    // Low houses get a pitched orange/terracotta roof; taller buildings keep a flat cap.
    const isHouse = !skyscraper && height < 16;
    const capExtras: THREE.Mesh[] = [];
    if (isHouse && seed > 0.4) {
      const roofColors = [0xd9622b, 0xc8531f, 0xe07b3a, 0xb84a22];
      const roofColor = roofColors[Math.floor(this.hash(chunk.id, gx * 7 + local) * roofColors.length)];
      const roof = createBox(width + 1.4, 1.6, depth + 1.4, roofColor);
      roof.position.set(x, height + 0.8, z);
      roof.rotation.y = 0;
      chunk.group.add(roof);
      const ridge = createBox(width + 1.4, 1.0, 2.2, roofColor);
      ridge.position.set(x, height + 1.6, z);
      chunk.group.add(ridge);
      capExtras.push(roof, ridge);
    } else {
      const cap = createBox(width + 1.8, 1, depth + 1.8, 0xf5f7fa);
      cap.position.set(x, height + 0.5, z);
      chunk.group.add(cap);
      capExtras.push(cap);
    }

    const facadeDetails = this.addBuildingFacadeDetails(
      chunk,
      zone,
      x,
      z,
      height,
      width,
      depth,
      seed,
    );

    const body = this.addStaticBox(
      world,
      width + 1.8,
      height + 1,
      depth + 1.8,
      x,
      (height + 1) / 2,
      z,
      true,
    );
    const maxHp = 45 + height * 2.0;
    chunk.bodies.push(body);
    chunk.blocks.push({
      x,
      z,
      width: width + 1.8,
      depth: depth + 1.8,
      height: height + 1,
      chunkId: chunk.id,
      meshes: [building, ...capExtras, ...facadeDetails],
      body,
      hp: maxHp,
      maxHp,
      destroyed: false,
    });
    chunk.spots.push({ x, y: height + 1.8, z });

    if (seed > 0.65) this.addRooftopDetail(chunk, x, z, height, width, depth, seed);
  }

  private addBuildingFacadeDetails(
    chunk: WorldChunk,
    zone: string,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
  ) {
    const details: THREE.Mesh[] = [];

    // Flat, non-glowing window grids in the blue-glass tones of the reference art.
    const windowColor =
      zone === "desert"
        ? 0x8fb7d6
        : zone === "forest"
          ? 0x86b4c9
          : zone === "ruins"
            ? 0x9aa6b0
            : 0x6f9fd0;

    // Window rows climb the front face; columns are spaced across the width.
    const rows = Math.max(1, Math.floor(height / 4.2));
    const cols = Math.max(2, Math.floor(width / 3.0));
    const winW = (width * 0.7) / cols;
    const winH = 1.5;
    const startX = x - (width * 0.7) / 2 + winW / 2;
    const faceZ = z + depth * 0.5 + 0.06;

    for (let r = 0; r < rows; r++) {
      const wy = 3.0 + r * 4.0;
      if (wy > height - 1.2) break;
      for (let c = 0; c < cols; c++) {
        // Pseudo-random per-window so some panes are slightly darker, like real glass.
        const lit = this.hash(chunk.id, Math.floor(seed * 500) + r * 31 + c * 7) > 0.32;
        const pane = createBox(winW * 0.78, winH, 0.12, lit ? windowColor : 0x4f6f93);
        pane.position.set(startX + c * winW, wy, faceZ);
        chunk.group.add(pane);
        details.push(pane);
      }
    }

    // Rooftop beacon on tall towers (kept as a subtle accent, not a neon blob).
    if (height > 20 && seed > 0.5) {
      const beacon = createGlowBox(0.9, 0.4, 0.9, 0xff5a5a, 0.85);
      beacon.position.set(x, height + 1.2, z + depth * 0.18);
      chunk.group.add(beacon);
      details.push(beacon);
    }

    return details;
  }

  private addRooftopDetail(
    chunk: WorldChunk,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
  ) {
    if (seed > 0.86) {
      const helipad = createBox(Math.min(width, 10), 0.22, Math.min(depth, 10), 0xb9c0c6);
      helipad.position.set(x, height + 1.18, z);
      chunk.group.add(helipad);
      
      const hMarker = createBox(3.5, 0.28, 3.5, 0xf3f4f2);
      hMarker.position.set(x, height + 1.22, z);
      chunk.group.add(hMarker);
    } else if (seed > 0.75) {
      const tower = createBox(0.8, 7, 0.8, 0x9aa2ab);
      tower.position.set(x + width * 0.22, height + 4.2, z - depth * 0.18);
      chunk.group.add(tower);
      const dish = createBox(3.2, 0.35, 1.2, 0xdfeef5);
      dish.position.set(tower.position.x, height + 8, tower.position.z);
      dish.rotation.z = Math.PI / 7;
      chunk.group.add(dish);
    } else if (seed > 0.55) {
      // Multiple AC Units
      for (let i=0; i<3; i++) {
        const ac = createBox(1.5, 1.4, 1.5, 0xc4cace);
        ac.position.set(x - width*0.15 + i*2.5, height + 1.7, z + depth*0.15);
        chunk.group.add(ac);
      }
    } else {
      // Water Tower
      const legs = createBox(2, 3, 2, 0xaeb4ba);
      legs.position.set(x, height + 2.5, z);
      const tank = createBox(2.8, 3, 2.8, 0xd2d7db);
      tank.position.set(x, height + 5.5, z);
      chunk.group.add(legs, tank);
    }
  }

  private addBridge(chunk: WorldChunk, z: number) {
    const bridge = createBox(160, 2, 16, 0xb7bcc1);
    bridge.position.set(0, 5, z);
    chunk.group.add(bridge);
    for (let i = -3; i <= 3; i++) {
      const support = createBox(2, 10, 2, 0x9aa0a6);
      support.position.set(i * 24, 2.2, z);
      chunk.group.add(support);
    }
  }

  /**
   * Adds a rounded, leafy tree (rounded crown + trunk) like the reference art.
   * Purely decorative — no physics body, so it never affects building collisions.
   */
  private addTree(chunk: WorldChunk, x: number, z: number, seed: number) {
    const scale = 0.85 + seed * 0.7;
    const trunkH = 2.4 * scale;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32 * scale, 0.42 * scale, trunkH, 6),
      createLowPolyMaterial(0x8a5a32),
    );
    trunk.position.set(x, trunkH / 2, z);
    chunk.group.add(trunk);

    // Two-tone rounded canopy: a couple of stacked low-poly spheres.
    const greens = [0x4f9e3a, 0x5bb045, 0x67c04f, 0x469033];
    const crownColor = greens[Math.floor(seed * greens.length)];
    const r = 2.0 * scale;
    const crownLow = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      createLowPolyMaterial(crownColor),
    );
    crownLow.position.set(x, trunkH + r * 0.7, z);
    crownLow.rotation.y = seed * Math.PI;
    chunk.group.add(crownLow);

    const crownTop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r * 0.72, 0),
      createLowPolyMaterial(crownColor),
    );
    crownTop.position.set(x, trunkH + r * 1.5, z);
    crownTop.rotation.y = seed * 2.1;
    chunk.group.add(crownTop);
  }

  private addSmokeColumn(chunk: WorldChunk, z: number) {
    for (let i = 0; i < 4; i++) {
      const smoke = createBox(5 + i * 2, 6 + i * 3, 5 + i * 2, 0xdfe4e8);
      smoke.material.transparent = true;
      smoke.material.opacity = 0.12;
      smoke.position.set(-70 + i * 10, 5 + i * 5, z - 18 + i * 4);
      chunk.group.add(smoke);
    }
  }

  private addGroundDressing(
    chunk: WorldChunk,
    zone: string,
    chunkCenterZ: number,
    roadX: number,
    id: number,
  ) {
    // No central lane box: removing it stops the play area from looking like the player is flying down the middle of a highway/runway.

    // Light sidewalk/curb shoulders flanking the road.
    const shoulderColor = zone === "desert" ? 0xcdb789 : zone === "forest" ? 0xb8c9b0 : 0xb9c0c6;
    for (const side of [-1, 1]) {
      const shoulder = createBox(4, 0.06, this.chunkDepth - 0.6, shoulderColor);
      shoulder.position.set(roadX + side * 12.5, -0.02, chunkCenterZ);
      chunk.group.add(shoulder);
    }

    for (let i = -3; i <= 3; i++) {
      // Crisp white centre-line dashes, like the reference road markings.
      const stripe = createBox(0.9, 0.1, 6, 0xf3f4f2);
      stripe.position.set(roadX, -0.04, chunkCenterZ + i * 18);
      chunk.group.add(stripe);

      // Ambient Traffic (Static Cars)
      if (this.hash(id, i * 43) > 0.4) {
        const isForward = this.hash(id, i * 17) > 0.5;
        const carLane = isForward ? 4.5 : -4.5;
        const carZ = chunkCenterZ + i * 18 + (this.hash(id, i * 11) - 0.5) * 10;

        // Brighter, cleaner car body colours.
        const carColor = [0xd23b3b, 0x3b6fd2, 0xe8e8e8, 0xf4c542, 0x4caf6e][Math.floor(this.hash(id, i * 3) * 5)];
        const carBody = createBox(2.8, 1.2, 5.5, carColor);
        carBody.position.set(roadX + carLane, 0.6, carZ);

        const carRoof = createBox(2.4, 0.8, 3.0, 0xf0f0f0);
        carRoof.position.set(roadX + carLane, 1.6, carZ - 0.5);

        chunk.group.add(carBody, carRoof);
      }
    }

    // Bright grass/lawn patches in green and biome-tinted tones.
    const detailPalettes: Record<string, number[]> = {
      city: [0x8fd267, 0x7cc457, 0x9bd97a, 0x86cf63],
      base: [0x93cf6e, 0x82c25c, 0xa0d77f, 0x8acb66],
      refinery: [0xc2c4ad, 0xb4b69d, 0xa9ab92, 0xcccdb8],
      desert: [0xe6d199, 0xddc486, 0xecdaa8, 0xd4b878],
      forest: [0x5fa83c, 0x4f9532, 0x6cb547, 0x57a035],
      ruins: [0xb6b9ab, 0xa7aa9c, 0xc3c6b8, 0x9ea191],
    };
    const palette = detailPalettes[zone] ?? detailPalettes.city;

    for (let i = 0; i < 16; i++) {
      const seed = this.hash(id, i * 41 + 7);
      const x = -190 + this.hash(id, i * 59 + 11) * 380;
      const z = chunkCenterZ - this.chunkDepth * 0.48 + this.hash(id, i * 67 + 17) * this.chunkDepth;
      if (Math.abs(x) < 23 || Math.abs(x - roadX) < 24) continue;

      const patch = createBox(
        6 + this.hash(id, i * 71 + 19) * 18,
        0.06,
        5 + this.hash(id, i * 73 + 23) * 16,
        palette[Math.floor(seed * palette.length)],
      );
      patch.position.set(x, -0.11 + seed * 0.006, z);
      patch.rotation.y = (seed - 0.5) * 0.45;
      chunk.group.add(patch);
    }

    // Trees: lush and frequent everywhere except bare desert/refinery, matching
    // the leafy reference art. Rocks fill in the arid biomes.
    const treeCount = zone === "forest" ? 14 : zone === "desert" || zone === "refinery" ? 4 : 9;
    for (let i = 0; i < treeCount; i++) {
      const seed = this.hash(id, i * 83 + 31);
      const x = -185 + this.hash(id, i * 89 + 37) * 370;
      const z = chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 97 + 43) * this.chunkDepth * 0.9;
      if (Math.abs(x) < 30 || Math.abs(x - roadX) < 18) continue;

      const arid = zone === "desert" || zone === "refinery";
      if (arid && seed < 0.6) {
        const rock = createBox(2 + seed * 4, 0.6 + seed * 1.3, 2 + seed * 4, zone === "desert" ? 0xc9ac72 : 0xa9aba0);
        rock.position.set(x, 0.4, z);
        rock.rotation.y = seed * Math.PI;
        chunk.group.add(rock);
      } else {
        this.addTree(chunk, x, z, seed);
      }
    }

    for (let i = 0; i < 5; i++) {
      const seed = this.hash(id, i * 109 + 51);
      const side = seed > 0.5 ? 1 : -1;
      const lampX = roadX + side * (15.5 + this.hash(id, i * 113) * 4);
      const lampZ = chunkCenterZ - this.chunkDepth * 0.42 + this.hash(id, i * 127 + 53) * this.chunkDepth * 0.84;
      const pole = createBox(0.28, 5.2, 0.28, 0x1a2333);
      pole.position.set(lampX, 2.45, lampZ);
      const arm = createBox(3.4, 0.18, 0.18, 0x1a2333);
      arm.position.set(lampX - side * 1.5, 5.0, lampZ);
      const lamp = createGlowBox(1.1, 0.38, 1.1, zone === "desert" ? 0xffe6b0 : 0xeaf6ff, 0.4);
      lamp.position.set(lampX - side * 3.0, 4.88, lampZ);
      chunk.group.add(pole, arm, lamp);
    }

    if (Math.abs(id) % 3 === 1) {
      const crater = createBox(16, 0.05, 12, 0xcdbf9a);
      crater.position.set(roadX > 0 ? -84 : 84, -0.02, chunkCenterZ + (this.hash(id, 203) - 0.5) * 52);
      crater.rotation.y = this.hash(id, 211) * Math.PI;
      chunk.group.add(crater);
    }
  }

  private rebuildCaches() {
    this.blocks = [];
    this.rooftopSpots = [];
    for (const chunk of this.chunks.values()) {
      this.blocks.push(...chunk.blocks);
      this.rooftopSpots.push(...chunk.spots);
    }
  }

  private zoneForChunk(id: number): BiomeName {
    // Group chunks into fixed-length bands so each biome persists for several
    // chunks, then walk the biome sequence one band at a time. This produces a
    // coherent journey (city -> desert -> ruins -> ...) instead of biomes
    // flickering from chunk to chunk.
    const band = Math.floor(id / BIOME_BAND_LENGTH);
    const index =
      ((band % BIOME_SEQUENCE.length) + BIOME_SEQUENCE.length) %
      BIOME_SEQUENCE.length;
    return BIOME_SEQUENCE[index];
  }

  private hash(a: number, b: number) {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  private addStaticBox(
    world: CANNON.World,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    collisionResponse = true,
  ) {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(x, y, z),
      shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)),
    });
    body.collisionResponse = collisionResponse;
    if (!collisionResponse) {
      body.collisionFilterGroup = 2;
      body.collisionFilterMask = 0;
    }
    world.addBody(body);
    return body;
  }

  private damageBlock(block: CityBlock, amount: number) {
    block.hp = Math.max(0, block.hp - amount);
    const damage = 1 - block.hp / block.maxHp;

    for (const mesh of block.meshes) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshLambertMaterial) {
        const baseColor = mat.userData.baseColor as THREE.Color | undefined;
        if (baseColor) {
          mat.color.copy(baseColor).lerp(new THREE.Color(0x211f24), damage * 0.8);
        }
      }
      mesh.scale.x = 1 + damage * 0.04;
      mesh.scale.z = 1 + damage * 0.04;
    }

    if (block.hp > 0 || block.destroyed) return;
    block.destroyed = true;

    if (this.particles) {
      this.particles.spawnExplosion(
        block.x,
        block.height * 0.5,
        block.z,
        60, // large particle count
        performance.now() / 1000,
        block.width * 1.5, // large size scale
      );
    }
    
    if (this.onBuildingDestroyed) {
      this.onBuildingDestroyed(block.x, block.height * 0.5, block.z);
    }

    if (block.body) {
      block.body.collisionFilterMask = 0;
      block.body.collisionResponse = false;
    }
    for (const mesh of block.meshes) {
      mesh.visible = false;
    }
  }

  private distanceToBlockFootprintSq(x: number, z: number, block: CityBlock) {
    const dx = Math.max(Math.abs(x - block.x) - block.width * 0.5, 0);
    const dz = Math.max(Math.abs(z - block.z) - block.depth * 0.5, 0);
    return dx * dx + dz * dz;
  }

  private segmentIntersectsBlockFootprint(
    from: CANNON.Vec3,
    to: CANNON.Vec3,
    block: CityBlock,
    padding: number,
  ) {
    const minX = block.x - block.width * 0.5 - padding;
    const maxX = block.x + block.width * 0.5 + padding;
    const minZ = block.z - block.depth * 0.5 - padding;
    const maxZ = block.z + block.depth * 0.5 + padding;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 0.0001) {
      if (from.x < minX || from.x > maxX) return null;
    } else {
      const tx1 = (minX - from.x) / dx;
      const tx2 = (maxX - from.x) / dx;
      tMin = Math.max(tMin, Math.min(tx1, tx2));
      tMax = Math.min(tMax, Math.max(tx1, tx2));
    }

    if (Math.abs(dz) < 0.0001) {
      if (from.z < minZ || from.z > maxZ) return null;
    } else {
      const tz1 = (minZ - from.z) / dz;
      const tz2 = (maxZ - from.z) / dz;
      tMin = Math.max(tMin, Math.min(tz1, tz2));
      tMax = Math.min(tMax, Math.max(tz1, tz2));
    }

    if (tMax < tMin) return null;
    return tMin;
  }
}

const ParticleVert = `
  attribute vec3 velocity;
  attribute float startTime;
  attribute float pType;
  uniform float uTime;
  varying float vLife;
  varying float vType;

  void main() {
      float lifeTime = max(0.0, uTime - startTime);
      float duration = pType == 1.0 ? 2.0 : (pType == 2.0 ? 0.4 : 1.0); // Smoke lives longer, sparks die fast
      vLife = max(0.0, 1.0 - (lifeTime / duration)); 
      vType = pType;
      
      vec3 currentPos = position + velocity * lifeTime;
      // Gravity affects sparks (type 2) and explosions (type 0), but smoke (type 1) rises
      float gravMult = pType == 1.0 ? -2.0 : 9.8; 
      currentPos.y -= gravMult * lifeTime * lifeTime;

      vec4 mvPosition = modelViewMatrix * vec4(currentPos, 1.0);
      
      // Sizes based on type
      float sizeMult = pType == 1.0 ? 38.0 : (pType == 2.0 ? 6.5 : 24.0);
      gl_PointSize = (sizeMult * vLife) * (100.0 / length(mvPosition.xyz));
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const ParticleFrag = `
  varying float vLife;
  varying float vType;
  void main() {
      if (vLife <= 0.0) discard;
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if(dist > 0.5) discard;
      float softDisc = smoothstep(0.5, 0.08, dist);
      
      vec3 color;
      float alpha = vLife * 0.8 * softDisc;

      if (vType == 1.0) {
          // Smoke (starts grey, fades to dark)
          color = mix(vec3(0.04, 0.045, 0.055), vec3(0.36, 0.38, 0.42), vLife);
          alpha = vLife * 0.42 * softDisc;
      } else if (vType == 2.0) {
          // Sparks (white to orange)
          vec3 sparkStart = vec3(1.0, 1.0, 0.8);
          vec3 sparkEnd = vec3(1.0, 0.3, 0.0);
          color = mix(sparkEnd, sparkStart, vLife);
          alpha = vLife * softDisc;
      } else {
          // Default Explosion
          vec3 startColor = vec3(1.0, 0.96, 0.72); // White-Hot
          vec3 midColor = vec3(1.0, 0.36, 0.04);   // Orange
          vec3 endColor = vec3(0.16, 0.17, 0.2);   // Smoke
          color = mix(endColor, midColor, smoothstep(0.0, 0.5, vLife));
          color = mix(color, startColor, smoothstep(0.5, 1.0, vLife));
          color += vec3(1.0, 0.12, 0.02) * pow(1.0 - dist * 2.0, 3.0) * vLife;
      }
      
      gl_FragColor = vec4(color, alpha);
  }
`;

const RainVert = `
  attribute vec3 velocity;
  attribute float startTime;
  uniform float uTime;
  uniform vec3 uPlayerPos;
  varying float vLife;

  void main() {
      float lifeTime = mod(uTime - startTime, 2.0); // 2 sec loop
      vLife = step(0.0, lifeTime);
      
      // Infinite rain box around player
      vec3 pos = position + velocity * lifeTime;
      vec3 boxSize = vec3(100.0, 60.0, 100.0);
      pos = mod(pos - uPlayerPos + boxSize * 0.5, boxSize) - boxSize * 0.5 + uPlayerPos;

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_PointSize = 2.8 * (100.0 / length(mvPosition.xyz));
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const RainFrag = `
  varying float vLife;
  void main() {
      vec2 coord = abs(gl_PointCoord - vec2(0.5));
      float streak = smoothstep(0.5, 0.02, coord.x) * smoothstep(0.5, 0.0, coord.y);
      gl_FragColor = vec4(0.58, 0.78, 1.0, 0.48 * streak);
  }
`;

// --- SYSTEMS ---

class RainSystem {
  mesh: THREE.Points;
  uniforms: any;

  constructor(count = 2000) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const startTimes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = Math.random() * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 100;

      velocities[i * 3] = -2.0; // slight wind slant
      velocities[i * 3 + 1] = -40.0;
      velocities[i * 3 + 2] = 0.0;

      startTimes[i] = Math.random() * 2.0;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));
    geometry.setAttribute(
      "startTime",
      new THREE.BufferAttribute(startTimes, 1),
    );

    this.uniforms = {
      uTime: { value: 0.0 },
      uPlayerPos: { value: new THREE.Vector3() },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: RainVert,
      fragmentShader: RainFrag,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geometry, material);
    this.mesh.frustumCulled = false;
  }

  update(time: number, playerPos: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    this.uniforms.uPlayerPos.value.copy(playerPos);
  }
}

class WeatherSystem {
  stormIntensity: number = 0; // 0 to 1
  targetIntensity: number = 0;
  windForce: THREE.Vector3 = new THREE.Vector3();
  fogColor: number = 0x06111a;
  lastLightningTime: number = 0;
  isLightning: boolean = false;

  // Current (smoothed) clear-weather atmosphere, lerped toward the active biome.
  private biomeSky = new THREE.Color(SKY_CLEAR_COLOR);
  private biomeFog = new THREE.Color(FOG_CLEAR_COLOR);
  private biomeFogDensity = 0.0058;
  // Targets the biome system pushes in; the smoothed values chase these.
  private targetSky = new THREE.Color(SKY_CLEAR_COLOR);
  private targetFog = new THREE.Color(FOG_CLEAR_COLOR);
  private targetFogDensity = 0.0058;

  private stormColor = new THREE.Color(SKY_STORM_COLOR);
  private stormFog = new THREE.Color(FOG_STORM_COLOR);
  private tempColor = new THREE.Color();

  /** Sets the clear-weather atmosphere target for the active biome. Smoothly blended in `update`. */
  setBiomeAtmosphere(atmosphere: BiomeAtmosphere) {
    this.targetSky.setHex(atmosphere.sky);
    this.targetFog.setHex(atmosphere.fog);
    this.targetFogDensity = atmosphere.fogDensity;
  }

  /** Snaps the atmosphere to a biome instantly (used on reset to avoid a visible fade-in). */
  resetBiomeAtmosphere(atmosphere: BiomeAtmosphere) {
    this.setBiomeAtmosphere(atmosphere);
    this.biomeSky.copy(this.targetSky);
    this.biomeFog.copy(this.targetFog);
    this.biomeFogDensity = this.targetFogDensity;
  }

  update(time: number, delta: number, scene: THREE.Scene) {
    // Transition intensity
    this.stormIntensity +=
      (this.targetIntensity - this.stormIntensity) * delta * 0.1;

    // Smoothly chase the active biome's clear-weather atmosphere so crossing a
    // biome boundary fades rather than snaps. Frame-rate-independent blend.
    const biomeBlend = 1 - Math.exp(-delta * 0.6);
    this.biomeSky.lerp(this.targetSky, biomeBlend);
    this.biomeFog.lerp(this.targetFog, biomeBlend);
    this.biomeFogDensity +=
      (this.targetFogDensity - this.biomeFogDensity) * biomeBlend;

    // Fog: start from the biome density/color, then darken/thicken with storm.
    const fog = scene.fog as THREE.FogExp2;
    fog.density = this.biomeFogDensity + this.stormIntensity * 0.018;
    fog.color.copy(this.tempColor.copy(this.biomeFog).lerp(this.stormFog, this.stormIntensity));
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(
        this.tempColor.copy(this.biomeSky).lerp(this.stormColor, this.stormIntensity * 0.82),
      );
    }

    // Wind Turbulance
    const windScale = this.stormIntensity * 150;
    this.windForce.set(
      Math.sin(time * 0.5) * windScale + Math.sin(time * 2.1) * windScale * 0.5,
      0,
      Math.cos(time * 0.4) * windScale + Math.cos(time * 1.8) * windScale * 0.5,
    );

    // Lightning logic
    this.isLightning = false;
    if (this.stormIntensity > 0.4) {
      const chance = delta * (0.05 + this.stormIntensity * 0.2);
      if (Math.random() < chance && time - this.lastLightningTime > 2.0) {
        this.isLightning = true;
        this.lastLightningTime = time;
      }
    }
  }
}

class GPUParticleSystem {
  mesh: THREE.Points;
  maxParticles: number;
  positionAttr: THREE.BufferAttribute;
  velocityAttr: THREE.BufferAttribute;
  startTimeAttr: THREE.BufferAttribute;
  pTypeAttr: THREE.BufferAttribute;
  currentIndex: number = 0;
  uniforms: any;

  constructor(maxParticles = 5000) {
    this.maxParticles = maxParticles;
    const geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(maxParticles * 3);
    const velocities = new Float32Array(maxParticles * 3);
    const startTimes = new Float32Array(maxParticles);
    const pTypes = new Float32Array(maxParticles);

    for (let i = 0; i < maxParticles; i++) {
      startTimes[i] = -9999.0;
      pTypes[i] = 0.0;
    }

    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.velocityAttr = new THREE.BufferAttribute(velocities, 3);
    this.startTimeAttr = new THREE.BufferAttribute(startTimes, 1);
    this.pTypeAttr = new THREE.BufferAttribute(pTypes, 1);

    geometry.setAttribute("position", this.positionAttr);
    geometry.setAttribute("velocity", this.velocityAttr);
    geometry.setAttribute("startTime", this.startTimeAttr);
    geometry.setAttribute("pType", this.pTypeAttr);

    this.uniforms = { uTime: { value: 0.0 } };

    const material = new THREE.ShaderMaterial({
      vertexShader: ParticleVert,
      fragmentShader: ParticleFrag,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geometry, material);
    this.mesh.matrixAutoUpdate = false;
  }

  spawnExplosion(
    x: number,
    y: number,
    z: number,
    count = 50,
    now = 0,
    speedMult = 20,
  ) {
    for (let i = 0; i < count; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);

      const vX = (Math.random() - 0.5) * speedMult;
      const vY = (Math.random() - 0.5) * speedMult + speedMult * 0.5;
      const vZ = (Math.random() - 0.5) * speedMult;

      this.velocityAttr.setXYZ(idx, vX, vY, vZ);
      this.startTimeAttr.setX(idx, now - Math.random() * 0.1); // slight jitter
      this.pTypeAttr.setX(idx, 0.0); // Explosion type

      this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    }

    this.updateAttrs();
  }

  spawnSmoke(x: number, y: number, z: number, now: number) {
    const idx = this.currentIndex;
    this.positionAttr.setXYZ(idx, x, y, z);
    this.velocityAttr.setXYZ(
      idx,
      (Math.random() - 0.5) * 3,
      Math.random() * 4 + 2,
      (Math.random() - 0.5) * 3,
    );
    this.startTimeAttr.setX(idx, now - Math.random() * 0.2);
    this.pTypeAttr.setX(idx, 1.0); // Smoke type
    this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    this.updateAttrs();
  }

  spawnSparks(x: number, y: number, z: number, now: number) {
    for (let i = 0; i < 3; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);
      this.velocityAttr.setXYZ(
        idx,
        (Math.random() - 0.5) * 15,
        Math.random() * 15 + 5,
        (Math.random() - 0.5) * 15,
      );
      this.startTimeAttr.setX(idx, now);
      this.pTypeAttr.setX(idx, 2.0); // Spark type
      this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    }
    this.updateAttrs();
  }

  updateAttrs() {
    this.positionAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.startTimeAttr.needsUpdate = true;
    this.pTypeAttr.needsUpdate = true;
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }
}

class VolumetricExplosions {
  mesh: THREE.InstancedMesh;
  maxParticles: number;
  dummy = new THREE.Object3D();
  
  scales: Float32Array;
  lifetimes: Float32Array;
  maxLifetimes: Float32Array;
  activeFlags: Uint8Array;
  
  constructor(scene: THREE.Scene, maxParticles = 400) {
    this.maxParticles = maxParticles;
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    
    this.mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3);
    
    this.scales = new Float32Array(maxParticles);
    this.lifetimes = new Float32Array(maxParticles);
    this.maxLifetimes = new Float32Array(maxParticles);
    this.activeFlags = new Uint8Array(maxParticles);
    
    for(let i=0; i<maxParticles; i++) {
      this.dummy.position.set(0,-9999,0);
      this.dummy.scale.set(0,0,0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.activeFlags[i] = 0;
    }
    
    scene.add(this.mesh);
  }
  
  spawn(x: number, y: number, z: number, count: number, size: number) {
    let spawned = 0;
    for(let i=0; i<this.maxParticles && spawned < count; i++) {
      if (this.activeFlags[i] === 0) {
        this.activeFlags[i] = 1;
        this.lifetimes[i] = 0;
        this.maxLifetimes[i] = 0.5 + Math.random() * 0.7;
        this.scales[i] = size * (0.5 + Math.random() * 1.5);
        
        this.dummy.position.set(
          x + (Math.random() - 0.5) * size * 1.5,
          y + (Math.random() - 0.5) * size * 1.5,
          z + (Math.random() - 0.5) * size * 1.5
        );
        this.dummy.scale.set(0.1, 0.1, 0.1);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        
        spawned++;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  
  update(delta: number) {
    let needsUpdate = false;
    const colorWhite = new THREE.Color(0xffffff);
    const colorYellow = new THREE.Color(0xffaa00);
    const colorOrange = new THREE.Color(0xff3300);
    const colorGray = new THREE.Color(0x222222);
    const tempColor = new THREE.Color();
    
    for(let i=0; i<this.maxParticles; i++) {
      if (this.activeFlags[i] === 1) {
        needsUpdate = true;
        this.lifetimes[i] += delta;
        const lifeRatio = this.lifetimes[i] / this.maxLifetimes[i];
        
        if (lifeRatio >= 1.0) {
          this.activeFlags[i] = 0;
          this.dummy.scale.set(0,0,0);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
        } else {
          const scaleCurve = lifeRatio < 0.2 ? lifeRatio * 5.0 : 1.0 - (lifeRatio - 0.2) * 0.5;
          const s = this.scales[i] * scaleCurve;
          
          this.mesh.getMatrixAt(i, this.dummy.matrix);
          this.dummy.matrix.decompose(this.dummy.position, this.dummy.quaternion, this.dummy.scale);
          this.dummy.position.y += delta * 4.0;
          this.dummy.scale.set(s,s,s);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
          
          if (lifeRatio < 0.1) tempColor.copy(colorWhite);
          else if (lifeRatio < 0.3) tempColor.lerpColors(colorWhite, colorYellow, (lifeRatio-0.1)/0.2);
          else if (lifeRatio < 0.5) tempColor.lerpColors(colorYellow, colorOrange, (lifeRatio-0.3)/0.2);
          else tempColor.lerpColors(colorOrange, colorGray, (lifeRatio-0.5)/0.5);
          
          this.mesh.setColorAt(i, tempColor);
        }
      }
    }
    
    if (needsUpdate) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

// --- ENTITIES ---

class Entity {
  mesh!: THREE.Object3D;
  body!: CANNON.Body;
  active: boolean = true;
  world!: CANNON.World;
  scene!: THREE.Scene;

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.scene = scene;
    this.world = world;
  }

  update(time: number = 0) {
    if (this.active && this.mesh && this.body) {
      this.mesh.position.copy(this.body.position as any);
      // We don't copy quaternion directly because we manually bank/tilt the mesh for stylized physics
    }
  }

  destroy() {
    this.active = false;
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this.body && this.world) this.world.removeBody(this.body);
  }
}

const tempColor = new THREE.Color();
const tempVec3_1 = new CANNON.Vec3();
const tempVec3_2 = new CANNON.Vec3();

// Reusable scratch colors for biome ambient-light blending (avoids per-frame allocations).
const tempBiomeSky = new THREE.Color();
const tempBiomeGround = new THREE.Color();

class Helicopter extends Entity {
  targetPosition: THREE.Vector3;
  lastTargetPosition: THREE.Vector3;
  mainRotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  shieldMesh: THREE.Mesh | null = null;

  // Rotor blade/blur materials, crossfaded by RPM for a smooth spin look.
  mainBladeMat!: THREE.MeshLambertMaterial;
  tailBladeMat!: THREE.MeshLambertMaterial;
  mainBlurMat!: THREE.MeshBasicMaterial;
  tailBlurMat!: THREE.MeshBasicMaterial;
  rotorAngle: number = 0;
  tailRotorAngle: number = 0;

  // Subsystems
  rotorHealth: number = 100;
  engineHealth: number = 100;
  hoverFloor: number = 0;
  smoothedHoverFloor: number = 0;
  aimPosition: THREE.Vector3 = new THREE.Vector3(0, 26, -30);

  // Dash variables
  dashTimer: number = 0;
  dashDuration: number = 0.28;
  dashRollDirection: number = 0;
  dashPitchDirection: number = 0;

  triggerDash(dx: number, dz: number) {
    this.dashTimer = this.dashDuration;
    this.dashRollDirection = dx;
    this.dashPitchDirection = -dz; // Negative Z is forward
  }

  constructor(scene: THREE.Scene, world: CANNON.World) {
    super(scene, world);
    this.targetPosition = new THREE.Vector3(0, 26, 0);
    this.lastTargetPosition = new THREE.Vector3(0, 26, 0);

    const baseGroup = new THREE.Group();

    // --- APACHE HELICOPTER REDESIGN ---
    const bodyMat = createLowPolyMaterial(0x2d3a2e); // Dark Military Green
    const darkBodyMat = createLowPolyMaterial(0x1a211a);
    const glassMat = createLowPolyMaterial(0x1c2b33);
    const metalMat = createLowPolyMaterial(0x5a6360);
    const bladeMat = createLowPolyMaterial(0x161a18);
    const ordnanceMat = createLowPolyMaterial(0x212b25);
    const accentMat = createLowPolyMaterial(0xb33127);

    // Main Fuselage
    const fuselage = createBox(2.2, 1.6, 5.8, 0x2d3a2e);
    fuselage.material = bodyMat;
    fuselage.position.set(0, 0, -0.5);
    baseGroup.add(fuselage);

    // Nose & Sensor Pod
    const nose = createBox(1.5, 1.2, 2.2, 0x2d3a2e);
    nose.material = bodyMat;
    nose.position.set(0, -0.2, 3.5);
    baseGroup.add(nose);
    
    const sensorPod = createBox(0.8, 0.7, 1.0, 0x1a211a);
    sensorPod.material = darkBodyMat;
    sensorPod.position.set(0, -0.9, 4.0);
    baseGroup.add(sensorPod);

    const chinGunMount = createBox(0.5, 0.6, 0.5, 0x212b25);
    chinGunMount.material = ordnanceMat;
    chinGunMount.position.set(0, -1.0, 3.2);
    const chinBarrel = createBox(0.15, 0.15, 1.8, 0x161a18);
    chinBarrel.material = bladeMat;
    chinBarrel.position.set(0, -1.1, 4.0);
    baseGroup.add(chinGunMount, chinBarrel);

    // Tandem Cockpit
    const rearCanopy = createBox(1.2, 0.8, 1.5, 0x1c2b33);
    rearCanopy.material = glassMat;
    rearCanopy.position.set(0, 0.9, 1.2);
    rearCanopy.rotation.x = -0.05;
    baseGroup.add(rearCanopy);

    const frontCanopy = createBox(1.1, 0.6, 1.4, 0x1c2b33);
    frontCanopy.material = glassMat;
    frontCanopy.position.set(0, 0.6, 2.6);
    frontCanopy.rotation.x = -0.15;
    baseGroup.add(frontCanopy);

    // Engine Intakes (Sides)
    const engineLeft = createBox(1.0, 0.9, 2.8, 0x1a211a);
    engineLeft.material = darkBodyMat;
    engineLeft.position.set(-1.4, 0.4, -0.8);
    const engineRight = engineLeft.clone();
    engineRight.position.x = 1.4;
    baseGroup.add(engineLeft, engineRight);

    // Tail Boom
    const tailBoom = createBox(0.7, 0.9, 6.2, 0x2d3a2e);
    tailBoom.material = bodyMat;
    tailBoom.position.set(0, 0.1, -6.0);
    baseGroup.add(tailBoom);

    const tailFin = createBox(0.3, 2.4, 1.4, 0x1a211a);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 1.1, -8.4);
    tailFin.rotation.x = 0.15;
    baseGroup.add(tailFin);

    const tailStabilizer = createBox(3.0, 0.15, 0.8, 0x2d3a2e);
    tailStabilizer.material = bodyMat;
    tailStabilizer.position.set(0, 0.2, -7.8);
    baseGroup.add(tailStabilizer);

    // Stub Wings
    const stubWingLeft = createBox(3.8, 0.25, 1.4, 0x2d3a2e);
    stubWingLeft.material = bodyMat;
    stubWingLeft.position.set(-2.5, -0.1, 0.2);
    stubWingLeft.rotation.z = -0.05;
    const stubWingRight = stubWingLeft.clone();
    stubWingRight.position.x = 2.5;
    stubWingRight.rotation.z = 0.05;
    baseGroup.add(stubWingLeft, stubWingRight);

    // Pylons and Missiles
    const pylonOffsets = [-3.8, -2.6, 2.6, 3.8];
    pylonOffsets.forEach((px) => {
      const pylon = createBox(0.2, 0.5, 0.8, 0x212b25);
      pylon.material = ordnanceMat;
      pylon.position.set(px, -0.4, 0.2);
      baseGroup.add(pylon);

      // Rocket pod
      const pod = createBox(0.6, 0.6, 1.4, 0x1a211a);
      pod.material = darkBodyMat;
      pod.position.set(px, -0.8, 0.2);
      baseGroup.add(pod);

      const tip = createBox(0.2, 0.2, 0.3, 0xb33127);
      tip.material = accentMat;
      tip.position.set(px, -0.8, 0.95);
      baseGroup.add(tip);
    });

    // Landing Gear (Wheels)
    const gearStrutL = createBox(0.2, 1.2, 0.2, 0x5a6360);
    gearStrutL.material = metalMat;
    gearStrutL.position.set(-1.2, -1.2, 1.5);
    const gearStrutR = gearStrutL.clone();
    gearStrutR.position.x = 1.2;
    const gearStrutRear = createBox(0.2, 1.0, 0.2, 0x5a6360);
    gearStrutRear.material = metalMat;
    gearStrutRear.position.set(0, -0.8, -4.5);
    baseGroup.add(gearStrutL, gearStrutR, gearStrutRear);

    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8).toNonIndexed();
    wheelGeo.computeVertexNormals();
    const wheelMat = createLowPolyMaterial(0x111111);
    const wheelL = new THREE.Mesh(wheelGeo, wheelMat);
    wheelL.rotation.z = Math.PI / 2;
    wheelL.position.set(-1.3, -1.8, 1.5);
    const wheelR = wheelL.clone();
    wheelR.position.x = 1.3;
    const wheelRear = wheelL.clone();
    wheelRear.position.set(0, -1.3, -4.5);
    baseGroup.add(wheelL, wheelR, wheelRear);

    // Mast & Rotor
    const mast = createBox(0.6, 1.5, 0.6, 0x5a6360);
    mast.material = metalMat;
    mast.position.set(0, 1.4, -0.2);
    baseGroup.add(mast);

    this.mainRotor = new THREE.Group();
    this.mainRotor.position.set(0, 2.1, -0.2);
    
    // Rotor hub
    const hub = createBox(1.2, 0.2, 1.2, 0x5a6360);
    hub.material = metalMat;
    this.mainRotor.add(hub);

    // Dedicated, fadeable blade material so blades can crossfade into the blur
    // disc at high RPM (avoids the strobing/stepping "janky" look).
    const mainBladeMat = bladeMat.clone();
    mainBladeMat.transparent = true;
    this.mainBladeMat = mainBladeMat;

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.35, 0.05, 11.0, 0x161a18);
      blade.material = mainBladeMat;
      blade.position.set(0, 0, 5.5); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.y = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.mainRotor.add(bladePivot);
    }

    // Rotor Blur Disc (Transparent)
    const blurGeo = new THREE.RingGeometry(3.2, 11.5, 56);
    blurGeo.rotateX(-Math.PI / 2);
    const mainBlurMat = new THREE.MeshBasicMaterial({
      color: 0xd8f6ff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mainBlurMat = mainBlurMat;
    const blurDisc = new THREE.Mesh(blurGeo, mainBlurMat);
    blurDisc.name = "rotorBlur";
    this.mainRotor.add(blurDisc);
    baseGroup.add(this.mainRotor);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.3, 1.8, -8.5);
    
    const tailHub = createBox(0.2, 0.4, 0.4, 0x5a6360);
    tailHub.material = metalMat;
    this.tailRotor.add(tailHub);

    const tailBladeMat = bladeMat.clone();
    tailBladeMat.transparent = true;
    this.tailBladeMat = tailBladeMat;

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.05, 1.8, 0.15, 0x161a18);
      blade.material = tailBladeMat;
      blade.position.set(0, 0.9, 0); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.x = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.tailRotor.add(bladePivot);
    }
    
    const tailBlurGeo = new THREE.RingGeometry(0.45, 1.9, 28);
    tailBlurGeo.rotateY(Math.PI / 2);
    const tailBlurMat = new THREE.MeshBasicMaterial({
      color: 0xd8f6ff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.tailBlurMat = tailBlurMat;
    const tailBlurDisc = new THREE.Mesh(tailBlurGeo, tailBlurMat);
    tailBlurDisc.name = "tailBlur";
    this.tailRotor.add(tailBlurDisc);
    baseGroup.add(this.tailRotor);

    this.mesh = baseGroup;
    this.mesh.rotation.order = "YXZ";
    scene.add(this.mesh);

    this.body = new CANNON.Body({
      mass: 5,
      type: CANNON.Body.DYNAMIC,
      position: new CANNON.Vec3(0, 26, 0),
      linearDamping: 0.56,
      angularDamping: 0.9,
    });

    // Core hitbox
    const shape = new CANNON.Box(new CANNON.Vec3(1.25, 1.05, 2.35));
    this.body.addShape(shape);
    this.body.fixedRotation = true;
    this.body.updateMassProperties();
    world.addBody(this.body);
  }

  setTarget(x: number, y: number, z: number) {
    this.targetPosition.set(x, y, z);
  }

  setAim(x: number, z: number) {
    this.aimPosition.set(x, 26, z);
  }

  setHoverFloor(height: number) {
    this.hoverFloor = height;
  }

  takeDamage(amount: number) {
    // Randomly distribute damage to subsystems based on a threshold
    const criticalThreshold = 0.4; // 40% chance of subsystem damage per hit
    if (Math.random() < criticalThreshold) {
      if (Math.random() > 0.5) {
        this.engineHealth = Math.max(0, this.engineHealth - amount * 0.5);
      } else {
        this.rotorHealth = Math.max(0, this.rotorHealth - amount * 0.5);
      }
    }
  }

  repair(percent: number) {
    this.engineHealth = Math.min(100, this.engineHealth + percent);
    this.rotorHealth = Math.min(100, this.rotorHealth + percent);
  }

  reset() {
    this.active = true;
    this.rotorHealth = 100;
    this.engineHealth = 100;
    this.hoverFloor = 0;
    this.smoothedHoverFloor = 0;
    this.targetPosition.set(0, 26, 0);
    this.lastTargetPosition.set(0, 26, 0);
    this.aimPosition.set(0, 26, -30);
    this.body.position.set(0, 26, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);
    this.mesh.position.set(0, 26, 0);
    this.mesh.rotation.set(0, 0, 0);
  }

  update(
    time: number = 0,
    delta: number = 0.016,
    windForce?: CANNON.Vec3,
    particles?: GPUParticleSystem,
  ) {
    if (!this.active) return;

    if (this.dashTimer > 0) {
      this.dashTimer -= delta;

      // Visual rotation during dash
      const progress = 1.0 - (this.dashTimer / this.dashDuration);
      if (this.dashRollDirection !== 0) {
        // Sideways barrel roll!
        const rollAngle = progress * Math.PI * 2 * -this.dashRollDirection;
        this.mesh.rotation.z = rollAngle;
        this.mesh.rotation.x = Math.sin(progress * Math.PI) * -0.22; // slight dip forward
      } else if (this.dashPitchDirection !== 0) {
        // Forward/backward stunt flip!
        const pitchAngle = progress * Math.PI * 2 * this.dashPitchDirection;
        this.mesh.rotation.x = pitchAngle;
        this.mesh.rotation.z = 0;
      }

      this.mesh.position.copy(this.body.position as any);

      // Spawn spiraling particles during barrel roll or flip
      if (particles && Math.random() < 0.45) {
        const leftTip = new THREE.Vector3(-1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        const rightTip = new THREE.Vector3(1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        particles.spawnSmoke(leftTip.x, leftTip.y, leftTip.z, time);
        particles.spawnSmoke(rightTip.x, rightTip.y, rightTip.z, time);
        if (Math.random() < 0.2) {
          particles.spawnSparks(leftTip.x, leftTip.y, leftTip.z, time);
          particles.spawnSparks(rightTip.x, rightTip.y, rightTip.z, time);
        }
      }

      // Still apply gravity compensation and vertical target tracking so we don't fall/rise wildly
      this.smoothedHoverFloor +=
        (this.hoverFloor - this.smoothedHoverFloor) *
        Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.5 : 2.5));
      const hoverBob = Math.sin(time * 1.7) * 0.14;
      const targetY = Math.max(this.targetPosition.y, this.smoothedHoverFloor + 7.5) + hoverBob;
      const ey = targetY - this.body.position.y;
      const gravityComp = 9.82 * this.body.mass;
      const fy = ey * 112 - this.body.velocity.y * 38 + gravityComp;

      tempVec3_2.set(0, fy, 0);
      this.body.applyForce(tempVec3_2, this.body.position);

      this.animateRotors(80, 60, delta);
      return;
    }

    // Subsystem Penalties
    const engineEff = 0.5 + (this.engineHealth / 100) * 0.5; // Up to 50% thrust loss
    const rotorEff = 0.4 + (this.rotorHealth / 100) * 0.6; // Up to 60% agility loss

    // Hull Damage Visuals
    const hullDamage =
      1.0 - (this.rotorHealth * 0.3 + this.engineHealth * 0.7) / 100;
    this.mesh.traverse((child) => {
      if (
        child instanceof THREE.Mesh &&
        child.material instanceof THREE.MeshLambertMaterial
      ) {
        const baseColor = child.material.userData.baseColor as
          | THREE.Color
          | undefined;
        if (baseColor) {
          tempColor.setHex(0x4d171a);
          child.material.color
            .copy(baseColor)
            .lerp(tempColor, hullDamage * 0.75);
        }
      }
    });

    // Subsystem Damage Visuals (Smoke & Sparks)
    if (particles) {
      if (this.engineHealth < 60 && Math.random() < 0.15) {
        particles.spawnSmoke(
          this.mesh.position.x,
          this.mesh.position.y - 0.5,
          this.mesh.position.z,
          time,
        );
      }
      if (this.rotorHealth < 50 && Math.random() < 0.1) {
        particles.spawnSparks(
          this.mesh.position.x,
          this.mesh.position.y + 1.2,
          this.mesh.position.z,
          time,
        );
      }
    }

    // Calculate player input agility (reticle speed)
    const dxInput = this.targetPosition.x - this.lastTargetPosition.x;
    const dzInput = this.targetPosition.z - this.lastTargetPosition.z;
    const inputSpeed =
      Math.sqrt(dxInput * dxInput + dzInput * dzInput) / Math.max(delta, 0.001);
    this.lastTargetPosition.copy(this.targetPosition);

    // Responsiveness Scale (0.0 to 1.0)
    const inputAgility = Math.min(inputSpeed / 80.0, 1.0);

    const ex = this.targetPosition.x - this.body.position.x;
    const ez = this.targetPosition.z - this.body.position.z;
    const distToTarget = Math.sqrt(ex * ex + ez * ez);

    const maxCruiseSpeed = (45 + inputAgility * 15) * engineEff;
    // Position -> desired velocity. Clamped to a sane cruise speed.
    let desiredVx = THREE.MathUtils.clamp(ex * 8.0, -maxCruiseSpeed, maxCruiseSpeed);
    let desiredVz = THREE.MathUtils.clamp(ez * 8.0, -maxCruiseSpeed, maxCruiseSpeed);
    const desiredSpeed = Math.sqrt(desiredVx * desiredVx + desiredVz * desiredVz);
    if (desiredSpeed > maxCruiseSpeed) {
      desiredVx = (desiredVx / desiredSpeed) * maxCruiseSpeed;
      desiredVz = (desiredVz / desiredSpeed) * maxCruiseSpeed;
    }

    // Frame-rate-independent, critically-damped velocity tracking.
    // An exponential blend (always in 0..1) guarantees the velocity approaches
    // the target without overshooting, which removes the high-frequency
    // ringing/shaking the old stiff controller produced (its gain * dt exceeded
    // the stable integration threshold of ~1.0).
    const trackRate = (13 + inputAgility * 6) * rotorEff * engineEff;
    const blend = 1 - Math.exp(-trackRate * delta);
    const invDt = 1 / Math.max(delta, 1 / 120);
    let fx = (desiredVx - this.body.velocity.x) * blend * this.body.mass * invDt;
    let fz = (desiredVz - this.body.velocity.z) * blend * this.body.mass * invDt;

    // Apply Environmental Wind
    if (windForce) {
      fx += windForce.x * 0.35;
      fz += windForce.z * 0.35;
    }

    // Organic hover drifting
    const speed = Math.sqrt(
      this.body.velocity.x ** 2 + this.body.velocity.z ** 2,
    );
    const isIdle = inputSpeed < 2.0 && distToTarget < 3.0; // Is the player resting?

    const idleFactor = Math.max(0, 1.0 - speed / 8.0);

    const driftX = Math.sin(time * 1.2) * Math.cos(time * 0.7);
    const driftZ = Math.cos(time * 1.5) * Math.sin(time * 0.8);

    fx += driftX * idleFactor * 9;
    fz += driftZ * idleFactor * 9;

    // Arcade style: allow sufficient force to achieve the desired velocity instantly
    const maxForce = (2500 + inputAgility * 500) * engineEff;
    const forceMag = Math.sqrt(fx * fx + fz * fz);
    if (forceMag > maxForce) {
      fx = (fx / forceMag) * maxForce;
      fz = (fz / forceMag) * maxForce;
    }

    tempVec3_1.set(fx, 0, fz);
    this.body.applyForce(tempVec3_1, this.body.position);

    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.5 : 2.5));

    const hoverBob = Math.sin(time * 1.7) * 0.14;
    const targetY = Math.max(this.targetPosition.y, this.smoothedHoverFloor + 7.5) + hoverBob;
    const ey = targetY - this.body.position.y;

    const gravityComp = 9.82 * this.body.mass;
    const fy = ey * 112 - this.body.velocity.y * 38 + gravityComp;

    tempVec3_2.set(0, fy, 0);
    this.body.applyForce(tempVec3_2, this.body.position);

    // Heading targeting (mouse aim has priority over movement direction)
    let targetAngle = this.mesh.rotation.y;
    const aimDx = this.aimPosition.x - this.body.position.x;
    const aimDz = this.aimPosition.z - this.body.position.z;
    if (Math.sqrt(aimDx * aimDx + aimDz * aimDz) > 2) {
      targetAngle = Math.atan2(aimDx, aimDz);
    } else if (!isIdle) {
      targetAngle = Math.atan2(ex, ez);
    }

    let currentAngle = this.mesh.rotation.y;
    let diff = targetAngle - currentAngle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    // Turn faster when input is aggressive
    const turnTurnSpeed = (0.22 + inputAgility * 0.15) * rotorEff;
    this.mesh.rotation.y += diff * turnTurnSpeed;

    this.mesh.position.copy(this.body.position as any);

    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);
    // Transform velocity to local space (Z forward, X right)
    const localVx = this.body.velocity.x * cy - this.body.velocity.z * sy;
    const localVz = this.body.velocity.x * sy + this.body.velocity.z * cy;

    // Auto-Stabilization: Suppress tilt if idling to gently correct rotation
    const tiltMultiplier = isIdle ? 0.22 : 1.25;

    // Transform applied forces to local space to tilt/roll based on thrust/acceleration
    const localFx = fx * cy - fz * sy;
    const localFz = fx * sy + fz * cy;

    // Visual Tilting: Pitch DOWN when accelerating forward (positive localVz/negative localFz)
    // and pitch UP (flare) when braking. Roll INTO turns based on lateral forces.
    const tiltCap = 0.52;
    const targetTiltX =
      THREE.MathUtils.clamp(localFz * 0.00028 + localVz * 0.0035, -tiltCap, tiltCap) * tiltMultiplier;
    const targetTiltZ =
      -THREE.MathUtils.clamp(localFx * 0.00028 + localVx * 0.0035, -tiltCap, tiltCap) * tiltMultiplier;

    const tiltSmoothing =
      (isIdle ? 0.055 : 0.16 + inputAgility * 0.08) * rotorEff;
    this.mesh.rotation.x +=
      (targetTiltX - this.mesh.rotation.x) * tiltSmoothing;
    this.mesh.rotation.z +=
      (targetTiltZ - this.mesh.rotation.z) * tiltSmoothing;

    // Spool up rotors based on load + Damage Jitter
    const rotorJitter = this.rotorHealth < 30 ? Math.sin(time * 60) * 0.05 : 0;
    this.mainRotor.position.y = 2.1 + rotorJitter; // Adjusted for Apache mast height

    this.animateRotors(inputSpeed, 60, delta);
  }
  rotorSpeed: number = 0;

  animateRotors(forceMag: number, maxForce: number, delta: number) {
    const rotorEff = this.rotorHealth / 100;

    // Angular speed in radians/sec, frame-rate independent.
    const load = THREE.MathUtils.clamp(forceMag / Math.max(maxForce, 1), 0, 1);
    const targetSpeed = (42 + load * 24) * rotorEff;
    const spool = 1 - Math.exp(-delta * 8.0);
    this.rotorSpeed = THREE.MathUtils.lerp(this.rotorSpeed, targetSpeed, spool);

    // Crossfade factor: 0 = slow (crisp blades), 1 = fast (solid blur disc).
    // Blades stop being drawn at speed, so there is no strobing/wagon-wheel jank.
    const blend = THREE.MathUtils.clamp((this.rotorSpeed - 9) / 13, 0, 1);
    const smoothBlend = blend * blend * (3 - 2 * blend); // smoothstep

    // While blades are still visible, cap their visual rotation so individual
    // blades never step more than the Nyquist limit between frames.
    const cappedSpeed = THREE.MathUtils.lerp(Math.min(this.rotorSpeed, 18), this.rotorSpeed, smoothBlend);
    this.rotorAngle -= cappedSpeed * delta;
    this.tailRotorAngle -= cappedSpeed * 1.35 * delta;
    this.mainRotor.rotation.y = this.rotorAngle;
    this.tailRotor.rotation.x = this.tailRotorAngle;

    // Fade blades out and the blur disc in as RPM climbs.
    const bladeOpacity = 1 - smoothBlend * 0.82;
    this.mainBladeMat.opacity = bladeOpacity;
    this.tailBladeMat.opacity = bladeOpacity;
    this.mainBlurMat.opacity = smoothBlend * 0.34;
    this.tailBlurMat.opacity = smoothBlend * 0.34;
  }
}

export enum EnemyType {
  BASIC,
  SHOOTER,
  TANK,
  DRONE,
  BOSS,
}

export enum WeaponType {
  MACHINE_GUN,
  MISSILE,
  ROCKET,
  SHOTGUN,
}

interface WeaponConfig {
  name: string;
  damage: number;
  fireRate: number; // seconds between shots
  ammo: number;
  maxAmmo: number;
  reloadTime: number; // seconds to reload
  speed: number; // projectile speed
  count: number; // projectiles per shot
  spread: number; // spread angle for shotguns
  blastRadius: number;
  color: number;
  homing: boolean;
}

const WEAPON_CONFIGS: Record<WeaponType, WeaponConfig> = {
  [WeaponType.MACHINE_GUN]: {
    name: 'Machine Gun',
    damage: 13,
    fireRate: 0.055,
    ammo: 300,
    maxAmmo: 300,
    reloadTime: 1.5,
    speed: 430,
    count: 2,
    spread: 0.015,
    blastRadius: 0,
    color: 0xff2a2a,
    homing: false,
  },
  [WeaponType.MISSILE]: {
    name: 'Missile',
    damage: 55,
    fireRate: 0.95,
    ammo: 20,
    maxAmmo: 20,
    reloadTime: 2.5,
    speed: 260,
    count: 1,
    spread: 0,
    blastRadius: 16,
    color: 0x44ff44,
    homing: true,
  },
  [WeaponType.ROCKET]: {
    name: 'Rocket',
    damage: 80,
    fireRate: 1.45,
    ammo: 12,
    maxAmmo: 12,
    reloadTime: 3.2,
    speed: 235,
    count: 1,
    spread: 0,
    blastRadius: 28,
    color: 0xffaa00,
    homing: false,
  },
  [WeaponType.SHOTGUN]: {
    name: 'Shotgun',
    damage: 10,
    fireRate: 0.45,
    ammo: 40,
    maxAmmo: 40,
    reloadTime: 2.0,
    speed: 280,
    count: 6,
    spread: 0.3,
    blastRadius: 0,
    color: 0xffdd22,
    homing: false,
  },
};

export enum PowerUpType {
  HEALTH,
  DAMAGE_BOOST,
  SHIELD,
  AMMO,
  SPEED_BOOST,
  BOMB,
  FUEL,
}

export enum PowerUpState {
  IDLE,
  COLLECTING,
  COLLECTED,
}

class Enemy extends Entity {
  ring: THREE.Object3D;
  hp: number;
  maxHp: number;
  type: EnemyType;
  lastShotTime: number = 0;
  basePoints: number = 50;

  personalityOffset: number;
  evadeTimer: number = 0;
  lastDecisionTime: number = 0;
  flankDir: number = 1;
  enemyRotor: THREE.Group | null = null;
  enemyTailRotor: THREE.Group | null = null;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    x: number,
    z: number,
    type: EnemyType = EnemyType.BASIC,
    y: number = 18,
  ) {
    super(scene, world);
    this.type = type;
    this.personalityOffset = Math.random() * Math.PI * 2;
    this.flankDir = Math.random() > 0.5 ? 1 : -1;

    const baseGroup = new THREE.Group();

    let radius = 2.2;
    let coreHex = 0xffd92e;
    let accentHex = 0xff3b22;

    if (type === EnemyType.TANK) {
      radius = 3.0;
      coreHex = 0xffb51f;
      accentHex = 0xff2a1d;
      this.maxHp = 100;
      this.basePoints = 200;
    } else if (type === EnemyType.SHOOTER) {
      radius = 2.0;
      coreHex = 0xffe85b;
      accentHex = 0xff3b22;
      this.maxHp = 30;
      this.basePoints = 100;
    } else if (type === EnemyType.DRONE) {
      radius = 1.8;
      coreHex = 0x44ddff;
      accentHex = 0x2299cc;
      this.maxHp = 15;
      this.basePoints = 150;
    } else if (type === EnemyType.BOSS) {
      radius = 4.1;
      coreHex = 0xd84cff;
      accentHex = 0x6b1fc2;
      this.maxHp = 220;
      this.basePoints = 500;
    } else {
      this.maxHp = 20; // Basic
    }

    this.hp = this.maxHp;

    if (type === EnemyType.BOSS) {
      // Big Boss Helicopter
      this.ring = new THREE.Group();
      this.ring.position.y = 0.2;

      const hull = createBox(radius * 1.1, radius * 0.75, radius * 1.9, coreHex);
      this.ring.add(hull);

      const tailBoom = createBox(radius * 0.3, radius * 0.3, radius * 1.8, coreHex);
      tailBoom.position.set(0, 0, -radius * 1.4);
      this.ring.add(tailBoom);

      const tailFin = createBox(radius * 0.12, radius * 0.75, radius * 0.35, accentHex);
      tailFin.position.set(0, radius * 0.35, -radius * 2.1);
      this.ring.add(tailFin);

      const glass = createBox(radius * 0.6, radius * 0.4, radius * 0.7, 0x172f3d);
      glass.position.set(0, radius * 0.2, radius * 0.95);
      this.ring.add(glass);

      // Main rotor
      const rotorGroup = new THREE.Group();
      rotorGroup.position.set(0, radius * 0.65, 0);
      for (let i = 0; i < 4; i++) {
        const blade = createBox(radius * 0.12, radius * 0.03, radius * 1.5, 0x111111);
        blade.rotation.y = (i * Math.PI) / 2;
        blade.position.z = radius * 0.7;
        rotorGroup.add(blade);
      }
      this.ring.add(rotorGroup);
      this.enemyRotor = rotorGroup;

      // Tail rotor
      const tailRotorGroup = new THREE.Group();
      tailRotorGroup.position.set(radius * 0.2, radius * 0.35, -radius * 2.1);
      for (let i = 0; i < 2; i++) {
        const blade = createBox(radius * 0.03, radius * 0.08, radius * 0.45, 0x111111);
        blade.rotation.x = (i * Math.PI) / 2;
        tailRotorGroup.add(blade);
      }
      this.ring.add(tailRotorGroup);
      this.enemyTailRotor = tailRotorGroup;

      baseGroup.add(this.ring);

    } else if (type === EnemyType.TANK) {
      // Flakpanzer (Anti-Air Tank)
      this.ring = new THREE.Group();
      
      const tracksL = createBox(1.2, 0.6, 3.8, 0x111111);
      tracksL.position.set(-1.4, -0.2, 0);
      const tracksR = createBox(1.2, 0.6, 3.8, 0x111111);
      tracksR.position.set(1.4, -0.2, 0);
      
      const hull = createBox(2.2, 0.9, 3.4, coreHex);
      hull.position.set(0, 0.3, 0);
      
      const turret = createBox(1.8, 0.8, 2.0, accentHex);
      turret.position.set(0, 1.1, -0.2);
      
      const barrelL = createBox(0.2, 0.2, 2.2, 0x333333);
      barrelL.position.set(-0.5, 1.2, 1.6);
      const barrelR = barrelL.clone();
      barrelR.position.x = 0.5;
      
      this.ring.add(tracksL, tracksR, hull, turret, barrelL, barrelR);
      baseGroup.add(this.ring);

    } else if (type === EnemyType.DRONE) {
      // Quadcopter
      this.ring = new THREE.Group();
      
      const core = createBox(1.2, 0.5, 1.2, coreHex);
      this.ring.add(core);
      
      const sensor = createBox(0.6, 0.4, 0.6, accentHex);
      sensor.position.set(0, -0.3, 0.4);
      this.ring.add(sensor);
      
      this.enemyRotor = new THREE.Group();
      const armOffsets = [
        [-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]
      ];
      
      armOffsets.forEach(([px, pz]) => {
        const arm = createBox(1.6, 0.15, 0.15, 0x333333);
        arm.position.set(px/2, 0, pz/2);
        arm.rotation.y = Math.atan2(pz, px);
        this.ring.add(arm);
        
        const motor = createBox(0.4, 0.6, 0.4, accentHex);
        motor.position.set(px, 0.1, pz);
        this.ring.add(motor);
        
        const bladeGroup = new THREE.Group();
        bladeGroup.position.set(px, 0.45, pz);
        const blade = createBox(1.5, 0.05, 0.2, 0x111111);
        bladeGroup.add(blade);
        this.enemyRotor!.add(bladeGroup);
      });
      this.ring.add(this.enemyRotor);
      baseGroup.add(this.ring);

    } else {
      // Heavy Gunship (SHOOTER & BASIC)
      this.ring = new THREE.Group();
      
      const fuselage = createBox(radius * 0.9, radius * 0.7, radius * 2.2, coreHex);
      this.ring.add(fuselage);
      
      const wing = createBox(radius * 2.8, radius * 0.15, radius * 0.6, coreHex);
      wing.position.set(0, 0, -radius * 0.2);
      this.ring.add(wing);
      
      const engineL = createBox(radius * 0.4, radius * 0.4, radius * 0.8, accentHex);
      engineL.position.set(-radius * 0.9, 0, -radius * 0.2);
      const engineR = engineL.clone();
      engineR.position.x = radius * 0.9;
      this.ring.add(engineL, engineR);
      
      const cockpit = createBox(radius * 0.5, radius * 0.4, radius * 0.8, 0x172f3d);
      cockpit.position.set(0, radius * 0.4, radius * 0.6);
      this.ring.add(cockpit);
      
      baseGroup.add(this.ring);
    }

    this.mesh = baseGroup;
    scene.add(this.mesh);

    this.body = new CANNON.Body({
      mass: type === EnemyType.TANK ? 100 : 0,
      type: CANNON.Body.KINEMATIC,
      position: new CANNON.Vec3(x, y, z),
    });

    const shape = new CANNON.Box(
      new CANNON.Vec3(radius, radius * 0.75, radius),
    );
    this.body.addShape(shape);
    world.addBody(this.body);
  }

  // Returns true if destroyed
  takeDamage(amt: number): boolean {
    this.hp -= amt;
    if (this.hp <= 0) {
      this.active = false;
      return true;
    }
    return false;
  }

  updateDirection(
    targetPos: CANNON.Vec3,
    time: number,
    enemyProjectilePool: ProjectilePool,
    playerBullets: Projectile[],
    allEnemies: Enemy[],
  ) {
    if (!this.active) return false;

    const dx = targetPos.x - this.body.position.x;
    const dz = targetPos.z - this.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) + 0.001;

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // DRONE: Chase player with swooping movement
    if (this.type === EnemyType.DRONE) {
      const speed = 35;
      const swoopX = Math.cos(time * 2 + this.personalityOffset) * 15;
      const swoopZ = Math.sin(time * 2 + this.personalityOffset) * 15;
      this.body.velocity.set(dirX * speed + swoopX, 0, dirZ * speed + swoopZ);

      // Drones fire rapidly at close range
      let fired = false;
      if (dist < 60 && time - this.lastShotTime > 0.8) {
        this.lastShotTime = time;
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 0.35,
          this.body.position.z,
          dirX,
          dirZ,
          time,
          160,
        );
        fired = true;
      }

      this.mesh.position.copy(this.body.position as any);
      this.mesh.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.x = Math.sin(time * 5) * 0.1;

      // Bob up and down
      this.mesh.position.y += Math.sin(time * 3 + this.personalityOffset) * 0.5;

      return fired;
    }

    let speed = 0;
    if (this.type === EnemyType.TANK) speed = 15;
    else if (this.type === EnemyType.SHOOTER) speed = 20;
    else if (this.type === EnemyType.BOSS) speed = 10;
    else if (this.type === EnemyType.BASIC) speed = 18;

    // AI Evasive and Flanking logic
    if (time - this.lastDecisionTime > 2.0 + Math.random() * 2.0) {
      this.lastDecisionTime = time;
      if (Math.random() > 0.5) this.flankDir *= -1;
      
      if (Math.random() > 0.7) {
        this.evadeTimer = time + 0.5 + Math.random() * 1.0;
      }
    }

    const isEvading = time < this.evadeTimer;
    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;

    if (dist > 45) {
      // Approach directly
      this.body.velocity.set(dirX * speed, 0, dirZ * speed);
    } else if (dist < 20 || isEvading) {
      // Evade / back away and strafe
      this.body.velocity.set((-dirX + tangentX * 1.5) * speed * 0.7, 0, (-dirZ + tangentZ * 1.5) * speed * 0.7);
    } else {
      // Orbit (strafe)
      this.body.velocity.set((tangentX + dirX * 0.2) * speed * 0.6, 0, (tangentZ + dirZ * 0.2) * speed * 0.6);
    }

    // Firing Logic
    let fired = false;
    const fireRange =
      this.type === EnemyType.BOSS ? 130 : this.type === EnemyType.TANK ? 95 : 75;
    const fireRate =
      this.type === EnemyType.BOSS
        ? 2.2
        : this.type === EnemyType.SHOOTER
        ? 1.5
        : this.type === EnemyType.TANK
          ? 3.5
          : 2.4;
    if (dist < fireRange && time - this.lastShotTime > fireRate) {
      this.lastShotTime = time + Math.random() * 0.35;
      const shotCount = this.type === EnemyType.BOSS ? 5 : 1;
      const spread = this.type === EnemyType.BOSS ? 0.17 : 0;
      for (let i = 0; i < shotCount; i++) {
        let shotDirX = dirX;
        let shotDirZ = dirZ;
        if (spread > 0) {
          const angle = (i - (shotCount - 1) / 2) * spread;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          shotDirX = dirX * cos - dirZ * sin;
          shotDirZ = dirX * sin + dirZ * cos;
        }
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 0.35,
          this.body.position.z,
          shotDirX,
          shotDirZ,
          time,
          this.type === EnemyType.TANK ? 95 : this.type === EnemyType.BOSS ? 115 : 130,
        );
      }
      fired = true;
    }

    this.mesh.position.copy(this.body.position as any);
    this.mesh.rotation.y = Math.atan2(dirX, dirZ);
    this.ring.rotation.y = Math.atan2(dirX, dirZ);
    this.ring.rotation.x = Math.sin(time * 3 + this.personalityOffset) * 0.04;

    if (this.enemyRotor) {
      this.enemyRotor.rotation.y = time * 24.0;
    }
    if (this.enemyTailRotor) {
      this.enemyTailRotor.rotation.x = time * 28.0;
    }

    return fired;
  }
}

class Projectile {
  active = false;
  mesh: THREE.Mesh;
  pos: CANNON.Vec3 = new CANNON.Vec3();
  prevPos: CANNON.Vec3 = new CANNON.Vec3();
  vel: CANNON.Vec3 = new CANNON.Vec3();
  spawnTime = 0;
  damage = 10;
  blastRadius = 0;
  target: EnemyLock | null = null;
  homingStrength = 0;
  lifetime = 1.35;

  constructor(scene: THREE.Scene, colorHex: number) {
    let geom = new THREE.CylinderGeometry(0.035, 0.32, 8.8, 6).toNonIndexed();
    geom.rotateX(Math.PI / 2); // Align with Z axis
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
    });
    this.mesh = new THREE.Mesh(geom, mat);

    const glowGeom = new THREE.CylinderGeometry(0.2, 0.82, 11.6, 6).toNonIndexed();
    glowGeom.rotateX(Math.PI / 2);
    glowGeom.computeVertexNormals();

    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeom, glowMat);
    this.mesh.add(glow);

    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
  ) {
    this.active = true;
    this.mesh.visible = true;
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);

    this.vel.set(dx * speed, 0, dz * speed);
    this.spawnTime = now;
    this.damage = damage;
    this.blastRadius = blastRadius;
    this.target = target;
    this.homingStrength = homingStrength;
    this.lifetime = Math.max(1.1, Math.min(2.2, 390 / Math.max(speed, 1)));

    if (color !== undefined) {
      this.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.color.setHex(color);
        }
      });
    }

    const angle = Math.atan2(dx, dz);
    this.mesh.rotation.y = angle;
  }

  update(now: number, delta: number, particles?: GPUParticleSystem) {
    this.prevPos.copy(this.pos);

    if (this.homingStrength > 0 && this.target?.active) {
      const dx = this.target.body.position.x - this.pos.x;
      const dz = this.target.body.position.z - this.pos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
      if (len > 0.001 && speed > 0.001) {
        const turn = Math.min(1, this.homingStrength * delta);
        const nextX = THREE.MathUtils.lerp(this.vel.x / speed, dx / len, turn);
        const nextZ = THREE.MathUtils.lerp(this.vel.z / speed, dz / len, turn);
        const nextLen = Math.sqrt(nextX * nextX + nextZ * nextZ) || 1;
        this.vel.x = (nextX / nextLen) * speed;
        this.vel.z = (nextZ / nextLen) * speed;
        this.vel.y +=
          (this.target.body.position.y + 0.4 - this.pos.y) *
          this.homingStrength *
          0.2 *
          delta;
        this.vel.y = THREE.MathUtils.clamp(this.vel.y, -60, 60);
      }
    }

    this.pos.x += this.vel.x * delta;
    this.pos.y += this.vel.y * delta;
    this.pos.z += this.vel.z * delta;

    if (particles && this.active && this.blastRadius > 0) {
      // Missile / Rocket Trails (Smoke and Engine Flame)
      if (Math.random() < 0.6) {
        particles.spawnSmoke(this.pos.x, this.pos.y, this.pos.z, now);
      }
      if (Math.random() < 0.25) {
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now);
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now); // Double sparks for engine flame
      }
    }

    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    this.mesh.updateMatrix();

    // Dynamic fade-out over lifetime
    const age = now - this.spawnTime;
    const lifeRatio = age / this.lifetime;
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        const baseOpacity = child === this.mesh ? 0.95 : 0.3;
        child.material.opacity = baseOpacity * Math.max(0, 1.0 - lifeRatio);
      }
    });

    if (now - this.spawnTime > this.lifetime) {
      this.deactivate();
    }
  }

  deactivate() {
    this.active = false;
    this.mesh.visible = false;
  }
}

function distancePointToProjectileSegmentSq(
  point: CANNON.Vec3,
  from: CANNON.Vec3,
  to: CANNON.Vec3,
) {
  const sx = to.x - from.x;
  const sz = to.z - from.z;
  const lenSq = sx * sx + sz * sz;
  if (lenSq < 0.0001) {
    const dx = point.x - to.x;
    const dz = point.z - to.z;
    return dx * dx + dz * dz;
  }

  const t = THREE.MathUtils.clamp(
    ((point.x - from.x) * sx + (point.z - from.z) * sz) /
      lenSq,
    0,
    1,
  );
  const closestX = from.x + sx * t;
  const closestZ = from.z + sz * t;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  return dx * dx + dz * dz;
}

// --- POWERUP CLASS ---

class PowerUp {
  mesh: THREE.Group;
  type: PowerUpType;
  active: boolean = true;
  position: THREE.Vector3;
  spawnTime: number = 0;
  lifetime: number = 22; // 22 seconds lifetime

  constructor(
    scene: THREE.Scene,
    x: number,
    y: number,
    z: number,
    type: PowerUpType,
  ) {
    this.type = type;
    this.position = new THREE.Vector3(x, y, z);
    this.mesh = new THREE.Group();

    // Create powerup visual based on type
    const colors: Record<PowerUpType, number> = {
      [PowerUpType.HEALTH]: 0x22ff44,
      [PowerUpType.DAMAGE_BOOST]: 0xff4422,
      [PowerUpType.SHIELD]: 0x4488ff,
      [PowerUpType.AMMO]: 0xffdd22,
      [PowerUpType.SPEED_BOOST]: 0xff88ff,
      [PowerUpType.BOMB]: 0xff6600,
      [PowerUpType.FUEL]: 0x37ffb8,
    };

    const color = colors[type];

    // Floating diamond shape
    const geom = new THREE.OctahedronGeometry(1.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(geom, mat);
    this.mesh.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.0, 12, 8),
      createGlowMaterial(color, 0.18),
    );
    this.mesh.add(halo);

    // Outer glow ring
    const ringGeom = new THREE.TorusGeometry(2.2, 0.15, 8, 16);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    this.mesh.add(ring);

    const verticalRing = new THREE.Mesh(ringGeom, ringMat.clone());
    verticalRing.rotation.y = Math.PI / 2;
    this.mesh.add(verticalRing);

    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }

  update(time: number, delta: number) {
    if (!this.active) return;

    // Rotate and bob
    this.mesh.rotation.y += delta * 2;
    this.mesh.rotation.x += delta * 0.5;
    this.mesh.rotation.z += delta * 0.35;
    this.mesh.position.y = this.position.y + Math.sin(time * 3) * 0.5;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.mesh.scale.setScalar(pulse);

    // Check lifetime
    if (time - this.spawnTime > this.lifetime) {
      this.active = false;
    }
  }


  destroy(scene: THREE.Scene) {
    this.active = false;
    scene.remove(this.mesh);
  }

  checkCollection(playerPos: THREE.Vector3): boolean {
    if (!this.active) return false;
    // For arcade shooter feel, ignore the height (Y) difference and use a generous radius
    const dx = this.mesh.position.x - playerPos.x;
    const dz = this.mesh.position.z - playerPos.z;
    const distSq = dx * dx + dz * dz;
    return distSq < 196; // Radius of 14 for easier collection
  }
}

class ProjectilePool {
  pool: Projectile[] = [];

  constructor(scene: THREE.Scene, count: number, colorHex: number = 0x55ff55) {
    for (let i = 0; i < count; i++) {
      const p = new Projectile(scene, colorHex);
      this.pool.push(p);
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number = 250,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
  ): Projectile | null {
    const p = this.pool.find((b) => !b.active);
    if (p) {
      p.spawn(x, y, z, dx, dz, now, speed, damage, blastRadius, color, target, homingStrength);
      return p;
    }
    return null;
  }

  deactivateAll() {
    for (const p of this.pool) {
      p.deactivate();
    }
  }

  updatePositions(now: number, delta: number, particles?: GPUParticleSystem) {
    for (const p of this.pool) {
      if (p.active) p.update(now, delta, particles);
    }
  }

  checkEnemyHits(enemies: Enemy[], onHit: (p: Projectile, e: Enemy) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      for (const e of enemies) {
        if (!e.active) continue;
        const hitRadius =
          e.type === EnemyType.BOSS
            ? 7.2
            : e.type === EnemyType.TANK
              ? 6.2
              : e.type === EnemyType.DRONE
                ? 4.7
                : 5.1;
        const distSq = distancePointToProjectileSegmentSq(
          e.body.position,
          p.prevPos,
          p.pos,
        );
        if (distSq < hitRadius * hitRadius) {
          onHit(p, e);
          p.deactivate();
          break;
        }
      }
    }
  }

  checkPlayerHits(playerPos: CANNON.Vec3, onHit: (p: Projectile) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const distSq = distancePointToProjectileSegmentSq(playerPos, p.prevPos, p.pos);
      if (distSq < 16) {
        onHit(p);
        p.deactivate();
      }
    }
  }
}

// --- MAIN ENGINE ---

export class GameEngine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cameraLookAtTarget: THREE.Vector3 = new THREE.Vector3();
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  usePostProcessing = false;
  world: CANNON.World;
  city: CityEnvironment;

  helicopter: Helicopter;
  enemies: Enemy[] = [];

  playerProjectiles: ProjectilePool;
  enemyProjectiles: ProjectilePool;

  particles: GPUParticleSystem;
  volumetricExplosions: VolumetricExplosions;
  rain: RainSystem;
  weather: WeatherSystem;
  audio: AudioManager;
  lastTime: number = 0;

  // Biome atmosphere
  ambientLight!: THREE.HemisphereLight;
  currentBiome: BiomeName | null = null;
  private ambientSkyColor = new THREE.Color(0xe9fbff);
  private ambientGroundColor = new THREE.Color(0x4a5576);

  settings = {
    invertedY: false,
    gamepadSensitivity: 1.5,
    masterVolume: 0.5,
    muted: false,
    highQuality: false,
  };

  bloomPass: UnrealBloomPass;

  gamepadIndex: number | null = null;
  isMouseActive: boolean = true;
  movementKeys: Set<string> = new Set();
  leftStick: StickInput = { x: 0, y: 0, active: false };
  rightStick: StickInput = { x: 0, y: 0, active: false };
  movementTarget: THREE.Vector3 = new THREE.Vector3(0, 26, 0);
  keyboardVelocity: THREE.Vector2 = new THREE.Vector2(0, 0);
  hasInputThisFrame: boolean = false;
  aimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -35);
  mouseAimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -55);
  mouseAimValid: boolean = false;
  autoAimTarget: Enemy | null = null;
  lastCollisionDamageTime = 0;

  raycaster: THREE.Raycaster = new THREE.Raycaster();
  mousePlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -26);
  mouseNDC: THREE.Vector2 = new THREE.Vector2(0, 0);

  targetGroup: THREE.Group;
  innerRing: THREE.Mesh;
  outerRing: THREE.Mesh;

  animationFrame = 0;
  lightningTimeout: number | null = null;
  disposed = false;
  isPlaying = false;
  gameOverDispatched = false;
  isFiringMouse = false;
  isFiringGamepad = false;
  cameraShake = 0;
  score = 0;
  health = 100;
  maxHealth = 100;
  currentFuel = 100;
  maxFuel = 100;
  fuelDrainPerSecond = 0.85;
  lastStatsHealth = -1;
  lastStatsFuel = -1;
  lastUiUpdateTime = -Infinity;
  autoScrollSpeed = 28;
  survivalTime = 0;
  combatIntensity = 0;
  directorTimer = 0;
  battlefieldEventTimer = 18;
  lastSpawnSoundTime = 0;
  lastBuildingHitSoundTime = 0;
  lastEnemyFireSoundTime = 0;

  // Wave System
  currentWave: number = 0;
  enemiesSpawnedInWave: number = 0;
  totalEnemiesInWave: number = 0;
  spawnTimer: number = 0;
  waveTransitionTimer: number = 3.0; // Wait 3s before starting wave 1
  waveMessage: string = "GET READY";

  // Power-up System
  powerups: PowerUp[] = [];
  powerupSpawnTimer: number = 0;

  spawnPeriodicPowerUp() {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.55) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.55) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.55) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }
    
    const player = this.helicopter.body.position;
    const lanes = [-52, -24, 0, 24, 52];
    const laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 8;
    const spawnZ = player.z - 75 - Math.random() * 45;
    const spawnY = Math.max(3.0, this.city.getHeightAt(laneX, spawnZ, 3) + 2.0);
    
    const pu = new PowerUp(this.scene, laneX, spawnY, spawnZ, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  }

  // Combo System
  comboCount: number = 0;
  comboTimer: number = 0;
  comboMultiplier: number = 1;
  maxCombo: number = 0;

  // Damage Boost & Shield
  damageBoostTimer: number = 0;
  shieldTimer: number = 0;
  speedBoostTimer: number = 0;

  // Time dilation & Hit-Stop
  timeScale: number = 1.0;
  hitStopTimer: number = 0;

  triggerHitStop(duration: number, scale: number = 0.05) {
    this.hitStopTimer = duration;
    this.timeScale = scale;
  }

  // Dash variables
  dashCooldownTimer: number = 0;
  dashActiveTimer: number = 0;
  dashDirection: CANNON.Vec3 = new CANNON.Vec3();
  lastTapTime: { [key: string]: number } = {};

  // Hit marker for visual feedback
  hitMarkerTimer: number = 0;
  hitMarkerPosition: THREE.Vector3 = new THREE.Vector3();

  // Weapon System
  currentWeapon: WeaponType = WeaponType.MACHINE_GUN;
  weapons: Map<WeaponType, WeaponConfig> = new Map();
  lastFireTime: number = 0;
  muzzleFlip: number = 1;
  reloadTimer: number = 0;
  isReloading: boolean = false;
  isPaintingLocks: boolean = false;
  salvoLocks: Enemy[] = [];
  salvoCooldownTimer: number = 0;
  lastLockPaintTime: number = 0;
  salvoCooldown: number = 5.0;
  lockPaintInterval: number = 0.18;
  lockSearchRadius: number = 38;
  salvoLockIndicators: Map<Enemy, THREE.Group> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
    this.renderer.setClearColor(SKY_CLEAR_COLOR);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_CLEAR_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_CLEAR_COLOR, 0.0026);
    this.scene.add(createSkyDome());

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      300,
    );
    this.camera.position.set(0, 62, 46);
    this.camera.lookAt(0, 0, 0);

    // EffectComposer Setup
    this.composer = new EffectComposer(this.renderer);
    
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.82;
    bloomPass.strength = 0.72;
    bloomPass.radius = 0.42;
    this.bloomPass = bloomPass;
    if (this.usePostProcessing) this.composer.addPass(bloomPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    this.world = new CANNON.World();
    this.world.gravity.set(0, -9.82, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    const ambient = new THREE.HemisphereLight(0xffffff, 0xa9b6bf, 1.55);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const softKey = new THREE.DirectionalLight(0xfff6e8, 1.85);
    softKey.position.set(-48, 86, 54);
    softKey.castShadow = true;
    softKey.shadow.camera.left = -180;
    softKey.shadow.camera.right = 180;
    softKey.shadow.camera.top = 180;
    softKey.shadow.camera.bottom = -180;
    softKey.shadow.camera.near = 0.5;
    softKey.shadow.camera.far = 340;
    softKey.shadow.mapSize.width = 2048;
    softKey.shadow.mapSize.height = 2048;
    softKey.shadow.bias = -0.00018;
    this.scene.add(softKey);

    const rimLight = new THREE.DirectionalLight(0xeaf4ff, 0.35);
    rimLight.position.set(65, 50, -85);
    this.scene.add(rimLight);

    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(8, 18, 10),
      createGlowMaterial(0xffdd7a, 0.58),
    );
    sunCore.position.set(-116, 118, -178);
    sunCore.renderOrder = -2;
    this.scene.add(sunCore);

    this.city = new CityEnvironment(this.scene, this.world);
    this.city.onBuildingDestroyed = (x, y, z) => {
      if (this.volumetricExplosions) {
        this.volumetricExplosions.spawn(x, y, z, 20, 6.0);
      }
      if (this.audio) {
        this.audio.playExplosion(1.0);
      }
      this.cameraShake = Math.max(this.cameraShake, 3.5);
      this.score += Math.floor(50 * this.comboMultiplier);
      this.triggerHitStop(0.12, 0.04); // Crunchy freeze on building collapse
    };

    this.helicopter = new Helicopter(this.scene, this.world);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);

    this.playerProjectiles = new ProjectilePool(this.scene, 150, 0xff2a2a);
    this.enemyProjectiles = new ProjectilePool(this.scene, 100, 0xffe94a);

    this.particles = new GPUParticleSystem(5000);
    this.scene.add(this.particles.mesh);
    this.city.particles = this.particles;
    
    this.volumetricExplosions = new VolumetricExplosions(this.scene);

    this.rain = new RainSystem(5000);
    this.scene.add(this.rain.mesh);
    this.rain.mesh.visible = false;

    this.weather = new WeatherSystem();
    this.audio = new AudioManager();

    // Dynamic Crosshair Reticle
    this.targetGroup = new THREE.Group();
    this.targetGroup.position.set(this.aimPoint.x, 26.2, this.aimPoint.z);
    this.targetGroup.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.58,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.innerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.3, 16),
      ringMat,
    );
    this.innerRing.rotation.x = -Math.PI / 2;
    this.outerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 2.0, 32),
      ringMat,
    );
    this.outerRing.rotation.x = -Math.PI / 2;

    const pipMat = createGlowMaterial(0xffffff, 0.58);
    for (let i = 0; i < 4; i++) {
      const pip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 1.5), pipMat);
      pip.position.z = 2.9;
      const pivot = new THREE.Group();
      pivot.rotation.y = (Math.PI / 2) * i;
      pivot.add(pip);
      this.targetGroup.add(pivot);
    }

    this.targetGroup.add(this.innerRing, this.outerRing);
    this.scene.add(this.targetGroup);
    this.renderer.domElement.style.cursor = "crosshair";

    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("helistrike:left-stick", this.onLeftStick);
    window.addEventListener("helistrike:right-stick", this.onRightStick);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("helistrike:settings", this.onSettingsChanged);
    window.addEventListener("contextmenu", this.onContextMenu);

    this.lastTime = performance.now() / 1000;

    // Initialize weapon system
    Object.values(WeaponType).filter(v => typeof v === 'number').forEach((wt) => {
      const config = { ...WEAPON_CONFIGS[wt as WeaponType] };
      this.weapons.set(wt as WeaponType, config);
    });

    this.updateUI(this.lastTime); // Init UI
    this.tick();
  }

  startGame() {
    this.resetGame();
    this.isPlaying = true;
    try {
      this.audio.resume();
      this.audio.setMasterVolume(this.settings.masterVolume);
      this.audio.setMuted(this.settings.muted);
      this.audio.startMusic();
    } catch {
      // Some browsers delay audio startup until the first canvas press.
    }
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    this.emitStatsIfChanged(true);
  }

  setPaused(paused: boolean) {
    this.isPlaying = !paused;
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    if (paused) {
      this.audio.stopMusic();
    } else {
      this.audio.startMusic();
    }
  }

  resetGame() {
    for (const enemy of this.enemies) {
      enemy.destroy();
    }
    this.enemies = [];
    for (const pu of this.powerups) {
      pu.destroy(this.scene);
    }
    this.powerups = [];
    this.playerProjectiles.deactivateAll();
    this.enemyProjectiles.deactivateAll();

    this.helicopter.reset();
    this.movementTarget.set(0, 26, 0);
    this.keyboardVelocity.set(0, 0);
    this.hasInputThisFrame = false;
    this.aimPoint.set(0, 26, -35);
    this.mouseAimPoint.set(0, 26, -55);
    this.mouseAimValid = false;
    this.targetGroup.position.set(this.aimPoint.x, 26.2, this.aimPoint.z);
    this.targetGroup.visible = false;
    this.autoAimTarget = null;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.cameraShake = 0;
    this.score = 0;
    this.health = this.maxHealth;
    this.currentFuel = this.maxFuel;
    this.lastStatsHealth = -1;
    this.lastStatsFuel = -1;
    this.survivalTime = 0;
    this.combatIntensity = 0;
    this.directorTimer = 0.6;
    this.battlefieldEventTimer = 16;
    this.lastSpawnSoundTime = 0;
    this.lastBuildingHitSoundTime = 0;
    this.lastEnemyFireSoundTime = 0;
    this.currentWave = 0;
    this.enemiesSpawnedInWave = 0;
    this.totalEnemiesInWave = 0;
    this.spawnTimer = 0;
    this.waveTransitionTimer = 2.2;
    this.waveMessage = "GET READY";
    this.weather.stormIntensity = 0;
    this.weather.targetIntensity = 0;
    // Snap atmosphere to the starting biome so the first frame isn't a fade-in.
    this.currentBiome = this.city.getBiomeAt(this.helicopter.body.position.z);
    const startAtmosphere = BIOME_ATMOSPHERE[this.currentBiome];
    this.weather.resetBiomeAtmosphere(startAtmosphere);
    this.ambientSkyColor.setHex(startAtmosphere.ambientSky);
    this.ambientGroundColor.setHex(startAtmosphere.ambientGround);
    this.ambientLight.color.copy(this.ambientSkyColor);
    this.ambientLight.groundColor.copy(this.ambientGroundColor);
    this.rain.mesh.visible = false;
    this.gameOverDispatched = false;
    this.isPlaying = false;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMultiplier = 1;
    this.maxCombo = 0;
    this.muzzleFlip = 1;
    this.damageBoostTimer = 0;
    this.shieldTimer = 0;
    this.speedBoostTimer = 0;
    this.hitMarkerTimer = 0;
    this.powerupSpawnTimer = 0;

    this.isPaintingLocks = false;
    this.salvoLocks = [];
    this.salvoCooldownTimer = 0;
    this.lastLockPaintTime = 0;
    this.clearSalvoIndicators();

    this.updateUI(performance.now() / 1000);
    this.emitStatsIfChanged(true);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("helistrike:left-stick", this.onLeftStick);
    window.removeEventListener("helistrike:right-stick", this.onRightStick);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("helistrike:settings", this.onSettingsChanged);
    window.removeEventListener("contextmenu", this.onContextMenu);
    this.clearSalvoIndicators();
    this.helicopter.body.removeEventListener(
      "collide",
      this.onHelicopterCollide,
    );
    if (this.lightningTimeout !== null) {
      window.clearTimeout(this.lightningTimeout);
      this.lightningTimeout = null;
    }
    cancelAnimationFrame(this.animationFrame);
    this.audio.dispose();
    this.renderer.dispose();
  }

  onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private renderFrame() {
    if (this.usePostProcessing) {
      this.composer.render();
      return;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private getFallbackFireDirection() {
    if (this.mouseAimValid) {
      const dx = this.mouseAimPoint.x - this.helicopter.body.position.x;
      const dz = this.mouseAimPoint.z - this.helicopter.body.position.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) return { x: dx / len, z: dz / len };
    }
    return { x: 0, z: -1 };
  }

  private findAutoAimTarget(maxDistance = 245, useMouseCone = false) {
    let bestEnemy: Enemy | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;
    const forward = this.getFallbackFireDirection();

    // When the mouse is active, prefer the enemy closest to the cursor within a
    // generous magnetism radius — this makes the reticle feel "sticky" on targets.
    const magnetRadius = 34;

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);

      const cursorDistance = this.mouseAimValid
        ? Math.hypot(
            enemy.body.position.x - this.mouseAimPoint.x,
            enemy.body.position.z - this.mouseAimPoint.z,
          )
        : Infinity;

      // Hard magnetism: an enemy right under the cursor always wins.
      const underCursor = useMouseCone && cursorDistance < magnetRadius;

      if (useMouseCone && !underCursor) {
        // Outside the magnet radius, fall back to a forward cone so we don't
        // snap to enemies behind the player.
        if (aheadBias < 0.2) continue;
        if (lateralDistance > 52 + dist * 0.14) continue;
      }

      const lanePenalty = useMouseCone ? lateralDistance * 10 : Math.abs(dx) * 1.9;
      const behindPenalty = aheadBias < -0.25 ? 9000 : 0;
      const typeBonus =
        enemy.type === EnemyType.DRONE
          ? 1800
          : enemy.type === EnemyType.SHOOTER
            ? 1200
            : enemy.type === EnemyType.TANK
              ? 700
              : 0;

      let score =
        distSq * (useMouseCone ? 0.25 : 1) +
        lanePenalty +
        cursorDistance * (useMouseCone ? 6.0 : 0) +
        behindPenalty -
        typeBonus;

      // Strongly bias toward whatever sits under the cursor.
      if (underCursor) score -= 50000;

      if (score < bestScore) {
        bestScore = score;
        bestEnemy = enemy;
      }
    }

    return bestEnemy;
  }

  private updateAutoAim() {
    const aimHeight = this.helicopter.body.position.y;
    this.autoAimTarget = this.mouseAimValid
        ? this.findAutoAimTarget(225, true)
      : this.findAutoAimTarget(235, false);

    if (this.autoAimTarget) {
      const targetPos = this.autoAimTarget.body.position;
      this.aimPoint.set(targetPos.x, aimHeight, targetPos.z);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(targetPos.x, targetPos.y + 1.2, targetPos.z);
      const scale = this.autoAimTarget.type === EnemyType.TANK || this.autoAimTarget.type === EnemyType.BOSS ? 1.5 : 1.0;
      this.targetGroup.scale.setScalar(scale);
    } else if (this.mouseAimValid) {
      this.aimPoint.copy(this.mouseAimPoint);
      this.aimPoint.y = aimHeight;
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.82);
    } else {
      const fallback = this.getFallbackFireDirection();
      this.aimPoint.set(
        this.helicopter.body.position.x + fallback.x * 65,
        aimHeight,
        this.helicopter.body.position.z + fallback.z * 65,
      );
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.78);
    }
  }

  private updateMouseAimFromEvent(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    this.mouseNDC.set(
      THREE.MathUtils.clamp(x, 0, 1) * 2 - 1,
      -(THREE.MathUtils.clamp(y, 0, 1) * 2 - 1),
    );

    const aimHeight = this.helicopter.body.position.y;
    this.mousePlane.set(new THREE.Vector3(0, 1, 0), -aimHeight);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    const target = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.mousePlane, target)) return;

    let dx = target.x - this.helicopter.body.position.x;
    let dz = target.z - this.helicopter.body.position.z;
    let distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) return;

    const minAimDistance = 22;
    const maxAimDistance = 280;
    const clampedDistance = THREE.MathUtils.clamp(distance, minAimDistance, maxAimDistance);
    dx /= distance;
    dz /= distance;
    this.mouseAimPoint.set(
      this.helicopter.body.position.x + dx * clampedDistance,
      aimHeight,
      this.helicopter.body.position.z + dz * clampedDistance,
    );
    this.mouseAimValid = true;
    this.isMouseActive = true;
    this.updateAutoAim();
  }

  private updateStickAim() {
    if (!this.rightStick.active) return;

    const mag = Math.sqrt(
      this.rightStick.x * this.rightStick.x + this.rightStick.y * this.rightStick.y,
    );
    if (mag < 0.15) {
      this.isFiringMouse = false;
      return;
    }

    const aimDistance = 55;
    const dirX = this.rightStick.x / mag;
    const dirZ = this.rightStick.y / mag;
    const aimHeight = this.helicopter.body.position.y;
    this.aimPoint.set(
      this.helicopter.body.position.x + dirX * aimDistance,
      aimHeight,
      this.helicopter.body.position.z + dirZ * aimDistance,
    );
    this.targetGroup.visible = false;
    this.isFiringMouse = true;
  }

  onPointerMove = (e: PointerEvent) => {
    if (e.target !== this.renderer.domElement) return;
    this.updateMouseAimFromEvent(e);
  };

  onPointerDown = (e: PointerEvent) => {
    if (!this.isPlaying) return;
    if (e.target !== this.renderer.domElement) return;
    e.preventDefault();
    this.audio.resume();

    if (e.button === 2) {
      this.startPaintingLocks();
    } else {
      this.isFiringMouse = true;
      this.isMouseActive = true;
      this.updateMouseAimFromEvent(e);
      this.updateAutoAim();
      if (this.health > 0) {
        this.fireWeapons(performance.now() / 1000);
      }
    }
  };

  onPointerUp = (e: PointerEvent) => {
    if (e.button === 2 || this.isPaintingLocks) {
      this.releaseSalvo();
    } else {
      this.isFiringMouse = false;
    }
  };

  onWheel = (e: WheelEvent) => {
    if (!this.isPlaying) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    const weaponTypes = [
      WeaponType.MACHINE_GUN,
      WeaponType.MISSILE,
      WeaponType.ROCKET,
      WeaponType.SHOTGUN,
    ];
    const currentIdx = weaponTypes.indexOf(this.currentWeapon);
    const nextIdx =
      (currentIdx + delta + weaponTypes.length) % weaponTypes.length;
    this.switchWeapon(weaponTypes[nextIdx]);
  };

  onWindowBlur = () => {
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
  };

  onKeyDown = (e: KeyboardEvent) => {
    const rawKey = e.key.toLowerCase();
    if (rawKey === "escape" || rawKey === "p") {
      window.dispatchEvent(new CustomEvent("helistrike:pause-toggle"));
      return;
    }
    if (!this.isPlaying) return;
    const key = e.key.toLowerCase();

    // Double tap dash triggers
    if (!e.repeat) {
      const doubleTapThreshold = 250;
      const now = performance.now();
      if (key === "a" || key === "arrowleft") {
        if (now - (this.lastTapTime["a"] || 0) < doubleTapThreshold) {
          this.triggerDash(-1, 0);
        }
        this.lastTapTime["a"] = now;
      } else if (key === "d" || key === "arrowright") {
        if (now - (this.lastTapTime["d"] || 0) < doubleTapThreshold) {
          this.triggerDash(1, 0);
        }
        this.lastTapTime["d"] = now;
      } else if (key === "w" || key === "arrowup") {
        if (now - (this.lastTapTime["w"] || 0) < doubleTapThreshold) {
          this.triggerDash(0, -1);
        }
        this.lastTapTime["w"] = now;
      } else if (key === "s" || key === "arrowdown") {
        if (now - (this.lastTapTime["s"] || 0) < doubleTapThreshold) {
          this.triggerDash(0, 1);
        }
        this.lastTapTime["s"] = now;
      }
    }

    if (
      [
        "w",
        "a",
        "s",
        "d",
        "arrowup",
        "arrowleft",
        "arrowdown",
        "arrowright",
        " ",
        "spacebar",
        "shift",
        "e",
        "pageup",
        "pagedown",
      ].includes(key)
    ) {
      e.preventDefault();
      this.movementKeys.add(key);
    }
    // Weapon switching (1-4 keys)
    if (key === "1") this.switchWeapon(WeaponType.MACHINE_GUN);
    if (key === "2") this.switchWeapon(WeaponType.MISSILE);
    if (key === "3") this.switchWeapon(WeaponType.ROCKET);
    if (key === "4") this.switchWeapon(WeaponType.SHOTGUN);
    if (key === "r") this.startReload();

    if (key === "q") {
      this.startPaintingLocks();
    }
  };

  onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    this.movementKeys.delete(key);
    if (key === "q") {
      this.releaseSalvo();
    }
  };

  triggerDash(dx: number, dz: number) {
    if (this.dashCooldownTimer > 0 || this.dashActiveTimer > 0) return;
    this.dashCooldownTimer = 0.75;
    this.dashActiveTimer = 0.28;
    this.dashDirection.set(dx, 0, dz).normalize();
    this.helicopter.triggerDash(dx, dz);
  }

  onLeftStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.leftStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    if (this.leftStick.active) this.audio.resume();
  };

  onRightStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.rightStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    this.isFiringMouse = this.rightStick.active;
    this.isMouseActive = !this.rightStick.active;
    if (this.rightStick.active) this.audio.resume();
  };

  onHelicopterCollide = (e: any) => {
    const impact = Math.abs(e.contact?.getImpactVelocityAlongNormal?.() ?? 0);
    const now = performance.now() / 1000;
    const isBuilding = e.body && e.body.type === CANNON.Body.STATIC;

    if (
      (impact > 3.5 || isBuilding) &&
      now - this.lastCollisionDamageTime > 1.0 &&
      this.health > 0
    ) {
      let dmg = Math.min(14, Math.max(3, impact * 1.1));

      if (isBuilding) {
        dmg = 25;

        // Calculate rebound normal pointing AWAY from building
        let nx = 0;
        let nz = 0;
        if (e.contact) {
          const isBi = e.contact.bi === this.helicopter.body;
          const normal = e.contact.ni;
          nx = isBi ? -normal.x : normal.x;
          nz = isBi ? -normal.z : normal.z;
        }

        // Fallback if normal calculations yield zero or e.contact is missing
        if (nx === 0 && nz === 0 && e.body) {
          const dx = this.helicopter.body.position.x - e.body.position.x;
          const dz = this.helicopter.body.position.z - e.body.position.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len > 0) {
            nx = dx / len;
            nz = dz / len;
          } else {
            nz = 1.0;
          }
        }

        // Ensure normal is unit vector
        const normalLen = Math.sqrt(nx * nx + nz * nz);
        if (normalLen > 0) {
          nx /= normalLen;
          nz /= normalLen;
        } else {
          nz = 1.0;
        }

        // Offset explosion spawn slightly outside building bounding box
        const spawnX = this.helicopter.body.position.x + nx * 3.0;
        const spawnY = this.helicopter.body.position.y;
        const spawnZ = this.helicopter.body.position.z + nz * 3.0;

        // Trigger both standard GPUParticles and Volumetric Explosions outside building
        this.particles.spawnExplosion(spawnX, spawnY, spawnZ, 120, now, 35);
        this.volumetricExplosions.spawn(spawnX, spawnY, spawnZ, 20, 6.5);
        
        this.audio.playExplosion(0.8);
        this.cameraShake = Math.max(this.cameraShake, 3.5);

        // Instantly shift position away from building to break contact and prevent stuck states
        this.helicopter.body.position.x += nx * 2.5;
        this.helicopter.body.position.z += nz * 2.5;

        // Velocity rebound
        this.helicopter.body.velocity.x = nx * 38;
        this.helicopter.body.velocity.z = nz * 38;

        this.movementTarget.set(
          this.helicopter.body.position.x + nx * 18,
          this.movementTarget.y,
          this.helicopter.body.position.z + nz * 18,
        );
        this.helicopter.setTarget(
          this.movementTarget.x,
          this.movementTarget.y,
          this.movementTarget.z,
        );
      } else {
        this.cameraShake = Math.max(this.cameraShake, Math.min(1.8, impact * 0.25));
        this.audio.playHit();
        this.movementTarget.set(
          this.helicopter.body.position.x,
          Math.max(this.helicopter.body.position.y, this.movementTarget.y),
          this.helicopter.body.position.z,
        );
      }

      if (this.dashActiveTimer > 0) {
        dmg = 0;
      }
      this.health = Math.max(0, this.health - dmg);
      this.helicopter.takeDamage(dmg);
      this.lastCollisionDamageTime = now;
      this.updateUI(now);
    }
  };

  onGamepadConnected = (e: GamepadEvent) => {
    this.gamepadIndex = e.gamepad.index;
  };

  onGamepadDisconnected = () => {
    this.gamepadIndex = null;
    this.isFiringGamepad = false;
    this.isMouseActive = true;
  };

  onSettingsChanged = (e: Event) => {
    const detail = (e as CustomEvent<{
      invertedY?: boolean;
      masterVolume?: number;
      muted?: boolean;
      highQuality?: boolean;
    }>).detail;
    if (!detail) return;
    if (detail.invertedY !== undefined) this.settings.invertedY = detail.invertedY;
    if (detail.masterVolume !== undefined) {
      this.settings.masterVolume = detail.masterVolume;
      this.audio.setMasterVolume(detail.masterVolume);
    }
    if (detail.muted !== undefined) {
      this.settings.muted = detail.muted;
      this.audio.setMuted(detail.muted);
    }
    if (detail.highQuality !== undefined) {
      this.setHighQuality(detail.highQuality);
    }
  };

  /** Enables or disables the bloom post-processing pipeline at runtime. */
  setHighQuality(enabled: boolean) {
    if (this.settings.highQuality === enabled && this.usePostProcessing === enabled) return;
    this.settings.highQuality = enabled;
    this.usePostProcessing = enabled;

    // Rebuild the composer pass chain in the correct order: render -> [bloom] -> output.
    this.composer.passes.length = 0;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (enabled) this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  private findLockTarget(dirX: number, dirZ: number, maxDistance = 190) {
    let bestEnemy: Enemy | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 16 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
      if (dot < 0.55) continue;

      const score = distSq * (1.45 - dot);
      if (score < bestScore) {
        bestScore = score;
        bestEnemy = enemy;
      }
    }

    return bestEnemy;
  }

  fireWeapons = (time: number) => {
    if (this.isReloading) return;

    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon) return;

    // Check ammo
    if (weapon.ammo <= 0) {
      this.startReload();
      return;
    }

    // Check fire rate
    if (time - this.lastFireTime < weapon.fireRate) return;
    this.lastFireTime = time;

    // Deduct ammo
    weapon.ammo--;

    let hDirX =
      this.aimPoint.x -
      this.helicopter.body.position.x;
    let hDirZ =
      this.aimPoint.z -
      this.helicopter.body.position.z;
    const aimLen = Math.sqrt(hDirX * hDirX + hDirZ * hDirZ);
    if (aimLen > 0.001) {
      hDirX /= aimLen;
      hDirZ /= aimLen;
    } else {
      const fallback = this.getFallbackFireDirection();
      hDirX = fallback.x;
      hDirZ = fallback.z;
    }
    const heading = Math.atan2(hDirX, hDirZ);
    const cursorLock =
      this.autoAimTarget?.active
        ? this.autoAimTarget
        : this.findAutoAimTarget(this.mouseAimValid ? 225 : 235, this.mouseAimValid);
    const lockTarget =
      cursorLock ??
      (weapon.homing || this.currentWeapon !== WeaponType.MACHINE_GUN
        ? this.findLockTarget(hDirX, hDirZ, weapon.homing ? 230 : 170)
        : null);
    const projectileAssist =
      weapon.homing
        ? 7.4
        : lockTarget
          ? this.currentWeapon === WeaponType.MACHINE_GUN
            ? 1.8
            : this.currentWeapon === WeaponType.SHOTGUN
              ? 1.2
              : 2.8
          : 0;

    // Play appropriate sound
    switch (this.currentWeapon) {
      case WeaponType.MISSILE:
        this.audio.playMissileLaunch();
        break;
      case WeaponType.ROCKET:
        this.audio.playRocketLaunch();
        break;
      case WeaponType.SHOTGUN:
        this.audio.playShotgun(this.helicopter.body.position.x);
        break;
      default:
        this.audio.playMachineGun(this.helicopter.body.position.x);
    }

    const rightUnitX = Math.cos(heading);
    const rightUnitZ = -Math.sin(heading);
    const noseOffset = this.currentWeapon === WeaponType.SHOTGUN ? 3.1 : 2.55;
    const podSpacing =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? 0.0
        : this.currentWeapon === WeaponType.SHOTGUN
          ? 0.42
          : 3.0;
    const muzzleY =
      this.helicopter.body.position.y +
      (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);

    // Fire projectiles based on weapon config
    for (let i = 0; i < weapon.count; i++) {
      let dirX = hDirX;
      let dirZ = hDirZ;
      const side =
        weapon.count === 1
          ? this.muzzleFlip
          : i - (weapon.count - 1) / 2;

      // Apply spread for shotgun
      if (weapon.spread > 0) {
        const angle = (i - (weapon.count - 1) / 2) * weapon.spread;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        dirX = hDirX * cos - hDirZ * sin;
        dirZ = hDirX * sin + hDirZ * cos;
      }

      this.playerProjectiles.spawn(
        this.helicopter.body.position.x + hDirX * noseOffset + rightUnitX * side * podSpacing,
        muzzleY,
        this.helicopter.body.position.z + hDirZ * noseOffset + rightUnitZ * side * podSpacing,
        dirX,
        dirZ,
        time,
        weapon.speed,
        weapon.damage,
        weapon.blastRadius,
        weapon.color,
        lockTarget,
        projectileAssist,
      );
    }
    if (weapon.count === 1) this.muzzleFlip *= -1;

    // Weapon specific muzzle flash & shake
    const fxX = this.helicopter.body.position.x + hDirX * noseOffset;
    const fxZ = this.helicopter.body.position.z + hDirZ * noseOffset;
    
    if (weapon.spread > 0) { 
      // Shotgun Flash
      this.particles.spawnExplosion(fxX, muzzleY, fxZ, 15, time, 12);
      this.cameraShake = Math.max(this.cameraShake, 0.5);
    } else if (weapon.blastRadius > 0) {
      // Missile / Rocket backblast
      this.particles.spawnExplosion(fxX, muzzleY, fxZ, 8, time, 6);
      this.cameraShake = Math.max(this.cameraShake, 0.8);
    } else {
      // Machine Gun Sparks
      for(let s=0; s<2; s++) this.particles.spawnSparks(fxX, muzzleY, fxZ, time);
      this.cameraShake = Math.max(this.cameraShake, 0.06); // Reduced machine gun shake for smooth arcade shooting
    }

    // Auto-reload if out of ammo
    if (weapon.ammo <= 0) {
      this.startReload();
    }
  };

  switchWeapon = (weaponType: WeaponType) => {
    if (this.currentWeapon === weaponType) return;
    this.currentWeapon = weaponType;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.updateUI(performance.now() / 1000);
  };

  startReload = () => {
    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon || weapon.ammo === weapon.maxAmmo || weapon.reloadTime === 0) return;
    this.isReloading = true;
    this.reloadTimer = weapon.reloadTime;
    this.audio.playReload();
  };

  onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  findSalvoTarget(centerPoint: THREE.Vector3, radius: number): Enemy | null {
    let closestEnemy: Enemy | null = null;
    let minDist = radius;
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - centerPoint.x;
      const dz = enemy.body.position.z - centerPoint.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) {
        minDist = dist;
        closestEnemy = enemy;
      }
    }
    return closestEnemy;
  }

  updateSalvoIndicators(enemy: Enemy) {
    let group = this.salvoLockIndicators.get(enemy);
    if (!group) {
      group = new THREE.Group();
      group.position.copy(enemy.mesh.position);
      this.scene.add(group);
      this.salvoLockIndicators.set(enemy, group);
    }

    // Clear old rings in group
    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
      group.remove(child);
    }

    const lockCount = this.salvoLocks.filter((e) => e === enemy).length;

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3344,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < lockCount; i++) {
      const r = 2.0 + i * 0.85;
      const geom = new THREE.RingGeometry(r, r + 0.15, 4); // Spinning diamond
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);
    }
  }

  clearSalvoIndicators() {
    for (const group of this.salvoLockIndicators.values()) {
      group.children.forEach((child: any) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m: any) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this.scene.remove(group);
    }
    this.salvoLockIndicators.clear();
  }

  startPaintingLocks() {
    if (!this.isPlaying || this.salvoCooldownTimer > 0) return;
    this.isPaintingLocks = true;
  }

  releaseSalvo() {
    if (!this.isPaintingLocks) return;
    this.isPaintingLocks = false;

    if (this.salvoLocks.length > 0) {
      const now = performance.now() / 1000;
      this.salvoLocks.forEach((enemy, index) => {
        const offsetAngle = (index / this.salvoLocks.length) * Math.PI * 2;
        const spawnX = this.helicopter.body.position.x + Math.sin(offsetAngle) * 4.5;
        const spawnZ = this.helicopter.body.position.z + Math.cos(offsetAngle) * 4.5;
        const spawnY = this.helicopter.body.position.y - 1;

        const dx = enemy.body.position.x - spawnX;
        const dz = enemy.body.position.z - spawnZ;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;

        // Spawn homing salvo missile
        this.playerProjectiles.spawn(
          spawnX,
          spawnY,
          spawnZ,
          dx / len,
          dz / len,
          now,
          265, // speed
          55,  // damage
          12,  // blastRadius
          0xff3344, // colorHex
          enemy, // target
          8.0 // homingStrength
        );
      });

      this.audio.playMissileLaunch();
      this.cameraShake = Math.max(this.cameraShake, 1.4);
      this.salvoCooldownTimer = this.salvoCooldown;
      this.salvoLocks = [];
      this.clearSalvoIndicators();
      this.updateUI(now);
    }
  }

  dropPowerUp = (x: number, y: number, z: number) => {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.5) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.5) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.5) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }

    const pu = new PowerUp(this.scene, x, y + 2, z, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  };

  applyPowerUp = (type: PowerUpType, time: number) => {
    switch (type) {
      case PowerUpType.HEALTH:
        this.health = Math.min(100, this.health + 30);
        this.helicopter.repair(30);
        break;
      case PowerUpType.AMMO:
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) weapon.ammo = weapon.maxAmmo;
        break;
      case PowerUpType.DAMAGE_BOOST:
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage * 2;
        }
        this.damageBoostTimer = 10.0;
        break;
      case PowerUpType.SHIELD:
        this.shieldTimer = 8.0;
        break;
      case PowerUpType.SPEED_BOOST:
        this.speedBoostTimer = 6.0;
        break;
      case PowerUpType.FUEL:
        this.currentFuel = Math.min(this.maxFuel, this.currentFuel + 35);
        break;
      case PowerUpType.BOMB:
        // Kill all enemies on screen
        for (const e of this.enemies) {
          if (e.active) {
            e.active = false;
            this.score += e.basePoints;
            this.particles.spawnExplosion(
              e.body.position.x,
              e.body.position.y,
              e.body.position.z,
              100,
              time,
              40,
            );
          }
        }
        this.audio.playExplosion(2.0);
        this.cameraShake = 3.0;
        break;
    }
    this.updateUI(time);
  };

  updateUI(time: number) {
    this.emitStatsIfChanged();
    if (this.isPlaying && time - this.lastUiUpdateTime < 1 / 12) return;
    this.lastUiUpdateTime = time;

    const weapon = this.weapons.get(this.currentWeapon);

    // --- Radar / minimap data (positions relative to the player) ---
    const player = this.helicopter.body.position;
    const playerHeading = this.helicopter.mesh.rotation.y;
    const radarBlips = this.enemies
      .filter((e) => e.active)
      .map((e) => ({
        x: e.body.position.x - player.x,
        z: e.body.position.z - player.z,
        type: e.type as number,
      }));
    const enemiesRemaining =
      Math.max(0, this.totalEnemiesInWave - this.enemiesSpawnedInWave) + this.enemies.length;

    window.dispatchEvent(
      new CustomEvent("helistrike:update", {
        detail: {
          score: this.score,
          health: this.health,
          fuel: this.currentFuel,
          rotorHealth: this.helicopter.rotorHealth,
          engineHealth: this.helicopter.engineHealth,
          wave: this.currentWave,
          message: this.waveTransitionTimer > 0 ? this.waveMessage : null,
          playing: this.isPlaying,
          radar: {
            heading: playerHeading,
            blips: radarBlips,
            range: 240,
          },
          waveProgress: {
            remaining: enemiesRemaining,
            total: this.totalEnemiesInWave,
            active: this.enemies.length,
          },
          weapon: weapon ? {
            name: weapon.name,
            ammo: weapon.ammo,
            maxAmmo: weapon.maxAmmo,
            type: this.currentWeapon,
            reloading: this.isReloading,
            reloadTimer: this.reloadTimer,
          } : null,
          combo: {
            count: this.comboCount,
            multiplier: this.comboMultiplier,
            timer: this.comboTimer,
          },
          salvo: {
            locks: this.salvoLocks.length,
            cooldown: Math.ceil(this.salvoCooldownTimer),
            isPainting: this.isPaintingLocks,
            ready: this.salvoCooldownTimer <= 0 && this.isPlaying,
          },
          status: {
            damageBoost: this.damageBoostTimer,
            shield: this.shieldTimer,
            speedBoost: this.speedBoostTimer,
            threat: this.combatIntensity,
          },
        },
      }),
    );
  }

  emitStatsIfChanged(force = false) {
    const nextHealth = Math.round(THREE.MathUtils.clamp(this.health, 0, this.maxHealth));
    const nextFuel = Math.round(THREE.MathUtils.clamp(this.currentFuel, 0, this.maxFuel));

    if (
      !force &&
      nextHealth === this.lastStatsHealth &&
      nextFuel === this.lastStatsFuel
    ) {
      return;
    }

    this.lastStatsHealth = nextHealth;
    this.lastStatsFuel = nextFuel;
    window.dispatchEvent(
      new CustomEvent("helistrike:stats", {
        detail: {
          currentHealth: nextHealth,
          maxHealth: this.maxHealth,
          currentFuel: nextFuel,
          maxFuel: this.maxFuel,
        },
      }),
    );
  }

  dispatchGameOver(time: number) {
    if (this.gameOverDispatched) return;
    this.gameOverDispatched = true;
    this.isPlaying = false;
    this.audio.stopMusic();
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    window.dispatchEvent(
      new CustomEvent("helistrike:gameover", {
        detail: {
          score: this.score,
          wave: this.currentWave,
          time,
          maxCombo: this.maxCombo,
        },
      }),
    );
    this.updateUI(time);
  }

  startNextWave() {
    this.currentWave++;
    // Larger waves: more total enemies and a faster ramp for denser combat.
    this.totalEnemiesInWave = 14 + Math.floor(this.currentWave * 9);
    this.enemiesSpawnedInWave = 0;
    this.spawnTimer = 1.2;

    // Determine wave theme / message
    if (this.currentWave === 1) {
      this.waveMessage = "WAVE 1\nENGAGE THE DRONES";
    } else if (this.currentWave === 3) {
      this.waveMessage = "WAVE 3\nSTORM INCOMING";
    } else if (this.currentWave === 5) {
      this.waveMessage = "WAVE 5\nHEAVY ARMOR DETECTED";
    } else if (this.currentWave % 4 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\nSWARM TACTICS`;
      this.totalEnemiesInWave += 16; // Extra enemies on swarm waves
    } else {
      this.waveMessage = `WAVE ${this.currentWave}`;
    }

    // Dynamic Weather based on wave
    if (this.currentWave >= 3) {
      this.weather.targetIntensity = Math.min(
        1.0,
        (this.currentWave - 2) * 0.25,
      );
      this.rain.mesh.visible = true;
    }

    const healing = 20 + this.currentWave * 2; // More healing on higher waves
    this.health = Math.min(100, this.health + healing); // Wave clear heal
    this.helicopter.repair(healing);

    this.waveTransitionTimer = 3.5;
    this.updateUI(performance.now() / 1000);
  }

  spawnEnemy() {
    let type = EnemyType.BASIC;
    const rand = Math.random();

    // Procedurally assign harder enemies in later waves based on themes
    if (this.currentWave >= 7) {
      if (rand < 0.2) type = EnemyType.DRONE;
      else if (rand < 0.4) type = EnemyType.TANK;
      else if (rand < 0.7) type = EnemyType.SHOOTER;
    } else if (this.currentWave >= 5) {
      if (rand < 0.3) type = EnemyType.TANK;
      else if (rand < 0.6) type = EnemyType.SHOOTER;
      else if (rand < 0.8 && this.currentWave >= 6) type = EnemyType.DRONE;
    } else if (this.currentWave % 4 === 0) {
      // Swarm: mostly basic, some shooters
      if (rand < 0.2) type = EnemyType.SHOOTER;
    } else if (this.currentWave >= 3) {
      if (rand < 0.2 + this.currentWave * 0.05) type = EnemyType.SHOOTER;
      if (rand > 0.85 - this.currentWave * 0.02) type = EnemyType.TANK;
    } else if (this.currentWave >= 2) {
      if (rand < 0.3) type = EnemyType.SHOOTER;
    }

    let spot;
    let attempts = 0;
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const playerPos = this.helicopter.body.position;

    // Safe Spawn Validation (Max 8 attempts for better placement)
    while (attempts < 8) {
      spot = this.getArcadeSpawnPoint(type, 0, 1);
      
      const point = new THREE.Vector3(spot.x, spot.y, spot.z);
      // Ensure it's not popping in immediately in the frustum
      if (frustum.containsPoint(point)) {
        const distSq = (spot.x - playerPos.x) ** 2 + (spot.z - playerPos.z) ** 2;
        if (distSq < 3600) { // Only reject if extremely close (within 60 units) to allow ahead-of-player spawn in view
          attempts++;
          continue; 
        }
      }
      
      // Avoid spawn overlap
      let overlap = false;
      for (const enemy of this.enemies) {
         if (enemy.active) {
            const eDistSq = (spot.x - enemy.mesh.position.x) ** 2 + (spot.z - enemy.mesh.position.z) ** 2;
            if (eDistSq < 144) { // 12 units
               overlap = true;
               break;
            }
         }
      }
      if (overlap) {
         attempts++;
         continue;
      }

      break;
    }

    if (!spot) spot = this.getArcadeSpawnPoint(type, 0, 1);

    this.enemies.push(
      new Enemy(this.scene, this.world, spot.x, spot.z, type, spot.y),
    );
    
    // Spawn teleportation/arrival effect so enemies don't just pop in jarringly
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 30, performance.now() / 1000, 15);
    
    this.enemiesSpawnedInWave++;
    this.playSpawnCue(performance.now() / 1000);
  }

  private getArcadeSpawnPoint(type: EnemyType, index: number, formationSize: number) {
    const player = this.helicopter.body.position;
    const lanes =
      this.combatIntensity < 0.25
        ? [-78, -48, -22, 0, 22, 48, 78]
        : [-145, -112, -82, -52, -24, 0, 24, 52, 82, 112, 145];
    const laneIndex = Math.floor(Math.random() * lanes.length);
    const formationOffset = (index - (formationSize - 1) / 2) * 21;
    const baseX = lanes[laneIndex] + formationOffset + (Math.random() - 0.5) * 12;
    const aheadDistance =
      type === EnemyType.DRONE
        ? 78 + Math.random() * 92
        : type === EnemyType.TANK
          ? 92 + Math.random() * 130
          : 64 + Math.random() * 120;
    const z = player.z - aheadDistance - index * 10;
    const height = this.city.getHeightAt(baseX, z, type === EnemyType.DRONE ? 0 : 3);
    const rooftopFallback =
      height > 2
        ? { x: baseX, y: height + 4.5, z }
        : this.city.getAmbushSpot(player, 55, 205);

    if (type === EnemyType.DRONE) {
      return {
        x: THREE.MathUtils.clamp(baseX, -170, 170),
        y: THREE.MathUtils.clamp(player.y + 4 + Math.random() * 16, 18, 58),
        z,
      };
    }

    if (height > 2 || Math.random() < 0.22) {
      return {
        x: THREE.MathUtils.clamp(rooftopFallback.x + (Math.random() - 0.5) * 10, -175, 175),
        y: Math.max(2.4, rooftopFallback.y),
        z: rooftopFallback.z,
      };
    }

    return {
      x: THREE.MathUtils.clamp(baseX, -175, 175),
      y: 2.4,
      z,
    };
  }

  private playSpawnCue(time: number) {
    if (time - this.lastSpawnSoundTime < 0.4) return;
    this.lastSpawnSoundTime = time;
    this.audio.playEnemySpawn();
  }

  updateAIDirector(time: number, delta: number) {
    this.survivalTime += delta;
    const pressureFromTime = Math.min(1, this.survivalTime / 180);
    const pressureFromThreats = Math.min(1, this.enemies.length / 26);
    const pressureFromHealth = 1 - this.health / this.maxHealth;
    this.combatIntensity = THREE.MathUtils.clamp(
      pressureFromTime * 0.55 + pressureFromThreats * 0.35 + pressureFromHealth * 0.25,
      0,
      1.3,
    );

    // Initial start
    if (this.currentWave === 0) {
      if (this.waveTransitionTimer <= 0) {
        this.startNextWave();
      }
      return;
    }

    // Periodic power-up spawning check
    this.powerupSpawnTimer -= delta;
    if (this.powerupSpawnTimer <= 0) {
      this.spawnPeriodicPowerUp();
      this.powerupSpawnTimer = 8.0 + Math.random() * 4.0;
    }

    // Pause spawning during wave transitions (which are also triggered by battlefield events)
    if (this.waveTransitionTimer > 0) {
      return;
    }

    // Wave spawning logic
    if (this.enemiesSpawnedInWave < this.totalEnemiesInWave) {
      this.spawnTimer -= delta;
      // Cap active enemies to avoid overwhelming the player (increased for arcade swarm feel)
      const maxActiveEnemies = 28 + Math.floor(this.currentWave * 4.0);
      if (this.spawnTimer <= 0 && this.enemies.length < maxActiveEnemies) {
        // Spawn a small burst at once to increase intensity; bursts grow with wave.
        const burstCap = 2 + Math.floor(this.currentWave * 0.5);
        const count = Math.min(
          maxActiveEnemies - this.enemies.length,
          this.totalEnemiesInWave - this.enemiesSpawnedInWave,
          1 + Math.floor(Math.random() * burstCap),
        );
        for (let i = 0; i < count; i++) {
          this.spawnEnemy();
        }
        // Spawning gets significantly faster in later waves
        this.spawnTimer = Math.max(0.15, 0.6 - this.currentWave * 0.06);
      }
    } else if (this.enemies.length === 0) {
      // Wave cleared! Go to next wave
      this.triggerHitStop(0.42, 0.03); // Dramatic freeze on wave clear!
      this.startNextWave();
    }

    // Trigger battlefield events at intervals during the wave if not in transition
    this.battlefieldEventTimer -= delta;
    if (this.battlefieldEventTimer <= 0) {
      this.triggerBattlefieldEvent(time);
      this.battlefieldEventTimer = Math.max(12, 28 - this.combatIntensity * 12);
    }
  }

  spawnDirectedEnemy(time = performance.now() / 1000, index = 0, formationSize = 1) {
    const roll = Math.random();
    const intensity = this.combatIntensity;
    let type = EnemyType.BASIC;
    if (roll > 0.985 - intensity * 0.06) type = EnemyType.BOSS;
    else if (roll < 0.22 + intensity * 0.14) type = EnemyType.DRONE;
    else if (roll < 0.45 + intensity * 0.18) type = EnemyType.SHOOTER;
    else if (roll > 0.78 - intensity * 0.18) type = EnemyType.TANK;

    const spot = this.getArcadeSpawnPoint(type, index, formationSize);
    const sideOffset = (Math.random() - 0.5) * (type === EnemyType.DRONE ? 22 : 10);
    const y = type === EnemyType.DRONE ? spot.y : Math.max(2.4, spot.y);
    const enemy = new Enemy(
      this.scene,
      this.world,
      spot.x + sideOffset,
      spot.z - Math.random() * 30,
      type,
      y,
    );
    this.enemies.push(enemy);
    this.playSpawnCue(time);

    const packChance = 0.18 + intensity * 0.22;
    if (type !== EnemyType.BOSS && this.enemies.length < 28 && Math.random() < packChance) {
      const packSize = type === EnemyType.DRONE ? 2 : 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < packSize; i++) {
        const escortType =
          type === EnemyType.TANK
            ? EnemyType.SHOOTER
            : Math.random() < 0.55
              ? EnemyType.BASIC
              : EnemyType.DRONE;
        const escortY =
          escortType === EnemyType.DRONE
            ? this.helicopter.body.position.y + 3 + Math.random() * 12
            : spot.y;
        this.enemies.push(
          new Enemy(
            this.scene,
            this.world,
            spot.x + sideOffset + (Math.random() - 0.5) * 36,
            spot.z - 12 - Math.random() * 46,
            escortType,
            escortY,
          ),
        );
      }
    }
  }

  triggerBattlefieldEvent(time: number) {
    const player = this.helicopter.body.position;
    const eventRoll = Math.random();
    const eventZ = player.z - 95 - Math.random() * 80;
    this.cameraShake = Math.max(this.cameraShake, 1.2 + this.combatIntensity);

    if (eventRoll < 0.34) {
      this.waveMessage = "MISSILE STORM";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 7 + this.combatIntensity * 6; i++) {
        const x = player.x + (Math.random() - 0.5) * 130;
        const z = player.z - 50 - Math.random() * 150;
        const dx = player.x - x;
        const dz = player.z - z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        this.enemyProjectiles.spawn(x, player.y + 8 + Math.random() * 12, z, dx / len, dz / len, time, 115 + this.combatIntensity * 85);
      }
    } else if (eventRoll < 0.68) {
      this.waveMessage = "CONVOY AMBUSH";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 4 + this.combatIntensity * 4; i++) {
        const enemy = new Enemy(
          this.scene,
          this.world,
          -70 + i * 35,
          eventZ - i * 12,
          i % 2 === 0 ? EnemyType.TANK : EnemyType.SHOOTER,
          7,
        );
        this.enemies.push(enemy);
        if (this.isPlaying) {
          this.enemiesSpawnedInWave++;
          this.totalEnemiesInWave++;
        }
      }
    } else {
      this.waveMessage = "AIR RAID";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 8 + this.combatIntensity * 6; i++) {
        const enemy = new Enemy(
          this.scene,
          this.world,
          player.x + (Math.random() - 0.5) * 160,
          eventZ - Math.random() * 130,
          EnemyType.DRONE,
          player.y + 2 + Math.random() * 14,
        );
        this.enemies.push(enemy);
        if (this.isPlaying) {
          this.enemiesSpawnedInWave++;
          this.totalEnemiesInWave++;
        }
      }
    }
  }

  pollGamepad(time: number, delta: number) {
    if (!this.isPlaying) return;
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) {
      this.onGamepadDisconnected();
      return;
    }

    const DEADZONE = 0.15;
    const lx = gp.axes[0];
    const ly = gp.axes[1];
    const rx = gp.axes[2];
    const ry = gp.axes[3];

    // Move target with Right Stick (or Left Stick if Right is idle)
    let aimX = Math.abs(rx) > DEADZONE ? rx : Math.abs(lx) > DEADZONE ? lx : 0;
    let aimY = Math.abs(ry) > DEADZONE ? ry : Math.abs(ly) > DEADZONE ? ly : 0;

    const hasGamepadInput =
      Math.abs(aimX) > DEADZONE ||
      Math.abs(aimY) > DEADZONE ||
      gp.buttons.some((b) => b.pressed);

    if (Math.abs(aimX) > DEADZONE || Math.abs(aimY) > DEADZONE) {
      this.hasInputThisFrame = true;
      // Circular deadzone/curve for smoother input
      const mag = Math.sqrt(aimX * aimX + aimY * aimY);
      const normX = aimX / mag;
      const normY = aimY / mag;
      const curvedMag = Math.pow((mag - DEADZONE) / (1 - DEADZONE), 1.2);

      const moveSpeed = 150 * delta * this.settings.gamepadSensitivity;
      this.movementTarget.x += normX * curvedMag * moveSpeed;

      const yMove = this.settings.invertedY ? -normY : normY;
      this.movementTarget.z += yMove * curvedMag * moveSpeed;

      // Resume audio on stick move
      this.audio.resume();

      // Disable mouse logic if gamepad is active
      this.isMouseActive = false;
    } else if (hasGamepadInput) {
      // Even if just buttons, maybe keep mouse logic off to avoid snapping?
      this.isMouseActive = false;
    }

    // Buttons (A or R2 to fire)
    this.isFiringGamepad =
      gp.buttons[0].pressed ||
      gp.buttons[7].pressed ||
      (gp.buttons[6] && gp.buttons[6].value > 0.1);
    if (this.isFiringGamepad) {
      this.audio.resume();
    }
  }

  updateKeyboardMovement(delta: number) {
    if (this.dashActiveTimer > 0) return;
    let moveX = 0;
    let moveZ = 0;

    if (this.movementKeys.has("a") || this.movementKeys.has("arrowleft"))
      moveX -= 1;
    if (this.movementKeys.has("d") || this.movementKeys.has("arrowright"))
      moveX += 1;
    if (this.movementKeys.has("w") || this.movementKeys.has("arrowup"))
      moveZ -= 1;
    if (this.movementKeys.has("s") || this.movementKeys.has("arrowdown"))
      moveZ += 1;

    if (this.leftStick.active) {
      moveX += this.leftStick.x;
      moveZ += this.leftStick.y;
    }

    let moveY = 0;
    if (
      this.movementKeys.has(" ") ||
      this.movementKeys.has("spacebar") ||
      this.movementKeys.has("e") ||
      this.movementKeys.has("pageup")
    )
      moveY += 1;
    if (
      this.movementKeys.has("shift") ||
      this.movementKeys.has("pagedown")
    )
      moveY -= 1;

    // Normalize desired keyboard input vector
    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    let normX = 0;
    let normZ = 0;
    if (mag > 0) {
      normX = moveX / mag;
      normZ = moveZ / mag;
    }

    // Arcade style: instant snap to the desired input vector with no acceleration ramp
    const targetMag = Math.min(1, mag);
    this.keyboardVelocity.x = normX * targetMag;
    this.keyboardVelocity.y = normZ * targetMag;

    const inputLength = this.keyboardVelocity.length();
    if (inputLength > 0.005) {
      this.hasInputThisFrame = true;
      const speedBoost = this.speedBoostTimer > 0 ? 1.24 : 1;
      // Arcade style: High target speed so the target jumps to the tight clamp boundary almost instantly
      const moveSpeed = (this.leftStick.active ? 220 : 220) * speedBoost;
      this.movementTarget.x += this.keyboardVelocity.x * moveSpeed * delta;
      this.movementTarget.z += this.keyboardVelocity.y * moveSpeed * delta;
    }

    // Always apply auto-scroll forward
    this.movementTarget.z -= this.autoScrollSpeed * delta;

    if (moveY !== 0) {
      this.hasInputThisFrame = true;
      const climbSpeed = 34;
      this.movementTarget.y += moveY * climbSpeed * delta;
    } else {
      this.movementTarget.y +=
        (this.helicopter.body.position.y - this.movementTarget.y) *
        Math.min(1, delta * 8.0);
    }
  }

  clampMovementTarget() {
    // 1. Clamp to global screen boundary constraints
    this.movementTarget.x = Math.max(
      -190,
      Math.min(190, this.movementTarget.x),
    );
    
    // 2. Clamp relative to helicopter's actual physical position
    // Arcade style: keep the target very close to the helicopter so direction changes are near-instantaneous
    const hPos = this.helicopter.body.position;
    this.movementTarget.x = Math.max(
      hPos.x - 12,
      Math.min(hPos.x + 12, this.movementTarget.x),
    );
    this.movementTarget.z = Math.max(
      hPos.z - 12,
      Math.min(hPos.z + 12, this.movementTarget.z),
    );
    this.movementTarget.y = Math.max(
      Math.max(15, hPos.y - 12),
      Math.min(Math.min(58, hPos.y + 12), this.movementTarget.y),
    );
  }

  tick = () => {
    this.animationFrame = requestAnimationFrame(this.tick);

    const time = performance.now() / 1000;
    const realDelta = Math.min(time - this.lastTime, 0.1);
    this.lastTime = time;

    // Process Hit-Stop timer using real unscaled time
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= realDelta;
      if (this.hitStopTimer <= 0) {
        this.timeScale = 1.0;
      }
    }

    const delta = realDelta * this.timeScale;

    if (!this.isPlaying) {
      this.innerRing.rotation.z += 0.025;
      this.outerRing.rotation.z -= 0.01;
      this.helicopter.animateRotors(0, 60, Math.max(delta, 1 / TARGET_RENDER_FPS));
      this.updateCamera();
      this.renderFrame();
      return;
    }

    this.hasInputThisFrame = false;
    this.pollGamepad(time, delta);
    this.updateKeyboardMovement(delta);

    // Update dash timers and mechanics
    if (this.dashCooldownTimer > 0) {
      this.dashCooldownTimer -= delta;
    }
    if (this.dashActiveTimer > 0) {
      this.dashActiveTimer -= delta;
      const speedBoost = this.speedBoostTimer > 0 ? 1.24 : 1.0;
      const dashSpeed = 155 * speedBoost;
      this.helicopter.body.velocity.x = this.dashDirection.x * dashSpeed;
      this.helicopter.body.velocity.z = this.dashDirection.z * dashSpeed;
      
      // Match the target position directly to prevent drag-back when dash ends
      this.movementTarget.x = this.helicopter.body.position.x;
      this.movementTarget.z = this.helicopter.body.position.z;
    }

    // Apply unified post-input target decay back to player position when idle
    if (!this.hasInputThisFrame) {
      // Arcade style: Instant snap to body position for immediate braking
      this.movementTarget.x = this.helicopter.body.position.x;
      this.movementTarget.z = this.helicopter.body.position.z;
    }
    this.clampMovementTarget();
    this.currentFuel = Math.max(
      0,
      this.currentFuel - this.fuelDrainPerSecond * delta,
    );
    if (this.currentFuel <= 0 && this.health > 0) {
      this.health = Math.max(0, this.health - 8 * delta);
      this.helicopter.takeDamage(2 * delta);
    }
    this.emitStatsIfChanged();
    this.city.update(this.helicopter.body.position.z, this.world, delta);
    this.updateAIDirector(time, delta);

    // Twin-stick aim has priority on mobile; desktop mouse fire uses auto-lock.
    if (this.rightStick.active) {
      this.updateStickAim();
    } else {
      this.updateAutoAim();
    }
    this.innerRing.rotation.z += 0.05;
    this.outerRing.rotation.z -= 0.02;

    // --- Salvo Cooldown Timer ---
    if (this.salvoCooldownTimer > 0) {
      this.salvoCooldownTimer = Math.max(0, this.salvoCooldownTimer - delta);
    }

    // --- Active Salvo Target Locking ---
    if (this.isPaintingLocks && this.salvoCooldownTimer <= 0) {
      if (time - this.lastLockPaintTime >= this.lockPaintInterval) {
        const target = this.findSalvoTarget(this.aimPoint, this.lockSearchRadius);
        if (target && this.salvoLocks.length < 6) {
          const currentTargetLocks = this.salvoLocks.filter((e) => e === target).length;
          if (currentTargetLocks < 3) {
            this.salvoLocks.push(target);
            this.lastLockPaintTime = time;
            this.audio.playLockBeep();
            this.updateSalvoIndicators(target);
            this.updateUI(time);
          }
        }
      }
    }

    // --- Clean Up Dead Enemies in Salvo Locks ---
    this.salvoLocks = this.salvoLocks.filter((enemy) => enemy.active);

    // --- Update Salvo Lock Indicator Visual Positions & Rotations ---
    for (const [enemy, group] of this.salvoLockIndicators.entries()) {
      if (!enemy.active) {
        group.children.forEach((child: any) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        });
        this.scene.remove(group);
        this.salvoLockIndicators.delete(enemy);
      } else {
        group.position.copy(enemy.mesh.position);
        group.children.forEach((child: any, index: number) => {
          const rotationSpeed = 0.06 + index * 0.025;
          const direction = index % 2 === 0 ? 1 : -1;
          child.rotation.z += rotationSpeed * direction;
        });
      }
    }

    // --- Crosshair styling/pulsing during salvo painting ---
    if (this.isPaintingLocks) {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      const scale = 1.0 + Math.sin(time * 15) * 0.15;
      this.targetGroup.scale.set(scale, scale, scale);
    } else if (this.autoAimTarget && this.autoAimTarget.active) {
      // Locked onto an enemy: warm red reticle with a subtle pulse for feedback.
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff5a4a);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff5a4a);
    } else {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      this.targetGroup.scale.set(1, 1, 1);
    }

    // --- Survival encounter messaging ---
    if (this.waveTransitionTimer > 0) {
      this.waveTransitionTimer -= delta;
      if (this.animationFrame % 30 === 0) this.updateUI(time);
    }

    // --- Reload Timer ---
    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) {
          weapon.ammo = weapon.maxAmmo;
          this.isReloading = false;
        }
      }
    }

    // --- Helicopter controls & Weapons ---
    if (
      (this.isFiringMouse || this.isFiringGamepad) &&
      this.health > 0
    ) {
      this.fireWeapons(time);
    }

    this.helicopter.setTarget(
      this.movementTarget.x,
      this.movementTarget.y,
      this.movementTarget.z,
    );
    this.helicopter.setAim(this.aimPoint.x, this.aimPoint.z);

    // --- Weather & Environment ---
    this.updateBiomeAtmosphere(delta);
    this.weather.update(time, delta, this.scene);
    this.rain.update(time, this.helicopter.mesh.position);
    (this.rain.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value =
      time; // redundancy check
    (this.rain.mesh.material as THREE.ShaderMaterial).opacity =
      this.weather.stormIntensity * 0.5;

    if (this.weather.isLightning) {
      this.renderer.setClearColor(0xffffff);
      this.cameraShake = Math.max(this.cameraShake, 2.0);
      this.audio.playExplosion(2.0); // Thunder

      // Small EMP damage chance
      if (Math.random() < 0.2) {
        this.helicopter.takeDamage(5);
      }

      if (this.lightningTimeout !== null) {
        window.clearTimeout(this.lightningTimeout);
      }
      this.lightningTimeout = window.setTimeout(() => {
        if (!this.disposed) this.renderer.setClearColor(SKY_CLEAR_COLOR);
        this.lightningTimeout = null;
      }, 50);
    }

    this.world.step(1 / 60, delta, 3);

    const windCannon = new CANNON.Vec3(
      this.weather.windForce.x,
      0,
      this.weather.windForce.z,
    );
    const hoverFloor = this.city.getHeightAt(
      this.helicopter.body.position.x,
      this.helicopter.body.position.z,
      1.5,
    );
    this.helicopter.setHoverFloor(hoverFloor);
    this.helicopter.update(time, delta, windCannon, this.particles);

    // Engine sound based on speed
    const currentSpeed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 +
        this.helicopter.body.velocity.z ** 2,
    );
    this.audio.updateEngine(Math.min(1.0, currentSpeed / 60), 10);

    // --- Enemy Logic ---
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.active) {
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      if (
        e.body.position.z > this.helicopter.body.position.z + 165 ||
        e.body.position.z < this.helicopter.body.position.z - 320
      ) {
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }

      const fired = e.updateDirection(
        this.helicopter.body.position,
        time,
        this.enemyProjectiles,
        this.playerProjectiles.pool,
        this.enemies,
      );
      if (fired && time - this.lastEnemyFireSoundTime >= 0.15) {
        this.audio.playEnemyFire();
        this.lastEnemyFireSoundTime = time;
      }

      // Ramming Check (Kamikaze)
      if (
        e.body.position.distanceSquared(this.helicopter.body.position) < 25 &&
        this.health > 0
      ) {
        e.active = false;
        this.particles.spawnExplosion(
          e.body.position.x,
          this.helicopter.body.position.y,
          e.body.position.z,
          80,
          time,
          30,
        );
        this.audio.playExplosion(1.5);
        this.cameraShake = 2.5;

        // Tanks do massive ram damage
        const dmg = e.type === EnemyType.TANK ? 30 : 10;
        if (this.dashActiveTimer <= 0) {
          this.health = Math.max(0, this.health - dmg);
          this.helicopter.takeDamage(dmg);
        }
        this.updateUI(time);
      }
    }

    // --- Projectile Physics ---
    this.playerProjectiles.updatePositions(time, delta, this.particles);
    this.enemyProjectiles.updatePositions(time, delta, this.particles);

    for (const proj of this.playerProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        proj.damage * (proj.blastRadius > 0 ? 1.2 : 0.55),
      );
      if (!hitBlock) continue;

      if (proj.blastRadius === 0) {
        // Machine gun ricochet sparks
        for (let s = 0; s < 3; s++) this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
      } else {
        // High explosive detonation
        this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 38, time, 22);
        this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 8, proj.blastRadius * 0.35);
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius, proj.damage * 0.85);
      }
      if (proj.blastRadius > 0 || time - this.lastBuildingHitSoundTime >= 0.20) {
        this.audio.playExplosion(proj.blastRadius > 0 ? 0.65 : 0.16);
        if (proj.blastRadius <= 0) {
          this.lastBuildingHitSoundTime = time;
        }
      }
      proj.deactivate();
    }

    for (const proj of this.enemyProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        18,
      );
      if (!hitBlock) continue;
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 10, time, 8);
      this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 3, 2.0);
      proj.deactivate();
    }

    this.playerProjectiles.checkEnemyHits(this.enemies, (proj, enemy) => {
      const totalDmg = proj.damage * this.comboMultiplier;
      const died = enemy.takeDamage(totalDmg);

      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 15, time, 10);
      this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 6, proj.blastRadius > 0 ? 3.5 : 1.5);
      this.audio.playExplosion(0.2);

      if (proj.blastRadius > 0) {
        for (const nearby of this.enemies) {
          if (!nearby.active || nearby === enemy) continue;
          const dx = nearby.body.position.x - proj.pos.x;
          const dz = nearby.body.position.z - proj.pos.z;
          const dy = Math.abs(nearby.body.position.y - proj.pos.y);
          const radiusSq = proj.blastRadius * proj.blastRadius;
          if (dx * dx + dz * dz < radiusSq && dy < 32) {
            nearby.takeDamage(totalDmg * 0.55);
          }
        }
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius * 0.9, totalDmg);
      }

      // Update combo
      this.comboCount++;
      this.comboTimer = 3.0;
      this.comboMultiplier = 1 + Math.min(this.comboCount * 0.1, 5.0); // Cap at 6x
      this.maxCombo = Math.max(this.maxCombo, this.comboCount);

      if (died) {
        this.score += Math.floor(enemy.basePoints * this.comboMultiplier);
        this.updateUI(time);

        // Trigger Hit-Stop for enemy kills to give a crunchy impact feel
        const stopDuration = enemy.type === EnemyType.BOSS ? 0.32 : enemy.type === EnemyType.TANK ? 0.12 : 0.06;
        const stopScale = enemy.type === EnemyType.BOSS ? 0.02 : 0.05;
        this.triggerHitStop(stopDuration, stopScale);

        // Drop power-up chance (increased for arcade shoot-em-up intensity)
        const dropChance = enemy.type === EnemyType.TANK ? 0.65 : enemy.type === EnemyType.BOSS ? 1.0 : 0.35;
        if (Math.random() < dropChance) {
          this.dropPowerUp(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z);
        }

        // Bigger explosion for enemies based on type
        const explosionSize = enemy.type === EnemyType.BOSS ? 200 : enemy.type === EnemyType.TANK ? 120 : 80;
        const volumetricScale = enemy.type === EnemyType.BOSS ? 30 : enemy.type === EnemyType.TANK ? 18 : 12;
        
        this.particles.spawnExplosion(
          enemy.body.position.x,
          enemy.body.position.y,
          enemy.body.position.z,
          explosionSize,
          time,
          explosionSize * 0.4,
        );
        this.volumetricExplosions.spawn(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, volumetricScale, volumetricScale * 0.6);
        this.city.damageNearby(enemy.body.position.x, enemy.body.position.z, enemy.type === EnemyType.BOSS ? 40 : 22, 95);
        this.audio.playExplosion(enemy.type === EnemyType.BOSS ? 2.5 : 1.5);
      }
    });

    this.enemyProjectiles.checkPlayerHits(
      this.helicopter.body.position,
      (proj) => {
        if (this.health > 0) {
          // Shield or dash protects from damage
          if (this.shieldTimer > 0 || this.dashActiveTimer > 0) {
            this.particles.spawnExplosion(
              proj.pos.x,
              proj.pos.y,
              proj.pos.z,
              20,
              time,
              15,
            );
            return;
          }
          const dmg = 5;
          this.health = Math.max(0, this.health - dmg);
          this.helicopter.takeDamage(dmg);
          this.cameraShake = 1.0;
          this.particles.spawnExplosion(
            proj.pos.x,
            proj.pos.y,
            proj.pos.z,
            30,
            time,
            20,
          );
          this.audio.playHit();
          this.updateUI(time);
        }
      },
    );

    // --- Combo Timer ---
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboMultiplier = 1;
      }
    }

    // --- Update Power-ups ---
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.update(time, delta);

      if (!pu.active) {
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        continue;
      }

      // Check collection
      if (pu.checkCollection(this.helicopter.mesh.position)) {
        this.applyPowerUp(pu.type, time);
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        this.audio.playPickup();
      }
    }

    // --- Power-up Timers ---
    if (this.damageBoostTimer > 0) {
      this.damageBoostTimer -= delta;
      if (this.damageBoostTimer <= 0) {
        // Reset damage boost for all weapons
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage;
        }
      }
    }
    if (this.shieldTimer > 0) {
      this.shieldTimer -= delta;
    }
    if (this.speedBoostTimer > 0) {
      this.speedBoostTimer -= delta;
      if (this.speedBoostTimer <= 0) {
        // Reset speed - handled in helicopter update
      }
    }

    if (this.health <= 0) {
      this.dispatchGameOver(time);
    }

    this.particles.update(time);
    this.volumetricExplosions.update(delta);

    // Update UI every and radar every frame for smoothness
    this.updateUI(time);

    this.updateCamera();

    this.renderFrame();
  };

  /**
   * Detects the biome under the player and feeds its atmosphere into the
   * weather system, while smoothly tinting the ambient hemisphere light.
   */
  updateBiomeAtmosphere(delta: number) {
    const biome = this.city.getBiomeAt(this.helicopter.body.position.z);
    const atmosphere = BIOME_ATMOSPHERE[biome];

    if (biome !== this.currentBiome) {
      this.currentBiome = biome;
      this.weather.setBiomeAtmosphere(atmosphere);
    }

    // Frame-rate-independent blend toward the biome's ambient light tint.
    const blend = 1 - Math.exp(-delta * 0.6);
    this.ambientSkyColor.lerp(tempBiomeSky.setHex(atmosphere.ambientSky), blend);
    this.ambientGroundColor.lerp(tempBiomeGround.setHex(atmosphere.ambientGround), blend);
    this.ambientLight.color.copy(this.ambientSkyColor);
    this.ambientLight.groundColor.copy(this.ambientGroundColor);
  }

  updateCamera() {
    const speed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 + this.helicopter.body.velocity.z ** 2,
    );
    // Forward travel is along -Z. Use it to pull the camera back/up so the
    // player can see what's coming when flying forward.
    const forwardSpeed = Math.max(0, -this.helicopter.body.velocity.z);
    const forwardLook = Math.min(forwardSpeed * 0.55, 22);

    let camTargetX = this.helicopter.body.position.x;
    let camTargetZ =
      this.helicopter.body.position.z + 56 + this.combatIntensity * 8 + forwardLook;

    camTargetX += this.helicopter.body.velocity.x * 0.7;
    camTargetZ += this.helicopter.body.velocity.z * 0.65;

    const camLerp = this.isPlaying ? 0.1 : 0.035;
    this.camera.position.x += (camTargetX - this.camera.position.x) * camLerp;
    this.camera.position.z += (camTargetZ - this.camera.position.z) * camLerp;

    // Raised base height plus extra lift while moving forward for a clearer view ahead.
    const camTargetY =
      70 + Math.min(speed * 0.1, 9) + this.combatIntensity * 5 + Math.min(forwardSpeed * 0.18, 7);
    this.camera.position.y += (camTargetY - this.camera.position.y) * 0.05;

    // Widen FOV a touch when pushing forward to reveal more of the road ahead.
    const targetFov =
      54 + Math.min(speed * 0.08, 7) + this.combatIntensity * 5 + Math.min(forwardSpeed * 0.16, 6);
    this.camera.fov += (targetFov - this.camera.fov) * 0.045;
    this.camera.updateProjectionMatrix();

    if (this.cameraShake > 0) {
      const shake = this.cameraShake;
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake;
      this.camera.position.z += (Math.random() - 0.5) * shake;
      this.cameraShake *= 0.9;
      if (this.cameraShake < 0.01) this.cameraShake = 0;
    }

    // Look further ahead (more negative Z) when moving forward.
    this.camera.lookAt(
      this.helicopter.body.position.x,
      17,
      this.helicopter.body.position.z - 9 - forwardLook * 0.5,
    );
  }
}
