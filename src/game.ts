import * as THREE from "three";
import * as CANNON from "cannon-es";
import { AudioManager } from "./audio";

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
  });
  material.userData.baseColor = new THREE.Color(colorHex);
  return material;
}

function createBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
) {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, createLowPolyMaterial(colorHex));
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
  cellSize = 22;
  chunkDepth = 132;
  halfWidthCells = 8;
  activeBehind = 2;
  activeAhead = 7;

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

  update(playerZ: number, world: CANNON.World) {
    const center = Math.floor(playerZ / this.chunkDepth);
    for (let id = center - this.activeAhead; id <= center + this.activeBehind; id++) {
      if (!this.chunks.has(id)) this.generateChunk(id, world);
    }

    for (const [id, chunk] of this.chunks) {
      if (id < center - this.activeAhead - 1 || id > center + this.activeBehind + 1) {
        this.group.remove(chunk.group);
        for (const body of chunk.bodies) world.removeBody(body);
        this.chunks.delete(id);
      }
    }

    this.rebuildCaches();
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
      if (Math.max(from.y, to.y) < -1 || Math.min(from.y, to.y) > block.height + 2.5) {
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
    const groundColors: Record<string, number> = {
      city: 0x74e4ed,
      base: 0x737c8d,
      refinery: 0x565f6d,
      desert: 0xd6b55b,
      forest: 0x3f8c5d,
      ruins: 0x7e7d86,
    };
    const ground = createBox(420, 0.8, this.chunkDepth + 6, groundColors[zone]);
    ground.position.set(0, -0.62, chunkCenterZ);
    chunk.group.add(ground);

    const road = createBox(18, 0.12, this.chunkDepth + 8, 0x243044);
    road.position.set(this.hash(id, 99) > 0.5 ? -34 : 34, -0.16, chunkCenterZ);
    chunk.group.add(road);
    this.addGroundDressing(chunk, zone, chunkCenterZ, road.position.x, id);

    for (let gx = -this.halfWidthCells; gx <= this.halfWidthCells; gx++) {
      for (let local = -2; local <= 3; local++) {
        const isFlightLane = Math.abs(gx) <= 1;
        if (isFlightLane && (id === 0 || this.hash(id, gx * 53 + local * 19) < 0.88)) continue;
        const roll = this.hash(id, gx * 13 + local * 37);
        const density = zone === "desert" ? 0.42 : zone === "forest" ? 0.52 : 0.72;
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
    const palettes: Record<string, number[]> = {
      city: [0x2742a0, 0x3155b7, 0x3f67c9, 0x24377e, 0x547bdf],
      base: [0x4b5361, 0x687182, 0x323946, 0x73827b],
      refinery: [0x303a47, 0x596675, 0x745c37, 0x222832],
      desert: [0xc3a94e, 0xb78f42, 0x9b7841, 0xd2bf77],
      forest: [0x224c38, 0x315f41, 0x4d6d4b, 0x20362f],
      ruins: [0x4d5366, 0x696a77, 0x3f4455, 0x7a6f69],
    };
    const colors = palettes[zone];
    const color = colors[Math.floor(seed * colors.length)];
    const skyscraper = zone === "city" && Math.abs(gx) > 3 && seed > 0.72;
    const height =
      zone === "desert"
        ? 5 + seed * 13
        : zone === "forest"
          ? 6 + seed * 16
          : skyscraper
            ? 34 + seed * 34
            : 9 + seed * 30;
    const width = zone === "base" ? 14 + seed * 10 : 8 + this.hash(chunk.id, gx) * 9;
    const depth = zone === "refinery" ? 7 + this.hash(chunk.id, local) * 16 : 8 + this.hash(chunk.id, gx + 4) * 9;

    const building = createBox(width, height, depth, color);
    building.position.set(x, height / 2, z);
    chunk.group.add(building);

    const cap = createBox(width + 1.8, 1, depth + 1.8, color);
    cap.position.set(x, height + 0.5, z);
    chunk.group.add(cap);

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
    const maxHp = 80 + height * 4;
    chunk.bodies.push(body);
    chunk.blocks.push({
      x,
      z,
      width: width + 1.8,
      depth: depth + 1.8,
      height: height + 1,
      chunkId: chunk.id,
      meshes: [building, cap],
      body,
      hp: maxHp,
      maxHp,
      destroyed: false,
    });
    chunk.spots.push({ x, y: height + 1.8, z });

    if (seed > 0.65) this.addRooftopDetail(chunk, x, z, height, width, depth, seed);
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
      const helipad = createBox(Math.min(width, 10), 0.22, Math.min(depth, 10), 0x1b2740);
      helipad.position.set(x, height + 1.18, z);
      chunk.group.add(helipad);
    } else if (seed > 0.75) {
      const tower = createBox(0.8, 7, 0.8, 0x151b2c);
      tower.position.set(x + width * 0.22, height + 4.2, z - depth * 0.18);
      chunk.group.add(tower);
      const dish = createBox(3.2, 0.35, 1.2, 0xaee9ff);
      dish.position.set(tower.position.x, height + 8, tower.position.z);
      dish.rotation.z = Math.PI / 7;
      chunk.group.add(dish);
    } else {
      const vent = createBox(width * 0.36, 1.4, depth * 0.32, 0x222b39);
      vent.position.set(x, height + 1.7, z);
      chunk.group.add(vent);
    }
  }

  private addBridge(chunk: WorldChunk, z: number) {
    const bridge = createBox(160, 2, 16, 0x4a5369);
    bridge.position.set(0, 5, z);
    chunk.group.add(bridge);
    for (let i = -3; i <= 3; i++) {
      const support = createBox(2, 10, 2, 0x32394a);
      support.position.set(i * 24, 2.2, z);
      chunk.group.add(support);
    }
  }

  private addSmokeColumn(chunk: WorldChunk, z: number) {
    for (let i = 0; i < 4; i++) {
      const smoke = createBox(5 + i * 2, 6 + i * 3, 5 + i * 2, 0x1f252c);
      smoke.material.transparent = true;
      smoke.material.opacity = 0.18;
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
    const lane = createBox(44, 0.08, this.chunkDepth + 4, 0x34505f);
    lane.position.set(0, -0.12, chunkCenterZ);
    lane.material.transparent = true;
    lane.material.opacity = 0.18;
    chunk.group.add(lane);

    const shoulderColor = zone === "desert" ? 0xb99643 : zone === "forest" ? 0x2f744e : 0x38495d;
    for (const side of [-1, 1]) {
      const shoulder = createBox(4, 0.08, this.chunkDepth + 8, shoulderColor);
      shoulder.position.set(roadX + side * 12.5, -0.09, chunkCenterZ);
      chunk.group.add(shoulder);
    }

    for (let i = -3; i <= 3; i++) {
      const stripe = createBox(1.2, 0.09, 7, 0xe9df9a);
      stripe.position.set(roadX, -0.04, chunkCenterZ + i * 18);
      chunk.group.add(stripe);
    }

    const detailPalettes: Record<string, number[]> = {
      city: [0x5bbdcc, 0x4ea3bc, 0x6ac8cf, 0x596c86],
      base: [0x5b6574, 0x444d5b, 0x6d786d, 0x303947],
      refinery: [0x454f5d, 0x313946, 0x69573d, 0x202832],
      desert: [0xcaa84e, 0xb98e3f, 0xd0ba65, 0x98713d],
      forest: [0x2f7249, 0x24583f, 0x3f8559, 0x1f4634],
      ruins: [0x676978, 0x555967, 0x77736e, 0x454a57],
    };
    const palette = detailPalettes[zone] ?? detailPalettes.city;

    for (let i = 0; i < 16; i++) {
      const seed = this.hash(id, i * 41 + 7);
      const x = -190 + this.hash(id, i * 59 + 11) * 380;
      const z = chunkCenterZ - this.chunkDepth * 0.48 + this.hash(id, i * 67 + 17) * this.chunkDepth;
      if (Math.abs(x) < 23 || Math.abs(x - roadX) < 24) continue;

      const patch = createBox(
        6 + this.hash(id, i * 71 + 19) * 18,
        0.07,
        5 + this.hash(id, i * 73 + 23) * 16,
        palette[Math.floor(seed * palette.length)],
      );
      patch.position.set(x, -0.08 + seed * 0.015, z);
      patch.rotation.y = (seed - 0.5) * 0.45;
      patch.material.transparent = true;
      patch.material.opacity = 0.38;
      chunk.group.add(patch);
    }

    for (let i = 0; i < 8; i++) {
      const seed = this.hash(id, i * 83 + 31);
      const x = -185 + this.hash(id, i * 89 + 37) * 370;
      const z = chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 97 + 43) * this.chunkDepth * 0.9;
      if (Math.abs(x) < 35 || Math.abs(x - roadX) < 20) continue;

      if (zone === "forest" && seed > 0.25) {
        const trunk = createBox(0.8, 3.2, 0.8, 0x473820);
        trunk.position.set(x, 1.35, z);
        const crown = createBox(4 + seed * 2, 4 + seed * 2.5, 4 + seed * 2, 0x1e5b39);
        crown.position.set(x, 4.0, z);
        chunk.group.add(trunk, crown);
      } else {
        const rock = createBox(2 + seed * 4, 0.6 + seed * 1.3, 2 + seed * 4, zone === "desert" ? 0x8f7646 : 0x3d4652);
        rock.position.set(x, rock.geometry.boundingBox ? 0.2 : 0.25, z);
        rock.rotation.y = seed * Math.PI;
        chunk.group.add(rock);
      }
    }

    if (Math.abs(id) % 3 === 1) {
      const crater = createBox(16, 0.1, 12, 0x242831);
      crater.position.set(roadX > 0 ? -84 : 84, -0.03, chunkCenterZ + (this.hash(id, 203) - 0.5) * 52);
      crater.rotation.y = this.hash(id, 211) * Math.PI;
      crater.material.transparent = true;
      crater.material.opacity = 0.52;
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

  private zoneForChunk(id: number) {
    const zones = ["city", "base", "refinery", "desert", "forest", "ruins"];
    return zones[Math.abs(Math.floor(this.hash(id, 17) * zones.length)) % zones.length];
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
    if (block.body) {
      block.body.collisionFilterMask = 0;
      block.body.collisionResponse = false;
    }
    for (const mesh of block.meshes) {
      mesh.scale.y = 0.18;
      mesh.position.y = Math.max(0.35, mesh.position.y * 0.18);
      const mat = mesh.material;
      if (mat instanceof THREE.MeshLambertMaterial) {
        mat.color.setHex(0x26242a);
      }
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
      float sizeMult = pType == 1.0 ? 30.0 : (pType == 2.0 ? 5.0 : 20.0);
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
      if(length(coord) > 0.5) discard;
      
      vec3 color;
      float alpha = vLife * 0.8;

      if (vType == 1.0) {
          // Smoke (starts grey, fades to dark)
          color = mix(vec3(0.05, 0.05, 0.05), vec3(0.3, 0.3, 0.3), vLife);
          alpha = vLife * 0.5;
      } else if (vType == 2.0) {
          // Sparks (white to orange)
          vec3 sparkStart = vec3(1.0, 1.0, 0.8);
          vec3 sparkEnd = vec3(1.0, 0.3, 0.0);
          color = mix(sparkEnd, sparkStart, vLife);
          alpha = vLife;
      } else {
          // Default Explosion
          vec3 startColor = vec3(1.0, 1.0, 0.8); // White-Hot
          vec3 midColor = vec3(1.0, 0.5, 0.0);   // Orange
          vec3 endColor = vec3(0.2, 0.2, 0.2);   // Smoke
          color = mix(endColor, midColor, smoothstep(0.0, 0.5, vLife));
          color = mix(color, startColor, smoothstep(0.5, 1.0, vLife));
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
      gl_PointSize = 2.0 * (100.0 / length(mvPosition.xyz));
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const RainFrag = `
  varying float vLife;
  void main() {
      gl_FragColor = vec4(0.5, 0.7, 1.0, 0.4);
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

  update(time: number, delta: number, scene: THREE.Scene) {
    // Transition intensity
    this.stormIntensity +=
      (this.targetIntensity - this.stormIntensity) * delta * 0.1;

    // Fog management
    const fogDensity = 0.009 + this.stormIntensity * 0.022;
    (scene.fog as THREE.FogExp2).density = fogDensity;

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

class Helicopter extends Entity {
  targetPosition: THREE.Vector3;
  lastTargetPosition: THREE.Vector3;
  mainRotor: THREE.Object3D;
  tailRotor: THREE.Object3D;

  // Subsystems
  rotorHealth: number = 100;
  engineHealth: number = 100;
  hoverFloor: number = 0;
  smoothedHoverFloor: number = 0;
  aimPosition: THREE.Vector3 = new THREE.Vector3(0, 26, -30);

  constructor(scene: THREE.Scene, world: CANNON.World) {
    super(scene, world);
    this.targetPosition = new THREE.Vector3(0, 26, 0);
    this.lastTargetPosition = new THREE.Vector3(0, 26, 0);

    const baseGroup = new THREE.Group();

    const bodyMat = createLowPolyMaterial(0x2f4a35);
    const darkBodyMat = createLowPolyMaterial(0x1b2a20);
    const accentMat = createLowPolyMaterial(0xd13a2f);
    const glassMat = createLowPolyMaterial(0x172f3d);
    const metalMat = createLowPolyMaterial(0xaeb9b0);
    const bladeMat = createLowPolyMaterial(0x161c19);
    const ordnanceMat = createLowPolyMaterial(0x232b27);

    const bodyMesh = createBox(2.55, 1.25, 3.9, 0x2f4a35);
    bodyMesh.material = bodyMat;
    bodyMesh.position.set(0, -0.05, 0.05);
    baseGroup.add(bodyMesh);

    const nose = createBox(1.45, 0.82, 1.55, 0x35523c);
    nose.material = bodyMat;
    nose.position.set(0, -0.12, 2.65);
    baseGroup.add(nose);

    const rearCanopy = createBox(1.25, 0.48, 0.95, 0x172f3d);
    rearCanopy.material = glassMat;
    rearCanopy.position.set(0, 0.58, 0.9);
    rearCanopy.rotation.x = -0.12;
    baseGroup.add(rearCanopy);

    const frontCanopy = createBox(1.05, 0.42, 0.82, 0x172f3d);
    frontCanopy.material = glassMat;
    frontCanopy.position.set(0, 0.5, 1.85);
    frontCanopy.rotation.x = -0.16;
    baseGroup.add(frontCanopy);

    const cheekLeft = createBox(0.42, 0.42, 1.25, 0x1b2a20);
    cheekLeft.material = darkBodyMat;
    cheekLeft.position.set(-0.95, -0.1, 1.65);
    cheekLeft.rotation.z = 0.12;
    const cheekRight = cheekLeft.clone();
    cheekRight.position.x = 0.95;
    cheekRight.rotation.z = -0.12;
    baseGroup.add(cheekLeft, cheekRight);

    const tail = createBox(0.48, 0.48, 4.6, 0x2f4a35);
    tail.material = bodyMat;
    tail.position.set(0, 0.04, -3.55);
    baseGroup.add(tail);

    const tailFin = createBox(1.1, 1.85, 0.28, 0x1b2a20);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 0.92, -5.95);
    tailFin.rotation.z = 0.08;
    baseGroup.add(tailFin);

    const tailStabilizer = createBox(2.4, 0.16, 0.4, 0x1b2a20);
    tailStabilizer.material = darkBodyMat;
    tailStabilizer.position.set(0, 0.05, -5.55);
    baseGroup.add(tailStabilizer);

    const mast = createBox(0.34, 0.78, 0.34, 0xaeb9b0);
    mast.material = metalMat;
    mast.position.set(0, 0.98, 0.05);
    baseGroup.add(mast);

    this.mainRotor = new THREE.Group();
    this.mainRotor.position.set(0, 1.52, 0.05);
    const blade1 = createBox(0.24, 0.07, 9.6, 0x161c19);
    blade1.material = bladeMat;
    const blade2 = createBox(9.6, 0.07, 0.24, 0x161c19);
    blade2.material = bladeMat;
    const blade3 = createBox(0.24, 0.07, 9.6, 0x161c19);
    blade3.material = bladeMat;
    blade3.rotation.y = Math.PI / 4;
    const blade4 = createBox(9.6, 0.07, 0.24, 0x161c19);
    blade4.material = bladeMat;
    blade4.rotation.y = Math.PI / 4;
    this.mainRotor.add(blade1, blade2, blade3, blade4);
    baseGroup.add(this.mainRotor);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.66, 0.48, -6.05);
    const tailBladeA = createBox(0.1, 1.55, 0.18, 0x161c19);
    tailBladeA.material = bladeMat;
    const tailBladeB = createBox(0.1, 0.18, 1.55, 0x161c19);
    tailBladeB.material = bladeMat;
    this.tailRotor.add(tailBladeA, tailBladeB);
    baseGroup.add(this.tailRotor);

    const stubWingLeft = createBox(3.25, 0.22, 0.9, 0x1f3328);
    stubWingLeft.material = darkBodyMat;
    stubWingLeft.position.set(-1.9, -0.18, -0.35);
    stubWingLeft.rotation.z = -0.08;
    const stubWingRight = stubWingLeft.clone();
    stubWingRight.position.x = 1.9;
    stubWingRight.rotation.z = 0.08;
    baseGroup.add(stubWingLeft, stubWingRight);

    const podLeft = createBox(0.62, 0.62, 1.2, 0x232b27);
    podLeft.material = ordnanceMat;
    podLeft.position.set(-3.05, -0.28, -0.35);
    const podRight = podLeft.clone();
    podRight.position.x = 3.05;
    baseGroup.add(podLeft, podRight);

    for (let i = 0; i < 3; i++) {
      const rocketL = createBox(0.16, 0.16, 0.9, 0xd13a2f);
      rocketL.material = accentMat;
      rocketL.position.set(-3.06 + (i - 1) * 0.19, -0.66, -0.35);
      const rocketR = rocketL.clone();
      rocketR.position.x = 3.06 + (i - 1) * 0.19;
      baseGroup.add(rocketL, rocketR);
    }

    const chinMount = createBox(0.48, 0.32, 0.42, 0x232b27);
    chinMount.material = ordnanceMat;
    chinMount.position.set(0, -0.78, 2.55);
    const chinBarrel = createBox(0.16, 0.16, 1.15, 0x161c19);
    chinBarrel.material = bladeMat;
    chinBarrel.position.set(0, -0.82, 3.2);
    baseGroup.add(chinMount, chinBarrel);

    const skid1 = createBox(0.16, 0.14, 4.25, 0xaeb9b0);
    skid1.material = metalMat;
    skid1.position.set(1.15, -0.98, 0.15);
    const skid2 = createBox(0.16, 0.14, 4.25, 0xaeb9b0);
    skid2.material = metalMat;
    skid2.position.set(-1.15, -0.98, 0.15);
    const s1 = createBox(0.12, 0.82, 0.12, 0xaeb9b0);
    s1.material = metalMat;
    s1.position.set(1.15, -0.58, 1.35);
    s1.rotation.z = Math.PI / 12;
    const s2 = createBox(0.12, 0.82, 0.12, 0xaeb9b0);
    s2.material = metalMat;
    s2.position.set(1.15, -0.58, -1.25);
    s2.rotation.z = Math.PI / 12;
    const s3 = createBox(0.12, 0.82, 0.12, 0xaeb9b0);
    s3.material = metalMat;
    s3.position.set(-1.15, -0.58, 1.35);
    s3.rotation.z = -Math.PI / 12;
    const s4 = createBox(0.12, 0.82, 0.12, 0xaeb9b0);
    s4.material = metalMat;
    s4.position.set(-1.15, -0.58, -1.25);
    s4.rotation.z = -Math.PI / 12;
    baseGroup.add(skid1, skid2, s1, s2, s3, s4);

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
          child.material.color
            .copy(baseColor)
            .lerp(new THREE.Color(0x4d171a), hullDamage * 0.75);
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

    const maxCruiseSpeed = (44 + inputAgility * 18) * engineEff;
    let desiredVx = THREE.MathUtils.clamp(ex * 5.2, -maxCruiseSpeed, maxCruiseSpeed);
    let desiredVz = THREE.MathUtils.clamp(ez * 5.2, -maxCruiseSpeed, maxCruiseSpeed);
    const desiredSpeed = Math.sqrt(desiredVx * desiredVx + desiredVz * desiredVz);
    if (desiredSpeed > maxCruiseSpeed) {
      desiredVx = (desiredVx / desiredSpeed) * maxCruiseSpeed;
      desiredVz = (desiredVz / desiredSpeed) * maxCruiseSpeed;
    }

    const accelResponsiveness = (15 + inputAgility * 10) * rotorEff * engineEff;
    let fx = (desiredVx - this.body.velocity.x) * this.body.mass * accelResponsiveness;
    let fz = (desiredVz - this.body.velocity.z) * this.body.mass * accelResponsiveness;

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

    const maxForce = (610 + inputAgility * 260) * engineEff;
    const forceMag = Math.sqrt(fx * fx + fz * fz);
    if (forceMag > maxForce) {
      fx = (fx / forceMag) * maxForce;
      fz = (fz / forceMag) * maxForce;
    }

    this.body.applyForce(new CANNON.Vec3(fx, 0, fz), this.body.position);

    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.5 : 2.5));

    const hoverBob = Math.sin(time * 1.7) * 0.14;
    const targetY = Math.max(this.targetPosition.y, this.smoothedHoverFloor + 7.5) + hoverBob;
    const ey = targetY - this.body.position.y;

    const gravityComp = 9.82 * this.body.mass;
    const fy = ey * 112 - this.body.velocity.y * 38 + gravityComp;

    this.body.applyForce(new CANNON.Vec3(0, fy, 0), this.body.position);

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
    const turnTurnSpeed = (0.14 + inputAgility * 0.1) * rotorEff;
    this.mesh.rotation.y += diff * turnTurnSpeed;

    this.mesh.position.copy(this.body.position as any);

    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);
    // Transform velocity to local space (Z forward, X right)
    const localVx = this.body.velocity.x * cy - this.body.velocity.z * sy;
    const localVz = this.body.velocity.x * sy + this.body.velocity.z * cy;

    // Auto-Stabilization: Suppress tilt if idling to gently correct rotation
    const tiltMultiplier = isIdle ? 0.16 : 0.9;

    // Visual Tilting: Pitch DOWN when moving forward (Positive localVz), Roll INTO turn
    const tiltCap = 0.34 + inputAgility * 0.14;
    const targetTiltX =
      THREE.MathUtils.clamp(localVz * 0.045, -tiltCap, tiltCap) * tiltMultiplier;
    const targetTiltZ =
      -THREE.MathUtils.clamp(localVx * 0.045, -tiltCap, tiltCap) * tiltMultiplier;

    const tiltSmoothing =
      (isIdle ? 0.055 : 0.15 + inputAgility * 0.08) * rotorEff;
    this.mesh.rotation.x +=
      (targetTiltX - this.mesh.rotation.x) * tiltSmoothing;
    this.mesh.rotation.z +=
      (targetTiltZ - this.mesh.rotation.z) * tiltSmoothing;

    // Spool up rotors based on load + Damage Jitter + Drooping
    const rotorJitter = this.rotorHealth < 30 ? Math.sin(time * 60) * 0.05 : 0;
    this.mainRotor.position.y = 1.55 + rotorJitter;

    // Droop/Bend blades if damaged
    const droopAmount = Math.max(0, (100 - this.rotorHealth) / 100) * 0.15;
    this.mainRotor.children.forEach((blade, i) => {
      if (blade instanceof THREE.Mesh) {
        // Apply a slight individual tilt/bend to each blade
        blade.rotation.x =
          (i === 0 ? droopAmount : 0) + Math.sin(time * 2) * droopAmount * 0.5;
        blade.rotation.z =
          (i === 1 ? droopAmount : 0) + Math.cos(time * 2) * droopAmount * 0.5;
      }
    });

    this.mainRotor.rotation.y +=
      (0.75 + (forceMag / maxForce) * 0.45) * rotorEff;
    this.tailRotor.rotation.x += 0.85 * rotorEff;
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
    fireRate: 0.065,
    ammo: 200,
    maxAmmo: 200,
    reloadTime: 0,
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
    ammo: 15,
    maxAmmo: 15,
    reloadTime: 3.0,
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
    ammo: 8,
    maxAmmo: 8,
    reloadTime: 4.0,
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
    ammo: 30,
    maxAmmo: 30,
    reloadTime: 2.5,
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

    const pad = createBox(radius * 2.2, 0.45, radius * 2.2, 0x18265a);
    pad.position.y = -0.55;
    baseGroup.add(pad);

    const base = createBox(radius * 1.5, 0.8, radius * 1.5, coreHex);
    base.position.y = -0.05;
    baseGroup.add(base);

    this.ring = new THREE.Group();
    this.ring.position.y = 0.55;

    const head = createBox(radius * 1.15, radius * 0.75, radius, coreHex);
    this.ring.add(head);

    const barrel = createBox(
      radius * 0.35,
      radius * 0.32,
      radius * 1.9,
      accentHex,
    );
    barrel.position.z = radius * 0.95;
    this.ring.add(barrel);

    const sight = createBox(
      radius * 0.35,
      radius * 0.35,
      radius * 0.35,
      0xffff7a,
    );
    sight.position.set(0, radius * 0.42, radius * 0.2);
    this.ring.add(sight);

    baseGroup.add(this.ring);

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

    // DRONE: Chase player with movement
    if (this.type === EnemyType.DRONE) {
      const speed = 35;
      this.body.velocity.set(dirX * speed, 0, dirZ * speed);

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
    
    if (dist > 35) {
      this.body.velocity.set(dirX * speed, 0, dirZ * speed);
    } else {
      this.body.velocity.set(0, 0, 0);
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
    let geom = new THREE.BoxGeometry(0.22, 0.22, 8.0).toNonIndexed();
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
    });
    this.mesh = new THREE.Mesh(geom, mat);

    const glowGeom = new THREE.BoxGeometry(0.75, 0.75, 10.5).toNonIndexed();
    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.22,
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

  update(now: number, delta: number) {
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

    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    this.mesh.updateMatrix();

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
  const sy = to.y - from.y;
  const sz = to.z - from.z;
  const lenSq = sx * sx + sy * sy + sz * sz;
  if (lenSq < 0.0001) {
    const dx = point.x - to.x;
    const dy = point.y - to.y;
    const dz = point.z - to.z;
    return dx * dx + dy * dy + dz * dz;
  }

  const t = THREE.MathUtils.clamp(
    ((point.x - from.x) * sx + (point.y - from.y) * sy + (point.z - from.z) * sz) /
      lenSq,
    0,
    1,
  );
  const closestX = from.x + sx * t;
  const closestY = from.y + sy * t;
  const closestZ = from.z + sz * t;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  const dz = point.z - closestZ;
  return dx * dx + dy * dy + dz * dz;
}

// --- POWERUP CLASS ---

class PowerUp {
  mesh: THREE.Group;
  type: PowerUpType;
  active: boolean = true;
  position: THREE.Vector3;
  spawnTime: number = 0;
  lifetime: number = 15; // 15 seconds lifetime

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
    });
    const core = new THREE.Mesh(geom, mat);
    this.mesh.add(core);

    // Outer glow ring
    const ringGeom = new THREE.TorusGeometry(2.2, 0.15, 8, 16);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    this.mesh.add(ring);

    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }

  update(time: number, delta: number) {
    if (!this.active) return;

    // Rotate and bob
    this.mesh.rotation.y += delta * 2;
    this.mesh.rotation.x += delta * 0.5;
    this.mesh.position.y = this.position.y + Math.sin(time * 3) * 0.5;

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
    const dist = this.mesh.position.distanceTo(playerPos);
    return dist < 5;
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

  updatePositions(now: number, delta: number) {
    for (const p of this.pool) {
      if (p.active) p.update(now, delta);
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
  renderer: THREE.WebGLRenderer;
  world: CANNON.World;
  city: CityEnvironment;

  helicopter: Helicopter;
  enemies: Enemy[] = [];

  playerProjectiles: ProjectilePool;
  enemyProjectiles: ProjectilePool;

  particles: GPUParticleSystem;
  rain: RainSystem;
  weather: WeatherSystem;
  audio: AudioManager;
  lastTime: number = 0;

  settings = {
    invertedY: false,
    gamepadSensitivity: 1.5,
  };

  gamepadIndex: number | null = null;
  isMouseActive: boolean = true;
  movementKeys: Set<string> = new Set();
  leftStick: StickInput = { x: 0, y: 0, active: false };
  rightStick: StickInput = { x: 0, y: 0, active: false };
  movementTarget: THREE.Vector3 = new THREE.Vector3(0, 26, 0);
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
  autoScrollSpeed = 28;
  survivalTime = 0;
  combatIntensity = 0;
  directorTimer = 0;
  battlefieldEventTimer = 18;
  lastSpawnSoundTime = 0;

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

  // Combo System
  comboCount: number = 0;
  comboTimer: number = 0;
  comboMultiplier: number = 1;
  maxCombo: number = 0;

  // Damage Boost & Shield
  damageBoostTimer: number = 0;
  shieldTimer: number = 0;
  speedBoostTimer: number = 0;

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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x9fdce8);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fdce8);
    this.scene.fog = new THREE.FogExp2(0x9fdce8, 0.009);

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      360,
    );
    this.camera.position.set(0, 62, 46);
    this.camera.lookAt(0, 0, 0);

    this.world = new CANNON.World();
    this.world.gravity.set(0, -9.82, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    const ambient = new THREE.HemisphereLight(0xdff7ff, 0x5c6eb4, 2.4);
    this.scene.add(ambient);

    const softKey = new THREE.DirectionalLight(0xffffff, 0.7);
    softKey.position.set(-35, 70, 45);
    this.scene.add(softKey);

    this.city = new CityEnvironment(this.scene, this.world);

    this.helicopter = new Helicopter(this.scene, this.world);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);

    this.playerProjectiles = new ProjectilePool(this.scene, 150, 0xff2a2a);
    this.enemyProjectiles = new ProjectilePool(this.scene, 100, 0xffe94a);

    this.particles = new GPUParticleSystem(5000);
    this.scene.add(this.particles.mesh);

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
      opacity: 0.45,
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
    this.currentWave = 0;
    this.enemiesSpawnedInWave = 0;
    this.totalEnemiesInWave = 0;
    this.spawnTimer = 0;
    this.waveTransitionTimer = 2.2;
    this.waveMessage = "GET READY";
    this.weather.stormIntensity = 0;
    this.weather.targetIntensity = 0;
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
    window.removeEventListener(
      "gamepaddisconnected",
      this.onGamepadDisconnected,
    );
    window.removeEventListener("helistrike:settings", this.onSettingsChanged);
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
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

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

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const dy = Math.abs(enemy.body.position.y - origin.y);
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance || dy > 60) continue;

      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (useMouseCone && aheadBias < 0.28) continue;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
      if (useMouseCone && lateralDistance > 46 + dist * 0.12) continue;
      const lanePenalty = useMouseCone ? lateralDistance * 14 : Math.abs(dx) * 1.9;
      const behindPenalty = aheadBias < -0.25 ? 9000 : 0;
      const typeBonus =
        enemy.type === EnemyType.DRONE
          ? 1800
          : enemy.type === EnemyType.SHOOTER
            ? 1200
            : enemy.type === EnemyType.TANK
              ? 700
              : 0;
      const cursorDistance =
        this.mouseAimValid
          ? Math.hypot(enemy.body.position.x - this.mouseAimPoint.x, enemy.body.position.z - this.mouseAimPoint.z)
          : 0;
      const score =
        distSq * (useMouseCone ? 0.3 : 1) +
        lanePenalty +
        cursorDistance * (useMouseCone ? 4.5 : 0) +
        behindPenalty -
        typeBonus;

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
    const maxAimDistance = 210;
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
    this.isFiringMouse = true;
    this.isMouseActive = true;
    this.updateMouseAimFromEvent(e);
    this.updateAutoAim();
    this.audio.resume();
    if (this.health > 0) {
      this.fireWeapons(performance.now() / 1000);
    }
  };

  onPointerUp = () => {
    this.isFiringMouse = false;
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
    if (!this.isPlaying) return;
    const key = e.key.toLowerCase();
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
        "q",
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
  };

  onKeyUp = (e: KeyboardEvent) => {
    this.movementKeys.delete(e.key.toLowerCase());
  };

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
    if (
      impact > 3.5 &&
      now - this.lastCollisionDamageTime > 0.35 &&
      this.health > 0
    ) {
      const dmg = Math.min(14, Math.max(3, impact * 1.1));
      this.health = Math.max(0, this.health - dmg);
      this.helicopter.takeDamage(dmg);
      this.cameraShake = Math.max(
        this.cameraShake,
        Math.min(1.8, impact * 0.25),
      );
      this.lastCollisionDamageTime = now;
      this.movementTarget.set(
        this.helicopter.body.position.x,
        Math.max(this.helicopter.body.position.y, this.movementTarget.y),
        this.helicopter.body.position.z,
      );
      this.audio.playHit();
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
    const detail = (e as CustomEvent<{ invertedY?: boolean }>).detail;
    if (detail?.invertedY !== undefined)
      this.settings.invertedY = detail.invertedY;
  };

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
        ? 2.55
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

    // Spawn particles
    this.particles.spawnExplosion(
      this.helicopter.body.position.x + hDirX * noseOffset,
      muzzleY,
      this.helicopter.body.position.z + hDirZ * noseOffset,
      5,
      time,
      5,
    );

    this.cameraShake = Math.max(this.cameraShake, 0.4);

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

  dropPowerUp = (x: number, y: number, z: number) => {
    const rand = Math.random();
    let type: PowerUpType;

    if (rand <0.24) type = PowerUpType.HEALTH;
    else if (rand <0.42) type = PowerUpType.FUEL;
    else if (rand <0.58) type = PowerUpType.AMMO;
    else if (rand <0.72) type = PowerUpType.DAMAGE_BOOST;
    else if (rand <0.86) type = PowerUpType.SHIELD;
    else if (rand <0.94) type = PowerUpType.SPEED_BOOST;
    else type = PowerUpType.BOMB;

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
        const w = this.weapons.get(this.currentWeapon);
        if (w) w.damage = w.damage * 2;
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

    const radar = {
      player: {
        x: this.helicopter.body.position.x,
        z: this.helicopter.body.position.z,
        rotation: this.helicopter.mesh.rotation.y,
      },
      enemies: this.enemies.map((e) => ({
        x: e.body.position.x,
        z: e.body.position.z,
        type: e.type,
      })),
      projectiles: [
        ...this.playerProjectiles.pool
          .filter((p) => p.active)
          .map((p) => ({ x: p.pos.x, z: p.pos.z, owner: "player" })),
        ...this.enemyProjectiles.pool
          .filter((p) => p.active)
          .map((p) => ({ x: p.pos.x, z: p.pos.z, owner: "enemy" })),
      ],
    };

    const weapon = this.weapons.get(this.currentWeapon);

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
          radar,
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
        },
      }),
    );
    this.updateUI(time);
  }

  startNextWave() {
    this.currentWave++;
    this.totalEnemiesInWave = 5 + Math.floor(this.currentWave * 4.5);
    this.enemiesSpawnedInWave = 0;
    this.spawnTimer = 2.0;

    // Determine wave theme / message
    if (this.currentWave === 1) {
      this.waveMessage = "WAVE 1\nENGAGE THE DRONES";
    } else if (this.currentWave === 3) {
      this.waveMessage = "WAVE 3\nSTORM INCOMING";
    } else if (this.currentWave === 5) {
      this.waveMessage = "WAVE 5\nHEAVY ARMOR DETECTED";
    } else if (this.currentWave % 4 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\nSWARM TACTICS`;
      this.totalEnemiesInWave += 10; // Extra enemies on swarm waves
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
    const spot = this.getArcadeSpawnPoint(type, 0, 1);
    this.enemies.push(
      new Enemy(this.scene, this.world, spot.x, spot.z, type, spot.y),
    );
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
        ? { x: baseX, y: height + 2.2, z }
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
    const pressureFromThreats = Math.min(1, this.enemies.length / 18);
    const pressureFromHealth = 1 - this.health / this.maxHealth;
    this.combatIntensity = THREE.MathUtils.clamp(
      pressureFromTime * 0.55 + pressureFromThreats * 0.35 + pressureFromHealth * 0.25,
      0,
      1.3,
    );

    this.currentWave = Math.max(1, Math.floor(this.survivalTime / 35) + 1);
    this.directorTimer -= delta;
    const maxEnemies = 12 + Math.floor(this.combatIntensity * 13);

    if (this.directorTimer <= 0 && this.enemies.length < maxEnemies) {
      const burst = 1 + Math.floor(this.combatIntensity * 3);
      for (let i = 0; i < burst; i++) this.spawnDirectedEnemy(time, i, burst);
      this.directorTimer = Math.max(0.35, 1.8 - this.combatIntensity * 0.95);
    }

    this.battlefieldEventTimer -= delta;
    if (this.battlefieldEventTimer <= 0) {
      this.triggerBattlefieldEvent(time);
      this.battlefieldEventTimer = Math.max(9, 24 - this.combatIntensity * 10);
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
      // Circular deadzone/curve for smoother input
      const mag = Math.sqrt(aimX * aimX + aimY * aimY);
      const normX = aimX / mag;
      const normY = aimY / mag;
      const curvedMag = Math.pow((mag - DEADZONE) / (1 - DEADZONE), 1.2);

      const moveSpeed = 150 * delta * this.settings.gamepadSensitivity;
      this.movementTarget.x += normX * curvedMag * moveSpeed;

      const yMove = this.settings.invertedY ? -normY : normY;
      this.movementTarget.z += yMove * curvedMag * moveSpeed;
      this.clampMovementTarget();

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
      this.movementKeys.has("q") ||
      this.movementKeys.has("pagedown")
    )
      moveY -= 1;

    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (mag > 0) {
      const speedBoost = this.speedBoostTimer > 0 ? 1.24 : 1;
      const moveSpeed = (this.leftStick.active ? 96 : 82) * speedBoost;
      const cappedMag = Math.min(1, mag);
      this.movementTarget.x += (moveX / mag) * cappedMag * moveSpeed * delta;
      this.movementTarget.z += (moveZ / mag) * cappedMag * moveSpeed * delta;
    } else {
      this.movementTarget.x +=
        (this.helicopter.body.position.x - this.movementTarget.x) *
        Math.min(1, delta * 1.8);
      this.movementTarget.z +=
        (this.helicopter.body.position.z - this.movementTarget.z) *
        Math.min(1, delta * 1.8);
    }

    this.movementTarget.z -= this.autoScrollSpeed * delta;

    if (moveY !== 0) {
      const climbSpeed = 34;
      this.movementTarget.y += moveY * climbSpeed * delta;
    } else {
      this.movementTarget.y +=
        (this.helicopter.body.position.y - this.movementTarget.y) *
        Math.min(1, delta * 1.2);
    }

    this.clampMovementTarget();
  }

  clampMovementTarget() {
    this.movementTarget.x = Math.max(
      -190,
      Math.min(190, this.movementTarget.x),
    );
    this.movementTarget.z = Math.max(
      this.helicopter.body.position.z - 215,
      Math.min(this.helicopter.body.position.z + 75, this.movementTarget.z),
    );
    this.movementTarget.y = Math.max(15, Math.min(58, this.movementTarget.y));
  }

  tick = () => {
    this.animationFrame = requestAnimationFrame(this.tick);

    const time = performance.now() / 1000;
    const delta = Math.min(time - this.lastTime, 0.1);
    this.lastTime = time;

    if (!this.isPlaying) {
      this.innerRing.rotation.z += 0.025;
      this.outerRing.rotation.z -= 0.01;
      this.helicopter.mainRotor.rotation.y += 0.25;
      this.helicopter.tailRotor.rotation.x += 0.25;
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.pollGamepad(time, delta);
    this.updateKeyboardMovement(delta);
    this.currentFuel = Math.max(
      0,
      this.currentFuel - this.fuelDrainPerSecond * delta,
    );
    if (this.currentFuel <= 0 && this.health > 0) {
      this.health = Math.max(0, this.health - 8 * delta);
      this.helicopter.takeDamage(2 * delta);
    }
    this.emitStatsIfChanged();
    this.city.update(this.helicopter.body.position.z, this.world);
    this.updateAIDirector(time, delta);

    // Twin-stick aim has priority on mobile; desktop mouse fire uses auto-lock.
    if (this.rightStick.active) {
      this.updateStickAim();
    } else {
      this.updateAutoAim();
    }
    this.innerRing.rotation.z += 0.05;
    this.outerRing.rotation.z -= 0.02;

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
        if (!this.disposed) this.renderer.setClearColor(0x9fdce8);
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
      if (fired) this.audio.playEnemyFire();

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
        this.health = Math.max(0, this.health - dmg);
        this.helicopter.takeDamage(dmg);
        this.updateUI(time);
      }
    }

    // --- Projectile Physics ---
    this.playerProjectiles.updatePositions(time, delta);
    this.enemyProjectiles.updatePositions(time, delta);

    for (const proj of this.playerProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        proj.damage * (proj.blastRadius > 0 ? 1.2 : 0.55),
      );
      if (!hitBlock) continue;

      this.particles.spawnExplosion(
        proj.pos.x,
        proj.pos.y,
        proj.pos.z,
        proj.blastRadius > 0 ? 38 : 12,
        time,
        proj.blastRadius > 0 ? 22 : 8,
      );
      if (proj.blastRadius > 0) {
        this.city.damageNearby(
          proj.pos.x,
          proj.pos.z,
          proj.blastRadius,
          proj.damage * 0.85,
        );
      }
      this.audio.playExplosion(proj.blastRadius > 0 ? 0.65 : 0.16);
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
      this.particles.spawnExplosion(
        proj.pos.x,
        proj.pos.y,
        proj.pos.z,
        10,
        time,
        8,
      );
      proj.deactivate();
    }

    this.playerProjectiles.checkEnemyHits(this.enemies, (proj, enemy) => {
      const totalDmg = proj.damage * this.comboMultiplier;
      const died = enemy.takeDamage(totalDmg);

      this.particles.spawnExplosion(
        proj.pos.x,
        proj.pos.y,
        proj.pos.z,
        15,
        time,
        10,
      );
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

        // Drop power-up chance (20% base, higher for tanks)
        const dropChance = enemy.type === EnemyType.TANK ? 0.5 : 0.2;
        if (Math.random() < dropChance) {
          this.dropPowerUp(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z);
        }

        this.particles.spawnExplosion(
          enemy.body.position.x,
          enemy.body.position.y,
          enemy.body.position.z,
          80,
          time,
          30,
        );
        this.city.damageNearby(enemy.body.position.x, enemy.body.position.z, 22, 95);
        this.audio.playExplosion(1.0);
      }
    });

    this.enemyProjectiles.checkPlayerHits(
      this.helicopter.body.position,
      (proj) => {
        if (this.health > 0) {
          // Shield protects from damage
          if (this.shieldTimer > 0) {
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
        // Reset damage boost
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) weapon.damage = WEAPON_CONFIGS[this.currentWeapon].damage;
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

    // Update UI every and radar every frame for smoothness
    this.updateUI(time);

    this.updateCamera();

    this.renderer.render(this.scene, this.camera);
  };

  updateCamera() {
    const speed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 + this.helicopter.body.velocity.z ** 2,
    );
    let camTargetX = this.helicopter.body.position.x;
    let camTargetZ = this.helicopter.body.position.z + 52 + this.combatIntensity * 8;

    camTargetX += this.helicopter.body.velocity.x * 0.7;
    camTargetZ += this.helicopter.body.velocity.z * 0.65;

    const camLerp = this.isPlaying ? 0.1 : 0.035;
    this.camera.position.x += (camTargetX - this.camera.position.x) * camLerp;
    this.camera.position.z += (camTargetZ - this.camera.position.z) * camLerp;

    const camTargetY = 62 + Math.min(speed * 0.1, 9) + this.combatIntensity * 5;
    this.camera.position.y += (camTargetY - this.camera.position.y) * 0.05;

    const targetFov = 52 + Math.min(speed * 0.08, 7) + this.combatIntensity * 5;
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

    this.camera.lookAt(
      this.helicopter.body.position.x,
      17,
      this.helicopter.body.position.z - 9,
    );
  }
}
