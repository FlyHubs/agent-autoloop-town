// 自动化小镇：把中台的状态和事实流画成一个微缩景观。Webhook 中台在镇中心的玻璃圆顶下；西边每个项目一个厂区，
// 一条规则一台机器；东边每个 Agent 一个舞台。每个包裹对应一件真实的事。
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const { token: TOKEN, mode: MODE, hub: HUB, tasks: TASKS } = window.TOWN;
const $ = (id) => document.getElementById(id);

// Everything the hub sends is words an Agent or a stranger wrote: it only ever becomes text, never markup.
function node(tag, props = {}, ...kids) {
  const made = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "class") made.className = value;
    else if (name.startsWith("on")) made.addEventListener(name.slice(2), value);
    else if (value !== false && value != null) made.setAttribute(name, value === true ? "" : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) made.append(kid);
  return made;
}

const STATES = {
  queued: { label: "排队", icon: "◷", tone: "" },
  retrying: { label: "等重试", icon: "↻", tone: "warn" },
  claimed: { label: "在跑", icon: "⚙", tone: "busy" },
  unknown: { label: "不确定还在不在跑", icon: "?", tone: "serious" },
  done: { label: "做成了", icon: "✓", tone: "good" },
  nothing: { label: "没事可做", icon: "–", tone: "" },
  cancelled: { label: "没做成", icon: "✕", tone: "crit" },
};
const kindOf = (run) => (run.state === "queued" && run.attempts > 0 ? "retrying" : run.state);
const ENDED = ["done", "nothing", "cancelled"];
const chip = (kind) => node("span", { class: `chip ${STATES[kind].tone}` }, node("i", {}, STATES[kind].icon), STATES[kind].label);
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false }) : "");
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

// ------------------------------------------------------------------ renderer, camera, light

const holder = $("scene");
const tags = $("tags");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
// How finely the scene is drawn, as pixels to a point. "ratio" in the address sets it, to compare how it looks with how
// fast it goes.
const RATIO = Math.min(2, Math.max(0.5, Number(new URLSearchParams(location.search).get("ratio")) || 1.5));
renderer.setPixelRatio(Math.min(devicePixelRatio, RATIO));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false; // one frame is several passes: what it cost is counted over all of them
holder.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, 1, 3200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 0.25;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.46;
controls.minDistance = 34;
controls.maxDistance = 460;
// It turns slowly by itself until someone takes hold of it, and again once they've left it alone a while.

const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(hemi, sun, sun.target);
scene.fog = new THREE.Fog(0xffffff, 380, 900);

const night = matchMedia("(prefers-color-scheme: dark)");
const still = matchMedia("(prefers-reduced-motion: reduce)");
// Ground colours are tints over textures drawn for daylight: white by day, and what turns them to dusk by night.
const LOOKS = {
  day: { top: 0x8ec9f0, horizon: 0xc4dcae, grass: 0xffffff, plaza: 0xffffff, leaf: 0xffffff, water: 0x5aa7c9, sun: 0xfff0cf, sunPower: 3.1, sunFrom: [-0.5, 0.78, 0.38], sky: 0xdcefff, earth: 0xa9b295, hemi: 0.8, env: 0.7, exposure: 1.06, glow: 0, bloom: 0, far: 0x7f9fc4 },
  night: { top: 0x0b1230, horizon: 0x27325e, grass: 0x6278c4, plaza: 0x7783b8, leaf: 0x7a8fd6, water: 0x2c4c8c, sun: 0xb4c2ff, sunPower: 1.25, sunFrom: [0.42, 0.76, 0.34], sky: 0x8ea0ea, earth: 0x2c3760, hemi: 1.25, env: 0.5, exposure: 1.16, glow: 1, bloom: 0.55, far: 0x18224a },
  // Sunrise and sunset: what the day's look and the night's are drawn toward for an hour either side of them.
  gold: { top: 0x7b93d2, horizon: 0xf6c8a2, grass: 0xfff0d6, plaza: 0xffecd8, leaf: 0xffeed4, water: 0x86a4c6, sun: 0xffc38c, sunPower: 3.3, sky: 0xf6dfe4, earth: 0xa3968a, hemi: 0.98, env: 0.8, exposure: 1.13, far: 0x8c7fb0 },
};
// "auto" goes by the sun; "day", "night" and "gold" hold one look whatever the hour.
let lookMode = "auto";
// How each kind of weather changes the light, how far one can see, what lies on the ground and what falls.
const SKIES = {
  clear: { words: "晴", icon: "sun", sun: 1, hemi: 1, exposure: 1, haze: [1.6, 3.9], wet: 0, snow: 0, fall: null },
  cloudy: { words: "多云", icon: "cloud", sun: 0.78, hemi: 1.12, exposure: 1, haze: [1.6, 3.9], wet: 0, snow: 0, fall: null },
  overcast: { words: "阴", icon: "cloud", sun: 0.5, hemi: 1.3, exposure: 0.97, haze: [1.4, 3.5], wet: 0, snow: 0, fall: null },
  fog: { words: "雾", icon: "fog", sun: 0.42, hemi: 1.35, exposure: 1, haze: [0.72, 1.85], wet: 0.2, snow: 0, fall: null },
  drizzle: { words: "小雨", icon: "rain", sun: 0.5, hemi: 1.25, exposure: 0.95, haze: [1.25, 3.2], wet: 0.6, snow: 0, fall: "drizzle" },
  rain: { words: "雨", icon: "rain", sun: 0.42, hemi: 1.22, exposure: 0.92, haze: [1.05, 2.8], wet: 1, snow: 0, fall: "rain" },
  snow: { words: "雪", icon: "snow", sun: 0.62, hemi: 1.4, exposure: 1.04, haze: [1.1, 3], wet: 0, snow: 1, fall: "snow" },
  storm: { words: "雷雨", icon: "storm", sun: 0.3, hemi: 1.12, exposure: 0.86, haze: [1, 2.7], wet: 1, snow: 0, fall: "rain" },
};
/** The kind of weather a WMO weather code stands for. */
const skyOfCode = (code) => (code <= 1 ? "clear" : code === 2 ? "cloudy" : code === 3 ? "overcast" : code <= 48 ? "fog" : code <= 57 ? "drizzle" : code <= 67 ? "rain" : code <= 77 ? "snow" : code <= 82 ? "rain" : code <= 86 ? "snow" : "storm");
const weather = { city: localStorage.getItem("town.city") ?? "", live: null, error: "", preview: null };
const skyNow = () => weather.preview ?? (weather.live ? skyOfCode(weather.live.code) : "clear");
// The hour and the day the town goes by: the real ones, unless one is being pretended to look ahead at it.
// `today` says the pretended time is of the day it is: the day played back, for which today's own sunrise still holds.
const calendar = { pretend: null, play: null, today: false };
const timeNow = () => new Date(calendar.pretend ?? Date.now());
const dayOfYear = (date) => (date - new Date(date.getFullYear(), 0, 1)) / 86_400_000;
/** The minute of the day it is: in the owner's city where the weather service has said how far that is from Greenwich. */
const minuteAt = (date) =>
  weather.live?.offset !== undefined && (calendar.pretend === null || calendar.today)
    ? (date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + weather.live.offset + 2880) % 1440
    : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
/**
 * When the sun comes up and goes down, in minutes of the day: as the weather service has it for the owner's city today;
 * else, and for any other day, by the calendar, as it is about a third of the way from the equator to the pole.
 */
function sunTimes(date) {
  if (weather.live?.sunrise !== undefined && weather.live.sunset !== undefined && (calendar.pretend === null || calendar.today)) {
    // Near the poles there are days the sun never sets on, and days it never rises: then it is as the service says it is now.
    if (weather.live.sunset - weather.live.sunrise > 30) return [weather.live.sunrise, weather.live.sunset];
    return weather.live.isDay ? [-200, 1640] : [3000, 3001];
  }
  const half = (12 + 2.4 * Math.cos(((dayOfYear(date) - 172) / 365 + (weather.live?.south ? 0.5 : 0)) * Math.PI * 2)) * 30;
  return [720 - half, 720 + half];
}
/**
 * What the light is at a time: how much of day is in it (0 at night, 1 by day), how much of the gold of sunrise and
 * sunset, and how far over the sun is (0 as it rises, 1 as it sets; null where the day's look is held as it was drawn).
 */
function lightAt(date) {
  if (lookMode !== "auto") return { light: lookMode === "night" ? 0 : lookMode === "gold" ? 0.8 : 1, gold: lookMode === "gold" ? 1 : 0, part: lookMode === "gold" ? 0.95 : null };
  const [rise, set] = sunTimes(date);
  const minute = minuteAt(date);
  const ease = (value) => THREE.MathUtils.smoothstep(value, 0, 1);
  // The light comes over seventy minutes round sunrise and goes the same way at sunset; the gold is at its most a
  // little inside the day at either end, and lasts an hour each side of that.
  return {
    light: Math.min(ease((minute - rise + 35) / 70), ease((set + 35 - minute) / 70)),
    gold: Math.max(ease(1 - Math.abs(minute - rise - 12) / 62), ease(1 - Math.abs(minute - set + 12) / 62)),
    part: THREE.MathUtils.clamp((minute - rise) / (set - rise), 0, 1),
  };
}
/**
 * How much of each season there is in a day of the year: spring, summer, autumn and winter, adding up to one. Each
 * is whole for seven weeks about its middle and gives way to the next over six. `late` puts the year back by a part
 * of itself, for no two trees turn on the same day. South of the equator the year is half a turn on.
 */
function seasonsAt(date, late = 0) {
  const year = (((dayOfYear(date) / 365 + (weather.live?.south ? 0.5 : 0) - late) % 1) + 1) % 1;
  const shares = [0.29, 0.54, 0.79, 0.04].map((middle) => THREE.MathUtils.smoothstep(0.185 - Math.abs(((year - middle + 1.5) % 1) - 0.5), 0, 0.12));
  const all = shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share) => share / all);
}
/** How much mist lies at a time: it gathers before sunrise and is gone two hours after; most in autumn, least in summer. */
function mistAt(date, season) {
  if (lookMode !== "auto") return 0;
  const since = minuteAt(date) - sunTimes(date)[0];
  return Math.min(THREE.MathUtils.smoothstep(since, -70, -15), 1 - THREE.MathUtils.smoothstep(since, 50, 125)) * (season[0] * 0.8 + season[1] * 0.45 + season[2] + season[3] * 0.75);
}
const LOOK_HUES = ["top", "horizon", "grass", "plaza", "leaf", "water", "sun", "sky", "earth", "far"];
const LOOK_SIZES = ["sunPower", "hemi", "env", "exposure"];
/** The look of a time: the night's and the day's mixed by how light it is, and drawn toward the gold at either end of the day. */
function lookAt(date) {
  const { light, gold, part } = lightAt(date);
  const [one, other] = [new THREE.Color(), new THREE.Color()];
  const now = { light, gold, part, glow: 1 - light, bloom: LOOKS.night.bloom * (1 - light), dark: light < 0.5, season: seasonsAt(date) };
  now.mist = mistAt(date, now.season);
  for (const name of LOOK_HUES) now[name] = one.setHex(LOOKS.night[name]).lerp(other.setHex(LOOKS.day[name]), light).lerp(other.setHex(LOOKS.gold[name]), gold * 0.85).getHex();
  for (const name of LOOK_SIZES) now[name] = THREE.MathUtils.lerp(THREE.MathUtils.lerp(LOOKS.night[name], LOOKS.day[name], light), LOOKS.gold[name], gold * 0.85);
  // The sun goes over from the east by the south to the west, low at either end. The moon keeps its place.
  const arc = part === null ? LOOKS.day.sunFrom : [Math.cos(Math.PI * part), 0.4 + 0.4 * Math.sin(Math.PI * part), 0.14 + 0.42 * Math.sin(Math.PI * part)];
  now.sunFrom = LOOKS.night.sunFrom.map((value, index) => THREE.MathUtils.lerp(value, arc[index], light));
  return now;
}
/** What of a look, when it has changed, is worth setting the town out again for. */
const stampOf = (now) => [lookMode, Math.round(now.light * 40), Math.round(now.gold * 40), now.part === null ? "" : Math.round(now.part * 72), ...now.season.map((share) => Math.round(share * 48)), Math.round(now.mist * 24)].join(":");
// The look it has now: worked out when the town is restyled, and asked for by everything between.
const lit = { now: null, stamp: "" };
const look = () => (lit.now ??= lookAt(timeNow()));
const isNight = () => look().dark;

/** A tile of flat colour with grain in it, drawn here: nothing is downloaded. */
function drawn(size, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d"), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
function speckle(pen, size, base, grains, count, most = 2) {
  pen.fillStyle = base;
  pen.fillRect(0, 0, size, size);
  const random = seeded(size + count);
  for (let i = 0; i < count; i++) {
    pen.fillStyle = grains[Math.floor(random() * grains.length)];
    const dot = 1 + random() * most;
    pen.fillRect(random() * size, random() * size, dot, dot);
  }
  return random;
}
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TEXTURES = {
  road: drawn(256, (pen, size) => void speckle(pen, size, "#63656a", ["#585a5f", "#6e7075", "#515358", "#777a7f"], 5200)),
  kerb: drawn(256, (pen, size) => void speckle(pen, size, "#c6c2b8", ["#b9b5aa", "#d2cec4", "#bfbbb0"], 2400)),
  plaza: drawn(512, (pen, size) => {
    const random = speckle(pen, size, "#d3cdbf", ["#c8c2b3", "#dcd6c9"], 1500);
    const tile = size / 8;
    for (let row = 0; row < 8; row++)
      for (let column = 0; column < 8; column++) {
        pen.fillStyle = `rgba(${random() < 0.5 ? "60,50,30" : "255,250,235"},${(random() * 0.09).toFixed(3)})`;
        pen.fillRect(column * tile + (row % 2 ? tile / 2 : 0) - tile / 2, row * tile, tile, tile);
      }
    pen.strokeStyle = "rgba(120,112,96,0.55)";
    pen.lineWidth = 1.5;
    for (let row = 0; row <= 8; row++) {
      pen.beginPath(), pen.moveTo(0, row * tile), pen.lineTo(size, row * tile), pen.stroke();
      for (let column = 0; column <= 8; column++) {
        const x = column * tile + (row % 2 ? tile / 2 : 0);
        pen.beginPath(), pen.moveTo(x, row * tile), pen.lineTo(x, (row + 1) * tile), pen.stroke();
      }
    }
  }),
};
const ground = {
  grass: new THREE.MeshStandardMaterial({ roughness: 1 }),
  plaza: new THREE.MeshStandardMaterial({ roughness: 0.92, map: TEXTURES.plaza }),
  road: new THREE.MeshStandardMaterial({ roughness: 0.94, map: TEXTURES.road, side: THREE.DoubleSide }),
  kerb: new THREE.MeshStandardMaterial({ roughness: 0.9, map: TEXTURES.kerb, side: THREE.DoubleSide }),
  mark: new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide }),
  water: new THREE.MeshStandardMaterial({ roughness: 0.06, metalness: 0.35 }),
  cloud: new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
};

// The sky is a dome painted from the horizon up; what it lights the town with is baked from the same dome.
const dome = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 20), new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true, fog: false, depthWrite: false }));
dome.geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(dome.geometry.attributes.position.count * 3), 3));
dome.userData.flat = true;
dome.renderOrder = -1;
scene.add(dome);
// Stars, out when it is dark and the sky is clear: more of them low down, where the eye can get to see them.
const stars = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
{
  const random = seeded(1234);
  const [spots, hues] = [[], []];
  for (let star = 0; star < 1500; star++) {
    const [around, up] = [random() * Math.PI * 2, Math.asin(Math.pow(random(), 1.6))];
    spots.push(Math.cos(around) * Math.cos(up) * 2300, Math.sin(up) * 2300 + 14, Math.sin(around) * Math.cos(up) * 2300);
    const bright = 0.3 + Math.pow(random(), 2.2) * 0.7;
    hues.push(bright, bright, bright * (0.85 + random() * 0.3));
  }
  stars.geometry.setAttribute("position", new THREE.Float32BufferAttribute(spots, 3));
  stars.geometry.setAttribute("color", new THREE.Float32BufferAttribute(hues, 3));
  stars.frustumCulled = stars.visible = false;
  stars.userData.flat = true;
  scene.add(stars);
}
const pmrem = new THREE.PMREMGenerator(renderer);
let baked = -1e9;
function paintSky(now, hurried = false) {
  const top = new THREE.Color(now.top), horizon = new THREE.Color(now.horizon), mixed = new THREE.Color(), warm = new THREE.Color(0xffb36b);
  const { position, color } = dome.geometry.attributes;
  const toSun = Math.atan2(now.sunFrom[2], now.sunFrom[0]);
  for (let i = 0; i < position.count; i++) {
    const height = Math.max(0, position.getY(i) / 2400);
    mixed.copy(horizon).lerp(top, Math.pow(height, 0.55));
    // At sunrise and sunset the sky is warm low down on the side the sun is.
    if (now.gold > 0) mixed.lerp(warm, now.gold * 0.6 * Math.pow(Math.max(0, Math.cos(Math.atan2(position.getZ(i), position.getX(i)) - toSun)), 3) * Math.pow(1 - height, 6));
    color.setXYZ(i, mixed.r, mixed.g, mixed.b);
  }
  color.needsUpdate = true;
  // What the sky lights the town with is baked again from it; while a day or a year is run through, not at every step.
  if (hurried && performance.now() - baked < 400) return;
  baked = performance.now();
  const around = new THREE.Scene();
  around.add(dome.clone());
  const floor = new THREE.Mesh(new THREE.CircleGeometry(2300, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xa3a497).multiply(new THREE.Color(now.grass)) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  around.add(floor);
  scene.environment?.dispose();
  scene.environment = pmrem.fromScene(around, 0.03).texture;
  scene.environmentIntensity = now.env;
}

// Soft shadow where things meet, and a glow on lamps at night. Without it the town is still drawn, only flatter.
let composer = null;
let bloom = null;
let contact = null;
let tilt = [];
try {
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  contact = new GTAOPass(scene, camera, 4, 4);
  contact.updateGtaoMaterial({ radius: 2.4, distanceExponent: 1.5, thickness: 1.4, scale: 1.2, samples: 8, screenSpaceRadius: false });
  contact.updatePdMaterial({ samples: 8 });
  contact.blendIntensity = 0.85;
  // Smoke, sky and clouds have no surface to shade: they sit out the pass that works out where surfaces meet.
  const hidePoints = contact._overrideVisibility.bind(contact);
  contact._overrideVisibility = function () {
    hidePoints();
    scene.traverse((part) => part.userData.flat && part.visible && ((part.visible = false), this._visibilityCache.push(part)));
  };
  // The shading is soft by nature, so it can be worked out on fewer pixels and stretched over the picture: on a large
  // screen that costs a quarter as much. "ao" in the address says how: half (the default), full, or off.
  const shading = new URLSearchParams(location.search).get("ao");
  if (shading === "off") contact.enabled = false;
  if (shading !== "full") {
    const fullSize = contact.setSize.bind(contact);
    contact.setSize = (width, height) => fullSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
  composer.addPass(contact);
  bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.5, 0.6, 0.85);
  composer.addPass(bloom);
  const soften = (dir, shade = 0) =>
    new ShaderPass({
      uniforms: { tDiffuse: { value: null }, dir: { value: dir }, focus: { value: 0.5 }, spread: { value: 2.3 }, shade: { value: shade } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; uniform float focus; uniform float spread; uniform float shade; varying vec2 vUv;
        void main() {
          float amount = smoothstep(0.17, 0.62, abs(vUv.y - focus)) * spread;
          vec4 sum = vec4(0.0);
          float total = 0.0;
          for (int i = -4; i <= 4; i++) {
            float weight = 1.0 - abs(float(i)) / 5.0;
            sum += texture2D(tDiffuse, vUv + dir * float(i) * amount) * weight;
            total += weight;
          }
          gl_FragColor = sum / total;
          gl_FragColor.rgb *= 1.0 - shade * smoothstep(0.8, 1.5, length((vUv - 0.5) * 2.0));
        }`,
    });
  tilt = [soften(new THREE.Vector2(0.001, 0)), soften(new THREE.Vector2(0, 0.001), 0.2)];
  for (const pass of tilt) composer.addPass(pass);
  composer.addPass(new OutputPass());
} catch (error) {
  console.warn("post-processing unavailable", error);
  composer = null;
}

// ------------------------------------------------------------------ models: Blender's, or a stand-in built here

const PALETTE = {
  wall: 0xefe9dc, wall_brick: 0xc98a6b, stone: 0xb9b5aa, trim: 0xfcfcfb, dark: 0x3d3c39, metal: 0x8d949b, wood: 0xb08a5a,
  window: 0xa9c4dd, roof_hall: 0x5b6b7a, roof_station: 0x2a78d6, roof_factory: 0xeb6834, roof_warehouse: 0x1baf7a,
  roof_small: 0x8a7f72, body: 0xe8e4da, beacon: 0xfab219, flag: 0xc3c2b7, crate: 0xc8a26b, crate_trim: 0x8a6a3e,
  leaf: 0x4f9a5b, leaf_dark: 0x3b7d4a, trunk: 0x7a5a3a, bulb: 0xffe9a8,
};
const sharedPaint = new Map();
function paintOf(name) {
  if (!sharedPaint.has(name)) {
    const made = new THREE.MeshStandardMaterial({
      color: PALETTE[name],
      roughness: name === "metal" ? 0.45 : name === "window" ? 0.25 : 0.8,
      metalness: name === "metal" ? 0.6 : 0,
      flatShading: true,
    });
    made.name = name;
    sharedPaint.set(name, made);
  }
  return sharedPaint.get(name);
}
function box(paint, w, h, d, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paintOf(paint));
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}
function gable(paint, w, h, d, x = 0, y = 0, z = 0) {
  const shape = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geometry.translate(0, 0, -d / 2);
  const mesh = new THREE.Mesh(geometry, paintOf(paint));
  mesh.position.set(x, y, z);
  return mesh;
}
function round(paint, radius, h, x = 0, y = 0, z = 0, sides = 10) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, sides), paintOf(paint));
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}
function cone(paint, radius, h, x, y, z, sides = 4) {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, h, sides), paintOf(paint));
  mesh.position.set(x, y + h / 2, z);
  mesh.rotation.y = Math.PI / 4;
  return mesh;
}
const named = (name, object) => ((object.name = name), object);
function anchor(name, x, z, y = 0) {
  const made = new THREE.Object3D();
  made.name = name;
  made.position.set(x, y, z);
  return made;
}
const group = (...parts) => new THREE.Group().add(...parts);
function wheels(width, front, back, radius = 0.4) {
  return [[-1, front, "fl"], [1, front, "fr"], [-1, back, "rl"], [1, back, "rr"]].map(([side, z, name]) => {
    const wheel = round("dark", radius, 0.3, 0, 0, 0, 10);
    wheel.geometry.rotateZ(Math.PI / 2);
    wheel.position.set((side * width) / 2, radius, z);
    return named(`wheel_${name}`, wheel);
  });
}

/** Stand-ins with the same names, sizes and anchors as the Blender models: the town works before those arrive. */
const STANDINS = {
  hall: () =>
    group(
      box("stone", 17, 0.8, 12), box("wall", 16, 7, 11, 0, 0.8), gable("roof_hall", 17, 2.4, 11.6, 0, 7.8),
      box("wall", 4.4, 5.2, 4.4, 0, 7.8), cone("roof_hall", 3.6, 2.4, 0, 13, 0),
      named("beacon", new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), paintOf("beacon")).translateY(15.9)),
      box("dark", 0.12, 2.6, 0.12, 1.2, 13), named("flag", box("flag", 1.7, 1, 0.08, 2.1, 14.5)),
      box("dark", 3, 3.6, 0.3, 0, 0.8, 5.5), box("stone", 6, 0.4, 2, 0, 0, 6.6), box("wood", 3.2, 2.2, 0.2, -5, 2.4, 5.55),
      box("dark", 0.3, 3.2, 3.6, 8.05, 0.8), box("dark", 0.3, 3.2, 3.6, -8.05, 0.8),
      ...[-6, 5, 6.6].flatMap((x) => [box("window", 1.2, 1.5, 0.2, x, 5.4, 5.5)]),
      box("window", 1.2, 1.5, 0.2, 3.4, 2.4, 5.5),
      anchor("anchor_front", 0, 9.6), anchor("anchor_east", 10.5, 0), anchor("anchor_west", -10.5, 0),
    ),
  station: () =>
    group(
      box("stone", 9, 0.7, 6), ...[[-4, -2.5], [4, -2.5], [-4, 2.5], [4, 2.5]].map(([x, z]) => box("wood", 0.3, 3.2, 0.3, x, 0.7, z)),
      gable("roof_station", 9.8, 1.6, 6.8, 0, 3.9), box("crate", 1, 1, 1, -2.4, 0.7, 0.4), box("crate", 1, 1, 1, -1.2, 0.7, -0.6),
      box("crate", 1, 1, 1, 2.2, 0.7, 0.2), anchor("anchor_out", 0, 5),
    ),
  clocktower: () => {
    const hand = (name, w, h) => {
      const mesh = box("dark", w, h, 0.06, 0, 0, 0);
      mesh.geometry.translate(0, h / 2, 0);
      mesh.position.set(0, 6.6, 1.92);
      return named(name, mesh);
    };
    const face = (turn) => {
      const disc = round("trim", 1.3, 0.12, 0, 0, 0, 16);
      disc.geometry.rotateX(Math.PI / 2);
      disc.position.set(Math.sin(turn) * 1.82, 6.6, Math.cos(turn) * 1.82);
      disc.rotation.y = turn;
      return disc;
    };
    return group(
      box("wall", 3.6, 8.6, 3.6), box("trim", 4, 0.4, 4, 0, 8.6), cone("roof_station", 3, 2.6, 0, 9, 0),
      ...[0, Math.PI / 2, Math.PI, -Math.PI / 2].map(face), hand("hand_hour", 0.16, 0.75), hand("hand_minute", 0.12, 1.1),
      anchor("anchor_out", 0, 4),
    );
  },
  factory: () => {
    const gear = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.22, 6, 10), paintOf("metal"));
    gear.position.set(3.2, 2.9, 4.12);
    return group(
      box("wall_brick", 11, 4.6, 8), ...[-3.66, 0, 3.66].map((x) => gable("roof_factory", 3.66, 1.5, 8.2, x, 4.6)),
      round("wall_brick", 0.75, 10.5, 4.3, 0, -3), box("dark", 3.4, 3.2, 0.2, -1.6, 0, 4.02),
      ...[-4.4, 1.2].map((x) => box("window", 1.2, 1, 0.2, x, 3.2, 4.02)), named("gear", gear),
      anchor("anchor_smoke", 4.3, -3, 10.5), anchor("anchor_gate", -1.6, 6), anchor("anchor_park", 7.6, 0.5),
    );
  },
  warehouse: () =>
    group(
      box("wall", 12, 3.6, 8), gable("roof_warehouse", 12.8, 1.9, 8.6, 0, 3.6), box("dark", 3, 3, 0.2, -2.6, 0, 4.02),
      box("dark", 3, 3, 0.2, 2.6, 0, 4.02), anchor("anchor_in", 0, 6),
    ),
  postoffice: () =>
    group(
      box("wall", 6, 3, 5), gable("roof_small", 6.6, 1.5, 5.6, 0, 3), box("wood", 1.1, 2, 0.2, -1, 0, 2.52),
      box("window", 1.4, 1.1, 0.2, 1.4, 1.2, 2.52), round("roof_station", 0.3, 1.2, 2.4, 0, 3.6), anchor("anchor_out", 0, 4.5),
    ),
  house: () =>
    group(
      box("wall", 7, 3, 6), gable("roof_small", 7.6, 2.2, 6.6, 0, 3), box("wall_brick", 0.8, 2.2, 0.8, 2, 3.6, -1),
      box("wood", 1.2, 2.1, 0.2, 0, 0, 3.02), box("window", 1.2, 1.1, 0.2, -2.2, 1.2, 3.02), box("window", 1.2, 1.1, 0.2, 2.2, 1.2, 3.02),
      box("wood", 0.12, 1.1, 0.12, 2.8, 0, 4.2), box("metal", 0.5, 0.3, 0.3, 2.8, 1.1, 4.2),
      named("mailflag", box("flag", 0.06, 0.4, 0.25, 3.1, 1.2, 4.2)), anchor("anchor_door", 0, 4.5),
    ),
  truck: () =>
    group(box("body", 1.7, 0.25, 2.4, 0, 0.7, -0.8), box("body", 1.7, 1.2, 1.3, 0, 0.7, 1.2), box("window", 1.5, 0.55, 0.1, 0, 1.25, 1.86), ...wheels(1.7, 1.2, -1.2), anchor("anchor_cargo", 0, -0.8, 0.95)),
  van: () => group(box("body", 1.8, 1.6, 2.6, 0, 0.6, -0.6), box("body", 1.8, 1.15, 1.2, 0, 0.6, 1.3), box("window", 1.6, 0.5, 0.1, 0, 1.2, 1.91), ...wheels(1.8, 1.2, -1.2)),
  scooter: () => group(box("body", 0.4, 0.55, 1.4, 0, 0.35), box("roof_station", 0.55, 0.5, 0.5, 0, 0.9, -0.5), box("dark", 0.5, 0.08, 0.08, 0, 1.05, 0.6), ...wheels(0.1, 0.6, -0.6, 0.28).slice(0, 4)),
  crate: () => group(box("crate", 1, 1, 1), box("crate_trim", 1.04, 0.12, 1.04, 0, 0.1), box("crate_trim", 1.04, 0.12, 1.04, 0, 0.78)),
  tree_a: () => group(round("trunk", 0.25, 1.4), cone("leaf_dark", 1.5, 2.6, 0, 1.2, 0, 7), cone("leaf_dark", 1.1, 2.2, 0, 3, 0, 7)),
  tree_b: () => group(round("trunk", 0.28, 1.8), new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 0), paintOf("leaf")).translateY(3.2)),
  lamp: () => group(round("dark", 0.08, 3.6), named("bulb", new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), paintOf("bulb")).translateY(3.75))),
};

const templates = new Map();
const fromBlender = new Set();
async function loadModels() {
  const loader = new GLTFLoader();
  const there = await fetch("api/models", { headers: { "x-town-token": TOKEN } }).then((response) => response.json()).catch(() => []);
  await Promise.all(
    Object.keys(STANDINS).map(async (name) => {
      let root;
      try {
        if (!there.includes(name)) throw new Error("not modelled yet");
        root = (await loader.loadAsync(`models/${name}.glb`)).scene;
        fromBlender.add(name);
      } catch {
        root = STANDINS[name]();
      }
      root.traverse((part) => {
        if (!part.isMesh) return;
        part.castShadow = true;
        part.receiveShadow = true;
        if (fromBlender.has(name) && !TRAVELS.test(name)) snowy(part.material);
      });
      templates.set(name, root);
    }),
  );
  await Promise.all(
    EXTRAS.filter((name) => there.includes(name) && !(PLAIN && name.startsWith("fine_"))).map(async (name) => {
      try {
        const root = (await loader.loadAsync(`models/${name}.glb`)).scene;
        root.traverse((part) => {
          if (!part.isMesh) return;
          part.castShadow = part.receiveShadow = true;
          if (!Array.isArray(part.material)) part.material.metalness = Math.min(part.material.metalness, part.material.name === "roller" ? 0.55 : 0.2);
          if (!TRAVELS.test(name)) snowy(part.material);
        });
        templates.set(name, root);
        fromBlender.add(name);
      } catch {
        // Half written, or not there after all: the blocks stand in for it.
      }
    }),
  );
}
/** The sorting yard's equipment. Each is used if its model is there; the town is built from blocks without it. */
const EXTRAS = ["walker_a", "walker_b", "walker_dog", "machine_dish", "machine_chat", "machine_code", "machine_alarm", "works_clock", "works_dish", "works_chat", "works_code", "works_alarm", "agent_plaza", "plaza_column", "plaza_arch", "fine_hub", "hub_infill", "hub_pigeon", "parcel", "letter", "clock", "dome_hall", "workshop", "machine_press", "machine_tank", "machine_console", "machine_clock", "agent_claude", "agent_codex", "agent_bot", "pallet", "bench", "town_post", "town_house", "town_scooter", "town_lamp", "fence", "fine_hall", "fine_workshop", "fine_post", "fine_house", "fine_machine_press", "fine_machine_tank", "fine_machine_console", "fine_machine_clock", "fine_agent_claude", "fine_agent_codex", "fine_agent_bot", "fine_parcel", "fine_letter", "fine_clock", "fine_crate", "fine_pallet", "fine_bench", "fine_fence", "fine_town_scooter", "fine_town_lamp"];
/** `?plain` in the address leaves out the finely detailed remodels: to compare them with the earlier ones, or to go back. */
const PLAIN = new URLSearchParams(location.search).has("plain");
/** A copy of the first of these that has been modelled: a newer model stands in for the older one it replaces. */
const newest = (...names) => spawn(names.find((name) => templates.has(name)));
/** The finely detailed remodel of a model, when there is one. */
const finest = (name) => (templates.has(`fine_${name}`) ? `fine_${name}` : name);
/** Many copies of one model drawn together: each of its meshes once, at every place given. */
function scatter(root, name, places, pick) {
  if (!places.length) return;
  const template = templates.get(finest(name));
  template.updateMatrixWorld(true);
  template.traverse((part) => {
    if (!part.isMesh) return;
    const many = new THREE.InstancedMesh(part.geometry, part.material, places.length);
    places.forEach((where, index) => many.setMatrixAt(index, new THREE.Matrix4().multiplyMatrices(where, part.matrixWorld)));
    many.castShadow = many.receiveShadow = true;
    if (pick) ((many.userData.pick = pick), town.picks.push(many));
    root.add(many);
  });
}
// ------------------------------------------------------------------ townsfolk
// People out for a walk along the village's streets, now and then with a dog. Life in the scene only, like the birds:
// they carry nothing, and nothing they do stands for work.
const COATS = [0x4f93d8, 0xf0885a, 0x52b788, 0xeeb030, 0xe58aae, 0x7b6cf6, 0xe2605a, 0x5ec2c2, 0xf3d36b];
const TROUSERS = [0x3f4a5c, 0x5b4a3c, 0x6b7280, 0x2f3a4f];
/** How each limb swings with the stride (a share of the swing, and which way). */
const SWINGS = { leg_left: 1, leg_right: -1, arm_left: -0.8, arm_right: 0.8, leg_fl: 1, leg_br: 1, leg_fr: -1, leg_bl: -1 };
/**
 * The townsfolk along `ways` (each a straight walk: along x or along z, on one line, between two ends). Each kind of
 * figure is drawn as one batch per piece: the body, or a limb hanging from its pivot. `random` is the build's own.
 */
function folkOf(root, ways, random) {
  const kinds = ["walker_a", "walker_b"].filter((name) => templates.has(name));
  if (!kinds.length || !ways.length) return null;
  const count = Math.min(28, 6 + ways.length * 2);
  const people = Array.from({ length: count }, (_, index) => {
    const way = ways[Math.floor(random() * ways.length)];
    const dir = random() < 0.5 ? -1 : 1;
    return {
      model: kinds[index % kinds.length], way, dir, at: way.from + random() * (way.to - way.from), aside: dir * 0.55, pace: 1.05 + random() * 0.4,
      stride: random() * 6, rest: 0, walking: 1, turns: Math.floor(random() * 5), coat: COATS[Math.floor(random() * COATS.length)], legs: TROUSERS[Math.floor(random() * TROUSERS.length)],
      // Two in three go in for the night.
      late: index % 3 !== 0, place: new THREE.Vector3(), heading: 0, bob: 0,
    };
  });
  const dogs = templates.has("walker_dog") ? people.filter((_, index) => index % 5 === 2).map((owner) => ({ model: "walker_dog", owner, stride: 0, place: new THREE.Vector3(), heading: 0, bob: 0, walking: 1 })) : [];
  const batches = [];
  for (const name of [...kinds, ...(dogs.length ? ["walker_dog"] : [])]) {
    const who = name === "walker_dog" ? dogs : people.filter((person) => person.model === name);
    if (!who.length) continue;
    const template = templates.get(name);
    template.updateMatrixWorld(true);
    const top = template.getObjectByName(`${name}_root`) ?? template;
    template.traverse((part) => {
      if (!part.isMesh) return;
      let limb = part;
      while (limb.parent && limb.parent !== top && limb.parent !== template) limb = limb.parent;
      const paint = part.material.name;
      const material = ["coat", "trousers"].includes(paint) ? part.material.clone() : part.material;
      if (material !== part.material) material.color.setHex(0xffffff);
      const many = new THREE.InstancedMesh(part.geometry, material, who.length);
      many.castShadow = many.receiveShadow = true;
      many.frustumCulled = false;
      if (material !== part.material) who.forEach((each, index) => many.setColorAt(index, new THREE.Color(paint === "coat" ? (each.coat ?? 0xf0885a) : (each.legs ?? 0x3f4a5c))));
      root.add(many);
      batches.push({ many, who, swing: SWINGS[limb.name] ?? 0, pivot: limb.matrixWorld.clone(), inner: limb.matrixWorld.clone().invert().multiply(part.matrixWorld) });
    });
  }
  return { people, dogs, batches };
}
/** Walks the townsfolk on by `elapsed` seconds and sets every piece of every figure where it now is. */
const folkScratch = { base: new THREE.Matrix4(), swing: new THREE.Matrix4(), turn: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), one: new THREE.Vector3(1, 1, 1), hidden: new THREE.Matrix4().makeScale(0, 0, 0), at: new THREE.Vector3(), ahead: new THREE.Vector3() };
function stepFolk(folk, elapsed, night) {
  for (const person of folk.people) {
    const { way } = person;
    if (person.rest > 0) person.rest -= elapsed;
    else {
      person.at += person.dir * person.pace * elapsed;
      person.stride += person.pace * elapsed * 5.4;
      // At the end of the street they stop a moment, turn round and cross to the other side of it.
      if (person.at > way.to || person.at < way.from) {
        person.at = Math.min(way.to, Math.max(way.from, person.at));
        person.dir *= -1;
        person.rest = 0.8 + (person.turns++ % 4) * 0.9;
      }
    }
    person.walking += ((person.rest > 0 ? 0 : 1) - person.walking) * Math.min(1, elapsed * 6);
    person.aside += (person.dir * 0.55 - person.aside) * Math.min(1, elapsed * 1.5);
    const across = way.line + person.aside;
    person.place.set(way.long ? person.at : across, 0, way.long ? across : person.at);
    person.heading = way.long ? (person.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : person.dir > 0 ? 0 : Math.PI;
    person.bob = Math.abs(Math.sin(person.stride)) * 0.035 * person.walking;
  }
  for (const dog of folk.dogs) {
    const { owner } = dog;
    const ahead = folkScratch.ahead.set(Math.sin(owner.heading), 0, Math.cos(owner.heading));
    dog.place.copy(owner.place).addScaledVector(ahead, -0.9);
    dog.place.x += ahead.z * 0.55;
    dog.place.z -= ahead.x * 0.55;
    dog.heading = owner.heading;
    dog.walking = owner.walking;
    dog.stride += owner.pace * elapsed * 9 * owner.walking;
    dog.bob = Math.abs(Math.sin(dog.stride)) * 0.03 * dog.walking;
  }
  const { base, swing, turn, up, one, hidden, at } = folkScratch;
  for (const { many, who, swing: share, pivot, inner } of folk.batches) {
    who.forEach((each, index) => {
      if (night && (each.late ?? each.owner?.late)) return many.setMatrixAt(index, hidden);
      base.compose(at.copy(each.place).setY(each.bob), turn.setFromAxisAngle(up, each.heading), one).multiply(pivot);
      if (share) base.multiply(swing.makeRotationX(Math.sin(each.stride) * 0.5 * share * each.walking));
      many.setMatrixAt(index, base.multiply(inner));
    });
    many.instanceMatrix.needsUpdate = true;
  }
}
/** Where to put a model made to repeat every so far along one of its own axes, so a row of it fills a line exactly. */
function along(from, to, unit, axis) {
  const span = new THREE.Vector3().subVectors(to, from);
  const length = span.length();
  const count = Math.max(1, Math.round(length / unit));
  const stretch = length / (count * unit);
  const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), axis === "x" ? Math.atan2(-span.z, span.x) : Math.atan2(span.x, span.z));
  const scale = axis === "x" ? new THREE.Vector3(stretch, 1, 1) : new THREE.Vector3(1, 1, stretch);
  // One that starts at its origin goes at the start of each piece; one centred on it, at the middle.
  return Array.from({ length: count }, (_, index) => new THREE.Matrix4().compose(from.clone().addScaledVector(span, (index + (axis === "x" ? 0 : 0.5)) / count), facing, scale));
}
/** Materials one building changes on its own (lit windows, a raised flag) can't be shared with its neighbours. */
const OWN = new Set(["window", "beacon", "flag", "bulb", "crate", "body", "roof_station", "roof_blue", "lamp", "band", "envelope", "spark", "bot", "rose"]);
function spawn(name) {
  const copy = templates.get(finest(name)).clone(true);
  copy.traverse((part) => {
    if (!part.isMesh || Array.isArray(part.material) || !OWN.has(part.material.name)) return;
    const shared = part.material;
    part.material = shared.clone();
    // What a material was taught to do when it's drawn isn't copied along with it.
    if (shared.userData.snowy) snowy(part.material);
  });
  return copy;
}
function paints(root, name) {
  const found = [];
  root.traverse((part) => part.isMesh && !Array.isArray(part.material) && part.material.name === name && found.push(part.material));
  return found;
}
/** Kept to turn things by, so that nothing is made anew every frame. */
const twist = new THREE.Quaternion();
/** A direction given in a model's own frame, as the axis of one of its parts: what a named part turns about. */
function axisIn(part, root, direction) {
  const world = direction.clone().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
  return world.applyQuaternion(part.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
}

// ------------------------------------------------------------------ the town

let town = null;
let shape = "";

/** A road that leaves one place and arrives at another heading the same way: an S, never a kink. */
function bend(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const c1 = from.clone();
  const c2 = to.clone();
  if (Math.abs(dx) >= Math.abs(dz)) ((c1.x += dx / 2), (c2.x -= dx / 2));
  else ((c1.z += dz / 2), (c2.z -= dz / 2));
  return new THREE.CubicBezierCurve3(from, c1, c2, to);
}

function ribbon(curve, width, y) {
  const count = Math.max(8, Math.ceil(curve.getLength() / 2));
  const positions = [];
  const uvs = [];
  const index = [];
  for (let i = 0; i <= count; i++) {
    const at = curve.getPointAt(i / count);
    const heading = curve.getTangentAt(i / count);
    const side = new THREE.Vector3(-heading.z, 0, heading.x).normalize().multiplyScalar(width / 2);
    positions.push(at.x + side.x, y, at.z + side.z, at.x - side.x, y, at.z - side.z);
    const along = (curve.getLength() * i) / count / 7;
    uvs.push(0, along, width / 7, along);
    if (i) index.push(i * 2 - 2, i * 2, i * 2 - 1, i * 2 - 1, i * 2, i * 2 + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
function dashes(curve, y) {
  const length = curve.getLength();
  const positions = [];
  const index = [];
  for (let at = 3; at < length - 3; at += 5.5) {
    const a = curve.getPointAt(at / length);
    const b = curve.getPointAt(Math.min(1, (at + 2.2) / length));
    const side = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar(0.13);
    const base = positions.length / 3;
    positions.push(a.x + side.x, y, a.z + side.z, a.x - side.x, y, a.z - side.z, b.x + side.x, y, b.z + side.z, b.x - side.x, y, b.z - side.z);
    index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** How high the land is: level where the town stands, rolling up into hills beyond it. */
function heightAt(x, z, flat) {
  const rise = THREE.MathUtils.smoothstep(Math.hypot(x * 0.92, z), flat, flat + 320);
  if (rise === 0) return 0;
  const rolling = Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 - 0.7) * 0.5 + Math.sin(x * 0.027 + z * 0.019) * 0.25 + Math.sin(z * 0.041 - x * 0.008 + 2.1) * 0.12 + 0.62;
  return rise * rise * rolling * 68;
}
/** A flat patch of ground whose texture is laid out in world space, so paving runs on from one patch to the next. */
function patch(x, z, radius, material, y = 0.03, stretch = 1) {
  const geometry = new THREE.CircleGeometry(radius, 56);
  geometry.rotateX(-Math.PI / 2);
  geometry.scale(stretch, 1, 1);
  geometry.translate(x, y, z);
  const { position, uv } = geometry.attributes;
  for (let i = 0; i < position.count; i++) uv.setXY(i, position.getX(i) / 9, position.getZ(i) / 9);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ parts made here: paving, belts, trees, small things

const DECK = 0.9; // the height everything on a belt or on the hall's carousel rides at
// How the works are laid out: as a village of plots along streets, or as the yards in a row that came before it.
const VILLAGE = !new URLSearchParams(location.search).has("yards");
const DEPTH_OF_PLOT = 15; // how far back from its street a village plot goes
// From where an Agent is watched at its work, and what of it is looked at: both as steps from where it stands.
const WATCH = { eye: [-17, 10, 29], at: [-5.5, 3.6, 0.5] };
/**
 * What kind of work a line is, by where its events come from: on a timer, alerts, a code repository, messages people
 * send, or (anything else) an outside service calling in. Each kind has a building of its own on its plot.
 */
function trade(line, sources) {
  if (line.source === "schedule" || line.every) return "clock";
  const source = sources?.find((each) => each.id === line.source);
  const words = [line.source, source?.name, ...(line.types ?? [])].join(" ").toLowerCase();
  if (/alert|alarm|incident|monitor|pager|sentry|grafana|prometheus|uptime|\bops\b|告警|报警|监控|运维/.test(words)) return "alarm";
  if (/github|gitlab|gitea|bitbucket|\bgit\b|repo|issues?\.|pull_request|merge_request|release\.|仓库|代码/.test(words)) return "code";
  if (/local|town|feishu|lark|weixin|wechat|slack|telegram|discord|dingtalk|chat|message|\bim\b|task\.|本机|飞书|微信|钉钉|聊天|消息|对话/.test(words)) return "chat";
  return "dish";
}
/** The building each kind of line has on its plot, where it has been modelled. */
const BUILDINGS = { clock: "works_clock", dish: "works_dish", chat: "works_chat", code: "works_code", alarm: "works_alarm" };
const SOURCE_TINTS = [0x4f93d8, 0xf0885a, 0x52b788, 0xeeb030, 0xe58aae, 0x7b6cf6, 0x3f9f5a, 0xe2605a];
const AGENT_TINTS = { claude: 0xd97757, codex: 0x7c6ff5 };
const TONE = { good: 0x34a853, warn: 0xf5a524, crit: 0xdc4c43, idle: 0xaab2bb, card: 0xd6b17c, paper: 0xfdfbf5 };
const tints = new Map();
function tint(hex, roughness = 0.8) {
  const key = `${hex}:${roughness}`;
  if (!tints.has(key)) tints.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness }));
  return tints.get(key);
}
function block(material, w, h, d, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
function drum(material, top, bottom, h, x = 0, y = 0, z = 0, sides = 28) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, h, sides), material);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
function ball(material, radius, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 18, 12), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}
/** A lamp that can be lit on its own: steady while something holds, bright for a moment when something happens. */
function lampOf(radius = 0.3) {
  return ball(new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.4, emissive: 0x000000 }), radius);
}
// Round plazas are laid in rings of stone; the pads the machines stand on, in square tiles; paths are trodden earth.
/** A drawing of how proud of the ground each spot stands, for the light to catch on: white is high. */
function relief(size, draw) {
  const texture = drawn(size, (pen, across) => {
    pen.filter = "blur(1.2px)";
    draw(pen, across);
  });
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}
const grey = (level) => `rgb(${level}, ${level}, ${level})`;
/** Rings of stone round a middle, each stone a shade of its own: drawn once for its colour and once for its height. */
function stoneRings(pen, size, between, shadeOf) {
  const centre = size / 2;
  const random = seeded(77);
  pen.fillStyle = between;
  pen.fillRect(0, 0, size, size);
  const rings = 13;
  const step = centre / rings;
  for (let ring = 0; ring < rings; ring++) {
    const inner = ring * step;
    const stones = Math.max(6, Math.round((2 * Math.PI * (inner + step / 2)) / (step * 1.5)));
    const turn = random() * Math.PI;
    for (let stone = 0; stone < stones; stone++) {
      const from = turn + (stone / stones) * Math.PI * 2 + 0.014;
      const to = turn + ((stone + 1) / stones) * Math.PI * 2 - 0.014;
      pen.fillStyle = shadeOf(random());
      pen.beginPath();
      pen.arc(centre, centre, inner + step - 1.6, from, to);
      pen.arc(centre, centre, inner + 1.6, to, from, true);
      pen.closePath();
      pen.fill();
    }
  }
}
const radialMap = drawn(1024, (pen, size) =>
  stoneRings(pen, size, "#c2baab", (roll) => {
    const shade = 224 + Math.floor(roll * 22);
    return `rgb(${shade}, ${shade - 4}, ${shade - 13})`;
  }),
);
const radialRelief = relief(1024, (pen, size) => stoneRings(pen, size, grey(70), (roll) => grey(205 + Math.floor(roll * 50))));
for (const map of [radialMap, radialRelief]) map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
/** Square tiles, six by six, each a shade of its own. */
function squareTiles(pen, size, between, shadeOf) {
  const random = seeded(31);
  const tile = size / 6;
  pen.fillStyle = between;
  pen.fillRect(0, 0, size, size);
  for (let row = 0; row < 6; row++)
    for (let column = 0; column < 6; column++) {
      pen.fillStyle = shadeOf(random(), (row + column) % 2);
      pen.beginPath();
      pen.roundRect(column * tile + 2, row * tile + 2, tile - 4, tile - 4, 5);
      pen.fill();
    }
}
const tileMap = drawn(512, (pen, size) =>
  squareTiles(pen, size, "#cbc4b6", (roll, odd) => {
    const shade = 232 + Math.floor(roll * 16) - odd * 9;
    return `rgb(${shade}, ${shade - 3}, ${shade - 11})`;
  }),
);
const tileRelief = relief(512, (pen, size) => squareTiles(pen, size, grey(60), (roll) => grey(215 + Math.floor(roll * 40))));
/** The same tiles in warm sandstone, with pale joints. */
const sandstoneMap = drawn(512, (pen, size) =>
  squareTiles(pen, size, "#f2e5cf", (roll, odd) => {
    const shade = 238 + Math.floor(roll * 12) - odd * 8;
    return `rgb(${shade}, ${shade - 32}, ${shade - 70})`;
  }),
);
const beltMap = drawn(64, (pen, size) => {
  pen.fillStyle = "#4c4766";
  pen.fillRect(0, 0, size, size);
  pen.strokeStyle = "#625d80";
  pen.lineWidth = 5;
  for (const y of [6, 38]) (pen.beginPath(), pen.moveTo(8, y + 14), pen.lineTo(size / 2, y), pen.lineTo(size - 8, y + 14), pen.stroke());
});
const slimBeltMap = drawn(64, (pen, size) => {
  pen.fillStyle = "#3f434c";
  pen.fillRect(0, 0, size, size);
  pen.strokeStyle = "#565b66";
  pen.lineWidth = 4;
  for (const y of [6, 38]) (pen.beginPath(), pen.moveTo(10, y + 12), pen.lineTo(size / 2, y), pen.lineTo(size - 10, y + 12), pen.stroke());
});
const poolMap = drawn(128, (pen, size) => {
  const fade = pen.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  fade.addColorStop(0, "rgba(255, 226, 160, 1)");
  fade.addColorStop(0.45, "rgba(255, 214, 140, 0.55)");
  fade.addColorStop(1, "rgba(255, 205, 120, 0)");
  pen.fillStyle = fade;
  pen.fillRect(0, 0, size, size);
});
const floor = {
  radial: new THREE.MeshStandardMaterial({ map: radialMap, bumpMap: radialRelief, bumpScale: 2.2, roughness: 0.92 }),
  tiles: new THREE.MeshStandardMaterial({ map: tileMap, bumpMap: tileRelief, bumpScale: 2.2, roughness: 0.9 }),
  warm: new THREE.MeshStandardMaterial({ map: sandstoneMap, bumpMap: tileRelief, bumpScale: 2.2, roughness: 0.9 }),
  path: new THREE.MeshStandardMaterial({ map: drawn(256, (pen, size) => void speckle(pen, size, "#dccfae", ["#d2c4a0", "#e6dabb", "#cbbd98"], 2600, 3)), roughness: 1, side: THREE.DoubleSide }),
  edge: new THREE.MeshStandardMaterial({ color: 0xcfc8ba, roughness: 0.9 }),
  bed: new THREE.MeshStandardMaterial({ color: 0x6f6a8c, roughness: 0.7 }),
  rail: new THREE.MeshStandardMaterial({ color: 0xc98f62, roughness: 0.65 }),
  trim: new THREE.MeshStandardMaterial({ color: 0xf1e8d4, roughness: 0.6 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6 }),
  // The light a street lamp throws on the ground at night: laid flat under each, and faded with the hour.
  pool: new THREE.MeshBasicMaterial({ map: poolMap, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
  water: new THREE.MeshStandardMaterial({ color: 0x5aa7c9, roughness: 0.08, metalness: 0.2 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xe3d7b8, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }),
  // Whatever is set out in numbers takes its colour piece by piece, and the hour's cast from this.
  prop: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xfff3d0, roughness: 0.4, emissive: 0xffd98a, emissiveIntensity: 0 }),
  bark: new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 1 }),
  // Bare limbs take their colour tree by tree, and whiten under snow.
  twig: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  // Barely there: the hall's dome reads as its ribs, and what goes on under it is seen as clearly as what is outside.
  glass: new THREE.MeshPhysicalMaterial({ color: 0xeaf6fc, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }),
};
// ------------------------------------------------------------------ the fine grain: wind, turf, leaves, water

/** Changes how a material is drawn, once, when its program is first made. */
function reworked(material, key, change) {
  material.onBeforeCompile = change;
  material.customProgramCacheKey = () => key;
  return material;
}
/** Adds to a program after one of the pieces it is put together from, or puts something in that piece's place. */
function graft(source, chunk, extra, keep = true) {
  const mark = `#include <${chunk}>`;
  if (!source.includes(mark)) console.warn(`the program has no ${chunk} to graft on`);
  return source.replace(mark, keep ? `${mark}\n${extra}` : extra);
}
/** A colour as the programs want it written. */
const lin = (hex) => {
  const colour = new THREE.Color(hex);
  return `vec3(${colour.r.toFixed(4)}, ${colour.g.toFixed(4)}, ${colour.b.toFixed(4)})`;
};

// One wind blows over the whole town, in waves that cross it. Whatever grows carries, vertex by vertex, how far it
// gives way: nothing at the foot, most at the top. Its shadow, and the soft shade where it meets things, blow with it.
const wind = { time: { value: 0 }, gust: { value: 1 } };
const GUSTS = { clear: 1, cloudy: 1.15, overcast: 1.2, fog: 0.45, drizzle: 1.3, rain: 1.7, snow: 0.7, storm: 2.6 };
const WIND_PARS = `
  attribute float sway;
  uniform float uWind;
  uniform float uGust;
  #ifndef SWAY_BY
    #define SWAY_BY 1.0
  #endif`;
const WIND_MOVE = `
  if (sway > 0.0) {
    #ifdef USE_INSTANCING
      mat4 placed = modelMatrix * instanceMatrix;
    #else
      mat4 placed = modelMatrix;
    #endif
    float reached = dot(placed[3].xz, vec2(0.105, 0.062));
    float gust = sin(uWind * 1.15 - reached) * 0.55 + sin(uWind * 0.43 - reached * 0.37 + 1.7) * 0.45 + sin(uWind * 2.9 - reached * 2.3 + transformed.y * 0.8) * 0.22;
    transformed += inverse(mat3(placed)) * (vec3(0.83, 0.0, 0.56) * ((0.35 + gust) * sway * uGust * SWAY_BY));
  }`;
function blow(shader) {
  shader.uniforms.uWind = wind.time;
  shader.uniforms.uGust = wind.gust;
  shader.vertexShader = graft(graft(shader.vertexShader, "common", WIND_PARS), "begin_vertex", WIND_MOVE);
}
/** Makes something that grows give way to the wind: `give` says how far, in the town's own units, at each height. */
function limber(geometry, give) {
  const { position } = geometry.attributes;
  const sway = Array.from({ length: position.count }, (_, index) => Math.max(0, give(position.getY(index))));
  geometry.setAttribute("sway", new THREE.Float32BufferAttribute(sway, 1));
  return geometry;
}
const windDepth = reworked(new THREE.MeshDepthMaterial(), "depth-blown", blow);
if (contact) reworked(contact.normalMaterial, "normal-blown", blow);

const NOISE = `
  float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float vnoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 part = fract(p);
    part = part * part * (3.0 - 2.0 * part);
    return mix(mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), part.x), mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0, 1.0)), part.x), part.y);
  }`;
// The colour of the turf is worked out where it's drawn, so it has no grain of its own to show however near one looks.
const TURF = `${NOISE}
  vec3 turf(vec2 at, float grain) {
    float broad = vnoise(at * 0.021 + 3.7) * 0.6 + vnoise(at * 0.083 + 11.3) * 0.4;
    float clump = vnoise(at * 0.41 + 1.9);
    vec3 colour = mix(${lin(0x7fa95c)}, ${lin(0xa3c173)}, smoothstep(0.3, 0.75, broad));
    colour = mix(colour, ${lin(0x6c9a55)}, smoothstep(0.58, 0.92, clump) * 0.45);
    float lie = 0.96 + 0.1 * sin(at.x * 0.023 + 0.8) * cos(at.y * 0.019 - 1.9) + 0.06 * sin((at.x + at.y) * 0.057);
    return colour * lie * (0.9 + 0.2 * grain);
  }`;
reworked(ground.grass, "turf", (shader) => {
  shader.vertexShader = graft(graft(shader.vertexShader, "common", "varying vec2 vTurfAt;"), "begin_vertex", "vTurfAt = (modelMatrix * vec4(transformed, 1.0)).xz;");
  shader.fragmentShader = graft(
    graft(shader.fragmentShader, "common", `varying vec2 vTurfAt;${TURF}`),
    "map_fragment",
    `float perPixel = max(fwidth(vTurfAt.x), fwidth(vTurfAt.y));
    float grain = mix(vnoise(vTurfAt * 2.3), 0.5, smoothstep(0.1, 0.3, perPixel)) * 0.55 + mix(vnoise(vTurfAt * 8.5), 0.5, smoothstep(0.025, 0.08, perPixel)) * 0.45;
    diffuseColor.rgb *= turf(vTurfAt, grain);`,
  );
});

// Leaves are dappled, and from near to, flecked: no crown is one flat green.
reworked(floor.leaf, "leaf", (shader) => {
  blow(shader);
  shader.vertexShader = graft(
    graft(shader.vertexShader, "common", "varying vec3 vLeafAt;"),
    "project_vertex",
    `#ifdef USE_INSTANCING
      vLeafAt = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
    #else
      vLeafAt = (modelMatrix * vec4(position, 1.0)).xyz;
    #endif`,
  );
  shader.fragmentShader = graft(
    graft(shader.fragmentShader, "common", `varying vec3 vLeafAt;${NOISE}`),
    "map_fragment",
    `float perLeaf = max(fwidth(vLeafAt.x), max(fwidth(vLeafAt.y), fwidth(vLeafAt.z)));
    vec2 oneWay = vLeafAt.xz + vLeafAt.y * vec2(0.37, 0.61);
    vec2 otherWay = vLeafAt.xy * vec2(1.0, 1.3) + vLeafAt.z * vec2(0.53, 0.29);
    float dapple = mix(vnoise(oneWay * 1.1) * vnoise(otherWay * 1.1 + 4.0) * 2.0, 0.5, smoothstep(0.25, 0.7, perLeaf));
    float fleck = mix(vnoise(oneWay * 4.7) * vnoise(otherWay * 4.7 + 7.1) * 2.0, 0.5, smoothstep(0.045, 0.15, perLeaf));
    diffuseColor.rgb *= 0.73 + 0.28 * dapple + 0.32 * fleck;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.06, 0.74), smoothstep(0.55, 1.0, fleck) * 0.4);`,
  );
});
floor.bloom = reworked(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), "bloom", blow);

// Grass stands in tufts wherever the turf is bare of anything else. A tuft is five blades leaning out from one root;
// they take the colour of the turf under them, darker at the root and lighter at the tip, and shrink to nothing far off.
const blades = { on: true, snow: { value: 0 }, reach: { value: new THREE.Vector2(130, 185) } };
const TUFT = (() => {
  const random = seeded(5);
  const positions = [];
  const lifts = [];
  const sways = [];
  const index = [];
  for (let blade = 0; blade < 5; blade++) {
    const turn = (blade / 5) * Math.PI * 2 + random() * 0.9;
    const out = 0.03 + random() * 0.13;
    const tall = 0.26 + random() * 0.26;
    const lean = 0.05 + random() * 0.16;
    const wide = 0.05 + random() * 0.025;
    const facing = turn + Math.PI / 2 + (random() - 0.5) * 1.2;
    const first = positions.length / 3;
    for (const [up, half] of [[0, wide], [0.5, wide * 0.72], [1, 0]]) {
      const reach = out + lean * up * up;
      for (const side of half ? [-1, 1] : [0]) {
        positions.push(Math.cos(turn) * reach + Math.cos(facing) * half * side, tall * up, Math.sin(turn) * reach + Math.sin(facing) * half * side);
        lifts.push(up);
        sways.push(tall * 0.42 * up * up);
      }
    }
    index.push(first, first + 1, first + 2, first + 1, first + 3, first + 2, first + 2, first + 3, first + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(lifts.flatMap(() => [0, 1, 0]), 3));
  geometry.setAttribute("lift", new THREE.Float32BufferAttribute(lifts, 1));
  geometry.setAttribute("sway", new THREE.Float32BufferAttribute(sways, 1));
  geometry.setIndex(index);
  return geometry;
})();
const bladeMaterial = reworked(new THREE.MeshStandardMaterial({ roughness: 0.92, side: THREE.DoubleSide }), "blade", (shader) => {
  blow(shader);
  shader.uniforms.uSnow = blades.snow;
  shader.uniforms.uReach = blades.reach;
  shader.vertexShader = graft(
    graft(shader.vertexShader, "common", "#define SWAY_BY thin\nattribute float lift;\nuniform float uSnow;\nuniform vec2 uReach;\nvarying float vLift;\nvarying vec2 vTurfAt;"),
    "begin_vertex",
    `vec3 stood = (modelMatrix * instanceMatrix)[3].xyz;
    float thin = (1.0 - smoothstep(uReach.x, uReach.y, distance(cameraPosition, stood))) * (1.0 - 0.45 * uSnow);
    transformed *= thin;
    vLift = lift;
    vTurfAt = stood.xz;`,
  );
  shader.fragmentShader = graft(
    graft(
      graft(shader.fragmentShader, "common", `uniform float uSnow;\nvarying float vLift;\nvarying vec2 vTurfAt;${TURF}`),
      "map_fragment",
      `vec3 blade = turf(vTurfAt, 0.5) * mix(0.66, 1.2, vLift);
      blade = mix(blade, blade * vec3(1.1, 1.06, 0.8), vLift * 0.6);
      diffuseColor.rgb *= mix(blade, vec3(0.95, 0.97, 1.0), uSnow * (0.3 + 0.65 * vLift));`,
    ),
    "normal_fragment_begin",
    // Lit as the ground under it is, whichever way a blade happens to face.
    "normal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));",
  );
});

// The pond: a bed that shelves from sand through the shallows into the deep, with light playing on it, under a thin
// surface that laps at the sand, glints, and shows what swims beneath.
const pondLook = { ice: { value: 0 }, chop: { value: 1 }, sun: { value: 1 }, snow: { value: 0 } };
const POND_PARS = "attribute float shore;\nvarying float vShore;\nvarying vec2 vPondAt;";
const POND_MOVE = "vShore = shore;\nvPondAt = (modelMatrix * vec4(transformed, 1.0)).xz;";
const pondUniforms = (shader) => Object.assign(shader.uniforms, { uWind: wind.time, uIce: pondLook.ice, uChop: pondLook.chop, uSun: pondLook.sun, uSnow: pondLook.snow });
const POND_SEES = `varying float vShore;\nvarying vec2 vPondAt;\nuniform float uWind;\nuniform float uIce;\nuniform float uChop;\nuniform float uSun;\nuniform float uSnow;${NOISE}`;
reworked(floor.sand, "pond-bed", (shader) => {
  pondUniforms(shader);
  shader.vertexShader = graft(graft(shader.vertexShader, "common", POND_PARS), "begin_vertex", POND_MOVE);
  shader.fragmentShader = graft(
    graft(shader.fragmentShader, "common", POND_SEES),
    "map_fragment",
    `vec3 bed = mix(${lin(0xe8dcb8)}, ${lin(0xcbbd96)}, smoothstep(-0.035, 0.0, vShore));
    bed = mix(bed, ${lin(0x8fd8c8)}, smoothstep(0.0, 0.09, vShore));
    bed = mix(bed, ${lin(0x44a3ba)}, smoothstep(0.07, 0.36, vShore));
    bed = mix(bed, ${lin(0x2c719b)}, smoothstep(0.3, 0.8, vShore));
    float under = smoothstep(0.0, 0.08, vShore);
    float webA = vnoise(vPondAt * 1.5 + uWind * vec2(0.33, 0.2));
    float webB = vnoise(vPondAt * 2.6 - uWind * vec2(0.26, 0.3) + 5.2);
    float web = smoothstep(0.6, 1.0, 1.0 - abs(webA + webB - 1.0) * 2.6);
    bed *= 1.0 + web * 0.45 * under * uSun * (1.0 - uIce);
    bed = mix(bed, vec3(0.95, 0.97, 1.0), uSnow * (1.0 - under) * 0.85);
    diffuseColor.rgb *= bed;`,
  );
});
floor.water.transparent = true;
reworked(floor.water, "pond-top", (shader) => {
  pondUniforms(shader);
  shader.vertexShader = graft(graft(shader.vertexShader, "common", POND_PARS), "begin_vertex", POND_MOVE);
  shader.fragmentShader = graft(
    graft(
      graft(
        graft(shader.fragmentShader, "common", POND_SEES),
        "map_fragment",
        `float live = 1.0 - uIce;
        float lapping = vShore - 0.012 * sin(uWind * 1.4 + vPondAt.x * 1.7 + vPondAt.y * 1.1) - 0.02 * vnoise(vPondAt * 2.2 + uWind * 0.25);
        float foam = (1.0 - smoothstep(0.03, 0.08, lapping)) * live;
        float perWater = max(fwidth(vPondAt.x), fwidth(vPondAt.y));
        float nearBy = vnoise(vPondAt * 12.0 + uWind * vec2(1.1, 0.6)) * vnoise(vPondAt * 16.5 - uWind * vec2(0.8, 1.3));
        float farOff = vnoise(vPondAt * 3.6 + uWind * vec2(0.55, 0.3)) * vnoise(vPondAt * 4.9 - uWind * vec2(0.4, 0.65));
        // They come in drifting patches, the way light lies on water, not all over it.
        float lit = smoothstep(0.42, 0.72, vnoise(vPondAt * 0.3 + uWind * vec2(0.05, 0.03)) * 0.65 + vnoise(vPondAt * 0.9 - uWind * 0.04) * 0.35);
        float glint = mix(smoothstep(0.6, 0.68, nearBy), smoothstep(0.6, 0.69, farOff), smoothstep(0.03, 0.075, perWater)) * lit * uSun * live;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), foam * 0.85);
        diffuseColor.a = mix(mix(0.26, 0.5, smoothstep(0.0, 0.6, vShore)), 0.92, max(foam * 0.9, uIce));
        diffuseColor.a *= smoothstep(0.0, 0.025, vShore);
        totalEmissiveRadiance += vec3(1.0, 0.98, 0.92) * glint * 1.5;`,
      ),
      "normal_fragment_maps",
      `vec2 lap = vec2(0.8, 0.6) * cos(dot(vPondAt, vec2(0.8, 0.6)) * 2.1 + uWind * 1.3)
        + vec2(-0.5, 0.86) * cos(dot(vPondAt, vec2(-0.5, 0.86)) * 3.3 - uWind * 1.7) * 0.7
        + vec2(0.2, -0.98) * cos(dot(vPondAt, vec2(0.2, -0.98)) * 5.9 + uWind * 2.4) * 0.45
        + vec2(-0.93, -0.36) * cos(dot(vPondAt, vec2(-0.93, -0.36)) * 9.7 - uWind * 3.1) * 0.3;
      lap *= 0.07 * uChop * live;
      normal = normalize(mat3(viewMatrix) * normalize(vec3(-lap.x, 1.0, -lap.y)));`,
    ),
    "opaque_fragment",
    // What the surface throws back hides what's under it: the sky's sheen and the glints are not seen through.
    `diffuseColor.a = clamp(diffuseColor.a + max(max(totalSpecular.r, totalSpecular.g), totalSpecular.b) * 0.9 + glint, 0.0, 1.0) * smoothstep(0.0, 0.025, vShore);
    #include <opaque_fragment>`,
    false,
  );
});
/** A pond's shape as a fan from its middle out to the shore, or a little past it: every vertex knows how far in it lies. */
function pondFan(outline, rings, reach) {
  const positions = [0, 0, 0];
  const shore = [1];
  const index = [];
  const count = outline.length;
  for (let ring = 1; ring <= rings; ring++) {
    const out = reach * (1 - (1 - ring / rings) ** 2); // the rings crowd toward the shore, where the most happens
    for (const point of outline) (positions.push(point.x * out, 0, -point.y * out), shore.push(1 - out));
  }
  for (let each = 0; each < count; each++) {
    const next = (each + 1) % count;
    index.push(0, 1 + each, 1 + next);
    for (let ring = 1; ring < rings; ring++) {
      const [inner, outer] = [1 + (ring - 1) * count, 1 + ring * count];
      index.push(inner + each, outer + each, outer + next, inner + each, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(shore.flatMap(() => [0, 1, 0]), 3));
  geometry.setAttribute("shore", new THREE.Float32BufferAttribute(shore, 1));
  geometry.setIndex(index);
  return geometry;
}
/** Whether a spot lies inside an outline. */
function insideOf(outline, x, y) {
  let inside = false;
  for (let each = 0, last = outline.length - 1; each < outline.length; last = each++) {
    const [a, b] = [outline[each], outline[last]];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Snow settles on whatever faces the sky: roofs, ledges, the tops of machines, benches and fences. Not on what
// travels, and not on paving, which is kept swept.
const TRAVELS = /^(fine_)?(parcel|letter|clock|agent_\w+|town_scooter|scooter|truck|van)$/;
function snowy(material) {
  if (Array.isArray(material) || !material.isMeshStandardMaterial) return material;
  material.userData.snowy = true;
  return reworked(material, "snowy", (shader) => {
    shader.uniforms.uSnow = blades.snow;
    shader.fragmentShader = graft(
      graft(shader.fragmentShader, "common", "uniform float uSnow;"),
      "normal_fragment_maps",
      `float settled = uSnow * smoothstep(0.42, 0.8, inverseTransformDirection(normal, viewMatrix).y);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 1.0), settled * 0.8);
      roughnessFactor = mix(roughnessFactor, 0.95, settled);
      metalnessFactor *= 1.0 - settled;`,
    );
  });
}
for (const material of [floor.prop, floor.rail, floor.trim, floor.frame, floor.edge]) snowy(material);
/** A plain colour for something built here that stands out of doors, so snow settles on it too. */
const capped = (hex) => tints.get(`capped:${hex}`) ?? tints.set(`capped:${hex}`, snowy(new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 }))).get(`capped:${hex}`);

// Paint on the works' floors: a striped frame round every machine, a walkway down each works, a number at each bay.
const hazardMap = drawn(64, (pen, size) => {
  pen.fillStyle = "#f0c12e";
  pen.fillRect(0, 0, size, size);
  pen.strokeStyle = "#3b3e46";
  pen.lineWidth = size * 0.36;
  for (const shift of [-1, 0, 1]) (pen.beginPath(), pen.moveTo(shift * size - 8, size + 8), pen.lineTo((shift + 1) * size + 8, -8), pen.stroke());
});
const onFloor = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
floor.hazard = new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.8, ...onFloor });
floor.lane = new THREE.MeshStandardMaterial({ color: 0x6aa98c, roughness: 0.85, transparent: true, opacity: 0.5, depthWrite: false, ...onFloor });
floor.line = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, ...onFloor });
const numerals = new Map();
/** What a bay's number is painted with: made once for each number, however often the town is rebuilt. */
function numeral(words) {
  if (!numerals.has(words)) {
    const map = drawn(128, (pen, size) => {
      pen.font = `700 ${size * 0.62}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
      pen.textAlign = "center";
      pen.textBaseline = "middle";
      pen.fillStyle = "#5d6b82";
      pen.fillText(words, size / 2, size * 0.54);
    });
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    numerals.set(words, new THREE.MeshStandardMaterial({ map, roughness: 0.85, transparent: true, opacity: 0.8, depthWrite: false, ...onFloor }));
  }
  return numerals.get(words);
}

// The shade of clouds going over, on fair days. No cloud is ever seen from up here: only where its shadow falls.
const clouds = { cover: { value: 0.6 }, dark: { value: 0 }, middle: { value: new THREE.Vector2() } };
const cloudShade = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uWind: wind.time, uCover: clouds.cover, uDark: clouds.dark, uMiddle: clouds.middle },
    vertexShader: "varying vec2 vAt; void main() { vec4 placed = modelMatrix * vec4(position, 1.0); vAt = placed.xz; gl_Position = projectionMatrix * viewMatrix * placed; }",
    fragmentShader: `varying vec2 vAt; uniform float uWind; uniform float uCover; uniform float uDark; uniform vec2 uMiddle;${NOISE}
      void main() {
        vec2 drifted = vAt - uWind * vec2(2.4, 1.6);
        float cover = vnoise(drifted * 0.011) * 0.62 + vnoise(drifted * 0.029 + 7.0) * 0.38;
        float shade = smoothstep(uCover, uCover + 0.2, cover) * (1.0 - smoothstep(170.0, 330.0, distance(vAt, uMiddle)));
        gl_FragColor = vec4(0.04, 0.07, 0.15, shade * uDark);
      }`,
  }),
);
cloudShade.position.y = 13;
cloudShade.userData.flat = true;
cloudShade.renderOrder = 1;
scene.add(cloudShade);

// What's alive in it and stands for nothing: birds wheeling over by day, butterflies at the flowers, fireflies after dark.
const flat = (points) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  geometry.setIndex(points.slice(2).flatMap((_, index) => [0, index + 1, index + 2]));
  geometry.computeVertexNormals();
  return geometry;
};
const WING = flat([[0, 0, 0.28], [0.5, 0, 0.2], [1.05, 0, -0.08], [0.5, 0, -0.3], [0, 0, -0.26]]);
const BIRD = new THREE.ConeGeometry(0.13, 0.9, 6).rotateX(Math.PI / 2);
const PETAL = flat([[0, 0, 0.14], [0.26, 0, 0.24], [0.36, 0, 0.03], [0.24, 0, -0.19], [0, 0, -0.12]]);
const feather = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
const pose = new THREE.Object3D();

/** A round plaza of ring paving. */
function plaza(x, z, radius, y = 0.05) {
  town?.paved.push([x, z, radius]);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 72), floor.radial);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  return mesh;
}
/** A flat rectangle of ground whose pattern is laid out in world space. */
function slab(x0, z0, x1, z1, material, y = 0.05, per = 9) {
  const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const { position, uv } = geometry.attributes;
  for (let i = 0; i < position.count; i++) uv.setXY(i, position.getX(i) / per, position.getZ(i) / per);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}
/** Points along a curve with the way across it at each: what anything laid along the curve is built from. */
function across(curve, every = 1.2) {
  const count = Math.max(6, Math.ceil(curve.getLength() / every));
  const points = Array.from({ length: count + 1 }, (_, index) => curve.getPointAt(Math.min(0.9999, index / count)));
  return points.map((point, index) => {
    const ahead = points[Math.min(count, index + 1)].clone().sub(points[Math.max(0, index - 1)]).setY(0).normalize();
    return { point, side: new THREE.Vector3(-ahead.z, 0, ahead.x), far: (curve.getLength() * index) / count };
  });
}
/** A strip following a curve: flat at one height between two offsets, or upright at one offset between two heights. */
function strip(rows, [a, ya], [b, yb], per = 1.3) {
  const positions = [];
  const uvs = [];
  const index = [];
  rows.forEach(({ point, side, far }, i) => {
    positions.push(point.x + side.x * a, ya, point.z + side.z * a, point.x + side.x * b, yb, point.z + side.z * b);
    uvs.push(0, far / per, 1, far / per);
    if (i) index.push(i * 2 - 2, i * 2, i * 2 - 1, i * 2 - 1, i * 2, i * 2 + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
/**
 * A way through some points: straight from one to the next and rounded where it turns, by as much as `radius` says (one
 * for all, or one for each point). Two ways through the same turn with the same radius run together there.
 */
function route(points, radius = 1.6) {
  const way = new THREE.CurvePath();
  let from = points[0];
  for (let index = 1; index < points.length - 1; index++) {
    const corner = points[index];
    const before = corner.clone().sub(from);
    const after = points[index + 1].clone().sub(corner);
    const round = Math.min(Array.isArray(radius) ? radius[index] : radius, before.length() / 2, after.length() / 2);
    // Straight on: nothing to round.
    if (before.clone().normalize().dot(after.clone().normalize()) > 0.9995) continue;
    const [a, b] = [corner.clone().addScaledVector(before.normalize(), -round), corner.clone().addScaledVector(after.normalize(), round)];
    if (a.distanceTo(from) > 0.01) way.add(new THREE.LineCurve3(from, a));
    way.add(new THREE.QuadraticBezierCurve3(a, corner, b));
    from = b;
  }
  way.add(new THREE.LineCurve3(from, points.at(-1)));
  return way;
}
/** How far along a curve the place nearest to a point is. */
function farOf(curve, point) {
  const length = curve.getLength();
  const count = Math.max(8, Math.ceil(length / 0.05));
  let [best, far] = [Infinity, 0];
  for (let index = 0; index <= count; index++) {
    const gap = curve.getPointAt(Math.min(0.9999, index / count)).distanceToSquared(point);
    if (gap < best) [best, far] = [gap, (length * index) / count];
  }
  return far;
}
/**
 * A conveyor along a curve, and a belt that only moves while it carries something. The plain one is a low bed with a
 * rail each side; `slim` is a thin deck on posts with a low lip, as the village has. `half` is half the belt's width.
 * `gaps` are openings in a rail for another belt to come in by: [how far along, which side (1 or -1), half as wide].
 */
function beltOf(curve, { half = 0.66, slim = false, rail: trim = floor.rail, gaps = [] } = {}) {
  const length = curve.getLength();
  const rows = across(curve);
  const map = (slim ? slimBeltMap : beltMap).clone();
  map.needsUpdate = true;
  const group = new THREE.Group();
  const [inner, outer] = [half + 0.06, half + (slim ? 0.2 : 0.24)];
  const [under, lip] = slim ? [DECK - 0.2, DECK + 0.13] : [0.42, DECK + 0.2];
  /** The rows of one side's rail: all of them, or the runs left between the openings on that side. */
  const runs = (side) => {
    const open = gaps.filter((gap) => gap[1] === side).map(([far, , wide]) => [far - wide, far + wide]).sort((a, b) => a[0] - b[0]);
    if (!open.length) return [rows];
    const rowAt = (far) => {
      const u = Math.min(0.9999, Math.max(0, far / length));
      const ahead = curve.getTangentAt(u).setY(0).normalize();
      return { point: curve.getPointAt(u), side: new THREE.Vector3(-ahead.z, 0, ahead.x), far };
    };
    const kept = [];
    let from = 0;
    for (const [a, b] of [...open, [length, length]]) {
      if (a - from > 0.05) kept.push([rowAt(from), ...rows.filter((row) => row.far > from + 0.05 && row.far < a - 0.05), rowAt(a)]);
      from = Math.max(from, b);
    }
    return kept;
  };
  const top = new THREE.Mesh(strip(rows, [-half, DECK], [half, DECK]), new THREE.MeshStandardMaterial({ map, roughness: 0.9, side: THREE.DoubleSide }));
  const beds = [];
  const rails = [];
  for (const side of [-1, 1]) {
    for (const run of runs(side)) {
      if (!slim) beds.push(strip(run, [side * inner, under], [side * inner, DECK - 0.02]));
      rails.push(strip(run, [side * outer, under], [side * outer, lip]), strip(run, [side * inner, lip], [side * inner, DECK - 0.02]), strip(run, [side * outer, lip], [side * inner, lip]));
      if (slim) rails.push(strip(run, [side * outer, under], [side * inner, under]));
    }
  }
  // Under a slim belt, the deck's own underside closes it.
  if (slim) beds.push(strip(rows, [-inner, under], [inner, under]));
  const bed = new THREE.Mesh(mergeGeometries(beds), slim ? floor.frame : floor.bed);
  const rail = new THREE.Mesh(mergeGeometries(rails), trim);
  rail.material.side = bed.material.side = THREE.DoubleSide;
  for (const mesh of [top, bed, rail]) (mesh.castShadow = mesh !== top), (mesh.receiveShadow = true), group.add(mesh);
  const tall = slim ? under : 0.42;
  const legs = rows.filter((_, index) => index % 3 === 1).flatMap(({ point, side }) => [-(half - 0.06), half - 0.06].map((off) => new THREE.Matrix4().makeTranslation(point.x + side.x * off, tall / 2, point.z + side.z * off)));
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(slim ? 0.07 : 0.1, slim ? 0.08 : 0.13, tall, 6), slim ? floor.frame : floor.bed, legs.length);
  legs.forEach((where, index) => posts.setMatrixAt(index, where));
  posts.castShadow = true;
  group.add(posts);
  return { group, map, curve, length, moving: 0, taken: rows.map((row) => row.point) };
}
function parcelOf(colour, hops = 0) {
  const parcel = templates.has("parcel") ? spawn("parcel") : new THREE.Group();
  if (templates.has("parcel")) for (const band of paints(parcel, "band")) band.color.setHex(colour);
  else parcel.add(block(tint(TONE.card), 0.95, 0.75, 0.95), block(tint(colour), 0.98, 0.2, 0.98, 0, 0.28, 0));
  // One it took a round's receipt to send carries a mark for each hop it is from where it began.
  for (let hop = 0; hop < Math.min(hops, 4); hop++) parcel.add(block(tint(0x59626e), 0.16, 0.08, 0.16, -0.33 + hop * 0.22, 0.75, 0.3));
  return parcel;
}
const boxOf = (colour = TONE.card) => block(tint(colour, 0.9), 0.82, 0.62, 0.82);
const paperOf = (colour = TONE.paper) => block(tint(colour, 0.9), 0.72, 0.05, 1);
function letterOf(kind) {
  if (!templates.has("letter")) return block(tint(kind === "ask" ? TONE.warn : 0xe4e0d6, 0.85), 1.1, 0.1, 0.75);
  const model = spawn("letter");
  for (const body of paints(model, "envelope")) body.color.setHex(kind === "ask" ? TONE.warn : 0xe4e0d6);
  return model;
}
const clockOf = () => (templates.has("clock") ? spawn("clock") : drum(tint(TONE.paper), 0.42, 0.42, 0.12, 0, 0, 0, 16));
/** A count you can see: that many things set out in rows and layers, rebuilt only when what it shows has changed. */
function setPile(holder, key, items, across = 2, cell = [0.9, 0.66, 0.9], deep = 1) {
  if (holder.userData.key === key) return;
  holder.userData.key = key;
  holder.clear();
  items.forEach((item, index) => {
    const layer = Math.floor(index / (across * deep));
    const within = index % (across * deep);
    item.position.set((within % across) * cell[0], layer * cell[1], Math.floor(within / across) * cell[2]);
    holder.add(item);
  });
}
const keyOf = (pick) => `${pick?.kind}:${pick?.id ?? ""}`;

// A tree is a few soft lobes on a trunk. Every tree is one of three shapes, turned, sized and coloured its own way.
const CANOPIES = [11, 23, 37].map((seed) => {
  const random = seeded(seed);
  const lobes = Array.from({ length: 10 }, (_, index) => {
    const lobe = new THREE.SphereGeometry(1, 7, 5);
    const size = index === 0 ? 2 : 0.95 + random() * 0.6;
    lobe.scale(size, size * (0.85 + random() * 0.2), size);
    // The rest sit on the first one's surface, more of them above the middle than below.
    const around = random() * Math.PI * 2;
    const up = 0.1 + random() * 1.1;
    const out = index === 0 ? 0 : 1.75;
    lobe.translate(Math.cos(around) * Math.cos(up) * out, 4.1 + (index === 0 ? 0 : Math.sin(up) * out * 0.9 - 0.5), Math.sin(around) * Math.cos(up) * out);
    return lobe;
  });
  return limber(mergeGeometries(lobes), (y) => 0.035 * (y - 1));
});
const TRUNK = new THREE.CylinderGeometry(0.26, 0.4, 3.4, 6).translate(0, 1.7, 0);
const LEAVES = [0x5aa548, 0x69b452, 0x78c05a, 0x4d973f, 0x86c862, 0x62ad4c, 0x91cc6a];
const AUTUMN = [0xe9b23c, 0xe09a2e, 0xefc552];
const SMALL = {
  bush: limber(mergeGeometries([[0, 0.55, 0, 0.8], [0.55, 0.45, 0.2, 0.6], [-0.5, 0.42, -0.25, 0.62], [0.1, 0.42, -0.55, 0.55]].map(([x, y, z, r]) => new THREE.SphereGeometry(r, 8, 6).translate(x, y, z))), (y) => 0.05 * y),
  tuft: limber(mergeGeometries([[-0.13, 0.02, 0.32], [0.02, -0.09, 0.46], [0.14, 0.06, 0.3]].map(([x, z, tall]) => new THREE.ConeGeometry(0.075, tall, 4).translate(x, tall / 2, z))), (y) => 0.24 * y),
  rock: new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.6, 0.8).translate(0, 0.2, 0),
  stone: new THREE.CylinderGeometry(0.44, 0.48, 0.07, 7).translate(0, 0.035, 0),
  pot: new THREE.CylinderGeometry(0.62, 0.48, 0.55, 12).translate(0, 0.275, 0),
  post: new THREE.CylinderGeometry(0.13, 0.17, 0.75, 8).translate(0, 0.375, 0),
  glow: new THREE.SphereGeometry(0.22, 10, 8).translate(0, 0.9, 0),
  barrel: new THREE.CylinderGeometry(0.44, 0.44, 1.05, 12).translate(0, 0.525, 0),
  crate: new THREE.BoxGeometry(0.86, 0.66, 0.86).translate(0, 0.33, 0),
  reed: limber(new THREE.CylinderGeometry(0.035, 0.055, 1.5, 4, 3).translate(0, 0.75, 0), (y) => 0.13 * y * y),
};
const puffMap = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const pen = canvas.getContext("2d");
  const fade = pen.createRadialGradient(32, 32, 2, 32, 32, 30);
  fade.addColorStop(0, "rgba(255,255,255,0.9)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  pen.fillStyle = fade;
  pen.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
})();
// What a tree wears through the year. One in eight keeps its leaves; one in five of the rest blossoms in spring.
const FRESH = [0x8fd06a, 0x9bd672, 0x84c860, 0xa6dc7c];
const BLOSSOM = [0xf6b9d0, 0xfbd3e1, 0xfde9ef, 0xf4a7c3, 0xfff3d6];
const FALL = [0xe9b23c, 0xe09a2e, 0xefc552, 0xd9772b, 0xc9552e, 0xdb8a2c, 0xb9b04c];
const FIRS = [0x3f8a4c, 0x377d47, 0x47935a];
// The limbs of a tree, bare: what is left standing where its crown was once the leaves are down. Three shapes, as the crowns are.
const LIMBS = [11, 23, 37].map((seed) => {
  const random = seeded(seed + 500);
  const sticks = [];
  const stick = (from, to, thick, thin) => {
    const along = to.clone().sub(from);
    const part = new THREE.CylinderGeometry(thin, thick, along.length(), 4, 1, true).translate(0, along.length() / 2, 0);
    part.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.clone().normalize()));
    sticks.push(part.translate(from.x, from.y, from.z));
  };
  stick(new THREE.Vector3(0, 3.2, 0), new THREE.Vector3((random() - 0.5) * 0.6, 5.5 + random() * 0.7, (random() - 0.5) * 0.6), 0.27, 0.035);
  for (let limb = 0; limb < 5; limb++) {
    const around = (limb / 5) * Math.PI * 2 + random() * 0.8;
    const reach = 1.5 + random() * 0.9;
    const from = new THREE.Vector3(0, 2.6 + random() * 1.2, 0);
    const elbow = new THREE.Vector3(Math.cos(around) * reach * 0.6, from.y + 0.7 + random() * 0.5, Math.sin(around) * reach * 0.6);
    const tip = new THREE.Vector3(Math.cos(around) * reach * 1.3, elbow.y + 1 + random() * 0.9, Math.sin(around) * reach * 1.3);
    stick(from, elbow, 0.19, 0.12);
    stick(elbow, tip, 0.12, 0.035);
    for (const hand of [-1, 1]) {
      const off = around + hand * (0.7 + random() * 0.5);
      const start = elbow.clone().lerp(tip, 0.1 + random() * 0.5);
      stick(start, start.clone().add(new THREE.Vector3(Math.cos(off) * (0.7 + random() * 0.5), 0.6 + random() * 0.7, Math.sin(off) * (0.7 + random() * 0.5))), 0.075, 0.03);
    }
  }
  return mergeGeometries(sticks);
});
/** Plants a wood: every spot given gets a tree, drawn together by shape. What each wears through the year is settled here too. */
function wood(root, spots, random, leafy) {
  const upright = new THREE.Vector3(0, 1, 0);
  // Drawn apart from the lots everything else in the town is laid out by, so that planting the same town twice gives the same town.
  const lot = seeded(spots.length * 31 + 7);
  const pick = (list) => list[Math.floor(lot() * list.length)];
  const sets = CANOPIES.map(() => []);
  for (const [x, z] of spots) sets[Math.floor(random() * sets.length)].push([x, z]);
  sets.forEach((mine, shapeIndex) => {
    if (!mine.length) return;
    const crowns = new THREE.InstancedMesh(CANOPIES[shapeIndex], floor.leaf, mine.length);
    const trunks = new THREE.InstancedMesh(TRUNK, floor.bark, mine.length);
    const twigs = new THREE.InstancedMesh(LIMBS[shapeIndex], floor.twig, mine.length);
    const colour = new THREE.Color();
    const own = [];
    const trees = [];
    mine.forEach(([x, z], index) => {
      const size = 0.75 + random() * 0.6;
      const where = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(upright, random() * Math.PI * 2), new THREE.Vector3(size, size * (0.9 + random() * 0.25), size));
      crowns.setMatrixAt(index, where);
      trunks.setMatrixAt(index, where);
      const tone = random() < 0.085 ? AUTUMN[Math.floor(random() * AUTUMN.length)] : LEAVES[Math.floor(random() * LEAVES.length)];
      crowns.setColorAt(index, colour.setHex(tone).offsetHSL(0, 0, (random() - 0.5) * 0.06));
      own.push(colour.getHex());
      const fir = lot() < 0.125;
      const blossom = !fir && lot() < 0.2;
      const summer = fir ? pick(FIRS) : colour.getHex();
      trees.push({ x, z, size, base: where, fir, blossom, late: (lot() - 0.5) * 0.05, summer, spring: fir ? summer : pick(FRESH), petal: blossom ? pick(BLOSSOM) : null, autumn: fir ? summer : pick(FALL), bark: colour.setHex(0x8a6a4a).offsetHSL(0, 0, (lot() - 0.5) * 0.08).getHex() });
      // A tree that keeps its leaves has no bare limbs to show.
      twigs.setMatrixAt(index, fir ? new THREE.Matrix4().makeScale(0, 0, 0) : where);
      twigs.setColorAt(index, colour.setHex(trees.at(-1).bark));
    });
    leafy.push({ mesh: crowns, own, trees, twigs });
    crowns.castShadow = crowns.receiveShadow = trunks.castShadow = twigs.castShadow = true;
    crowns.customDepthMaterial = windDepth;
    twigs.visible = false;
    root.add(crowns, trunks, twigs);
  });
}
/**
 * Dresses everything that grows for the day of the year it is, and for whatever snow is lying. A tree's crown is its
 * spring, summer and autumn colours mixed by how much of each there is on its own day, and dwindles to nothing as
 * winter comes over it, leaving its limbs; bushes, tufts and reeds keep their leaves and only go dull.
 */
function dress(snow) {
  const date = timeNow();
  const season = look().season;
  const [hue, other, white] = [new THREE.Color(), new THREE.Color(), new THREE.Color(0xf4f7fb)];
  const grown = new THREE.Matrix4();
  const shedding = [];
  for (const { mesh, own, trees, twigs, distant } of town.leafy) {
    if (!trees) {
      own.forEach((colour, index) => mesh.setColorAt(index, hue.setHex(colour).lerp(other.setHex(0xb7a04e), season[2] * 0.35).lerp(other.setHex(0x8c8558), season[3] * 0.7).lerp(white, snow * 0.62)));
      mesh.instanceColor.needsUpdate = true;
      continue;
    }
    let bare = false;
    trees.forEach((tree, index) => {
      const [spring, summer, autumn, winter] = tree.fir ? [0, 1, 0, 0] : seasonsAt(date, tree.late);
      hue.setRGB(0, 0, 0);
      for (const [share, colour] of [[spring, tree.spring], [summer, tree.summer], [autumn + winter, tree.autumn]]) hue.add(other.setHex(colour).multiplyScalar(share));
      // In blossom only at the height of its spring: in fresh leaf before and after, so that pink never mixes with green.
      const flowering = tree.petal === null ? 0 : THREE.MathUtils.smoothstep(spring, 0.6, 0.92);
      if (flowering) hue.lerp(other.setHex(tree.petal), flowering);
      // The last leaves to hang on are brown.
      hue.lerp(other.setHex(0x9a7648), winter * 0.7);
      mesh.setColorAt(index, hue.lerp(white, snow * 0.62));
      // Far-off trees have no limbs to show, so they keep a thin crown through the winter.
      const leaves = 1 - THREE.MathUtils.smoothstep(winter, 0.25, 0.8) * (distant ? 0.3 : 1);
      mesh.setMatrixAt(index, grown.makeScale(leaves, leaves, leaves).setPosition(0, 4.1 * (1 - leaves), 0).premultiply(tree.base));
      bare ||= leaves < 0.97;
      twigs?.setColorAt(index, hue.setHex(tree.bark).lerp(white, snow * 0.5));
      // What a tree lets fall: leaves while it is turning, petals while it is in blossom.
      if (!distant && !tree.fir && (autumn > 0.25 && leaves > 0.1 ? true : flowering > 0.5)) shedding.push({ x: tree.x, z: tree.z, size: tree.size, colour: autumn > 0.25 ? tree.autumn : tree.petal });
    });
    mesh.instanceColor.needsUpdate = mesh.instanceMatrix.needsUpdate = true;
    if (twigs) ((twigs.visible = bare), (twigs.instanceColor.needsUpdate = true));
  }
  // Flowers: all of them in spring, most in summer, a few left in autumn, none in winter or under snow.
  town.flowers.count = snow ? 0 : Math.round(town.flowers.userData.all * (season[0] + season[1] * 0.7 + season[2] * 0.2));
  const falling = town.air.leaves;
  falling.from = shedding;
  falling.mesh.count = shedding.length ? Math.round(Math.min(falling.each.length, shedding.length * 0.5) * Math.min(1, season[2] * 1.4 + season[0] * 0.45)) : 0;
  falling.mesh.visible = falling.mesh.count > 0;
}

// ------------------------------------------------------------------ over an Agent: rings that turn, and a shaft of light
/**
 * What hangs over an Agent on its plaza: three gold rings one inside another, each turning about an axis of its own,
 * slowly while the Agent waits and fast while it works; and a shaft of light in the Agent's colour, standing from the
 * dais (`below` under the rings) up through them (`above`), for as long as the Agent is at work.
 */
function orrery(colour, below, above) {
  const group = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xd6a53c, roughness: 0.35, metalness: 0.2, emissive: 0xffc860, emissiveIntensity: 0 });
  const rings = [[1.95, [0.5, 0, 0.35], 1], [1.6, [-0.75, 0, 0.9], -1.3], [1.25, [1.2, 0, -0.5], 1.7]].map(([radius, tilt, pace]) => {
    const holder = new THREE.Group();
    holder.rotation.set(...tilt);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 8, 56), gold);
    ring.castShadow = true;
    holder.add(ring);
    group.add(holder);
    return { ring, pace };
  });
  // Seen from the side a tube of one colour has hard edges: this one thins out to nothing where its wall turns away
  // from the eye, and upward.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.1, 3.9, below + above, 40, 1, true),
    new THREE.ShaderMaterial({
      uniforms: { uColour: { value: new THREE.Color(colour).lerp(new THREE.Color(0xfff6e0), 0.62) }, opacity: { value: 0 } },
      vertexShader: `varying vec3 vFacing; varying vec3 vToEye; varying float vUp;
        void main() {
          vec4 seen = modelViewMatrix * vec4(position, 1.0);
          vFacing = normalMatrix * normal;
          vToEye = -seen.xyz;
          vUp = uv.y;
          gl_Position = projectionMatrix * seen;
        }`,
      fragmentShader: `uniform vec3 uColour; uniform float opacity; varying vec3 vFacing; varying vec3 vToEye; varying float vUp;
        void main() {
          float through = abs(dot(normalize(vFacing), normalize(vToEye)));
          // Faint where the Agent stands in it, so the figure keeps its colour; full over its head; gone at the top.
          float shaft = mix(0.2, 1.0, smoothstep(0.36, 0.62, vUp)) * (1.0 - smoothstep(0.74, 1.0, vUp));
          gl_FragColor = vec4(uColour, opacity * pow(through, 1.6) * shaft);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  beam.position.y = (above - below) / 2;
  beam.userData.flat = true;
  beam.renderOrder = 4;
  beam.visible = false;
  group.add(beam);
  // Motes of light going up in the shaft, round and round: each at its own distance out, its own pace.
  const random = seeded(colour + Math.round(below * 100));
  const each = Array.from({ length: 26 }, () => ({ far: 0.5 + random() * 2.2, round: random() * Math.PI * 2, turn: 0.15 + random() * 0.35, pace: 0.07 + random() * 0.08, start: random() }));
  const motes = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(each.length * 3), 3)),
    new THREE.PointsMaterial({ map: puffMap, color: new THREE.Color(colour).lerp(new THREE.Color(0xfff3cf), 0.7), size: 0.46, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  motes.frustumCulled = motes.visible = false;
  motes.userData.flat = true;
  motes.renderOrder = 5;
  group.add(motes);
  return { group, rings, beam, gold, shone: 0, motes: { points: motes, each, from: -below * 0.5, span: above + below * 0.5 } };
}

// ------------------------------------------------------------------ the notice board by the hall
/**
 * What the hub's records say of today: rows of [what, which, how much], for the board and for the hall's card. The
 * counts are the hub's own for the day; which line stuck most is told from the rounds it still lists, the latest few
 * dozen, so on a long day it speaks of the last part of it.
 */
function todayOf(state) {
  const most = (list) => list.reduce((top, each) => ((each.totals?.doneToday ?? 0) > (top?.totals.doneToday ?? 0) ? each : top), null);
  const [line, agent] = [most(state.lines), most(state.agents)];
  const today = new Date(state.now).toDateString();
  const stuck = new Map();
  for (const run of state.runs ?? []) if (run.attempts > 0 && new Date(run.createdAt).toDateString() === today) stuck.set(run.rule, (stuck.get(run.rule) ?? 0) + run.attempts);
  const worst = [...stuck].sort((a, b) => b[1] - a[1])[0];
  const cost = state.spending?.today?.cost ?? 0;
  return [
    ["今天做完", `${state.totals.doneToday ?? 0} 件`, cost ? `花了 $${cost.toFixed(2)}` : ""],
    ["最忙的线", line ? line.name : "还没开张", line ? `${line.totals.doneToday} 件` : ""],
    ["干得最多", agent ? agent.name : "还没人动手", agent ? `${agent.totals.doneToday} 件` : ""],
    ["最爱卡的线", worst ? worst[0] : "都顺", worst ? `重试 ${worst[1]} 次` : ""],
  ];
}
/** The board: two posts, a frame under a little roof with a lamp, and a sheet drawn here and drawn again whenever what it says has changed. */
function noticeBoard() {
  const group = new THREE.Group();
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = [1024, 600];
  const sheet = new THREE.CanvasTexture(canvas);
  sheet.colorSpace = THREE.SRGBColorSpace;
  sheet.anisotropy = 8;
  // By night it is lit by its own lamp: the sheet gives back a little light of its own, so it can still be read.
  const face = new THREE.MeshStandardMaterial({ map: sheet, roughness: 0.9, emissive: 0xffffff, emissiveMap: sheet, emissiveIntensity: 0 });
  const [timber, frame, tiles] = [tint(0xb08a5a), tint(0xf6f0e4), tint(0x8db6dc)];
  for (const side of [-1, 1]) group.add(drum(timber, 0.09, 0.11, 3.1, side * 1.78, 0, 0, 10));
  group.add(block(frame, 3.74, 2.2, 0.14, 0, 0.92, 0));
  const page = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 2.05), face);
  page.position.set(0, 2.02, 0.074);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 2.05), tint(0xe9e1cf));
  back.position.set(0, 2.02, -0.074);
  back.rotation.y = Math.PI;
  group.add(page, back);
  for (const side of [-1, 1]) {
    const slope = block(tiles, 4.1, 0.1, 0.66, 0, 0, 0);
    slope.position.set(0, 3.3, side * 0.26);
    slope.rotation.x = side * 0.5;
    group.add(slope);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), floor.glow);
  lamp.position.set(0, 3.1, 0.3);
  group.add(lamp);
  return { group, canvas, sheet, face, said: "" };
}
function paintBoard(state) {
  const board = town?.board;
  if (!board) return;
  const rows = todayOf(state);
  const date = new Date(state.now);
  const said = JSON.stringify([date.toDateString(), rows]);
  if (said === board.said) return;
  board.said = said;
  const pen = board.canvas.getContext("2d");
  const face = 'ui-rounded, "SF Pro Rounded", "PingFang SC", system-ui, sans-serif';
  pen.textBaseline = "middle";
  pen.fillStyle = "#fbf7ec";
  pen.fillRect(0, 0, 1024, 600);
  pen.fillStyle = "#5b8fc4";
  pen.fillRect(0, 0, 1024, 120);
  pen.fillStyle = "#ffffff";
  pen.textAlign = "left";
  pen.font = `700 62px ${face}`;
  pen.fillText("今日告示", 44, 62);
  pen.textAlign = "right";
  pen.font = `500 40px ${face}`;
  pen.fillText(`${date.getMonth() + 1}月${date.getDate()}日 周${"日一二三四五六"[date.getDay()]}`, 980, 64);
  rows.forEach(([what, which, much], index) => {
    const y = 182 + index * 108;
    if (index) ((pen.fillStyle = "rgba(43, 47, 54, 0.1)"), pen.fillRect(44, y - 55, 936, 2));
    pen.textAlign = "left";
    pen.fillStyle = "#8a8474";
    pen.font = `500 38px ${face}`;
    pen.fillText(what, 44, y);
    pen.fillStyle = "#2b2f36";
    pen.font = `700 56px ${face}`;
    pen.fillText(which, 268, y, 450);
    pen.textAlign = "right";
    pen.fillStyle = "#b5642c";
    pen.font = `600 44px ${face}`;
    pen.fillText(much, 980, y, 250);
  });
  board.sheet.needsUpdate = true;
}

// ------------------------------------------------------------------ far off: hills, a lake, trees thinning out, mist
// Three ranges of hills stand round the plain, each further and paler than the one before it, and a lake lies before
// them to the north and east. None of it is ever reached: it is what there is to see when the eye comes down low. It
// is drawn in flat colour, set by the hour and the weather, and at its foot is the colour the plain fades into.
const distance = (() => {
  const random = seeded(90210);
  const STEPS = 360;
  const group = new THREE.Group();
  const ranges = [[2150, 132, 0.5, 1], [1800, 86, 0.68, 0.6], [1450, 46, 0.86, 0]].map(([far, tall, depth, capped]) => {
    const waves = Array.from({ length: 8 }, (_, index) => [2 + index * 3 + Math.floor(random() * 3), random() * Math.PI * 2, 1 / (index + 1.3)]);
    // Peaks where a wave comes to a point, long backs where it only swells; every wave goes a whole number of times round.
    const rough = Array.from({ length: STEPS }, (_, step) => {
      const angle = (step / STEPS) * Math.PI * 2;
      return waves.reduce((sum, [turns, phase, weight], index) => sum + weight * (index % 2 ? 1 - Math.abs(Math.sin((angle * turns) / 2 + phase)) : 0.5 + 0.5 * Math.sin(angle * turns + phase)), 0);
    });
    const [low, high] = [Math.min(...rough), Math.max(...rough)];
    const heights = Array.from({ length: STEPS + 1 }, (_, step) => tall * (0.2 + 0.8 * Math.pow((rough[step % STEPS] - low) / (high - low), 1.35)));
    const positions = heights.flatMap((height, step) => {
      const [x, z] = [Math.cos((step / STEPS) * Math.PI * 2) * far, Math.sin((step / STEPS) * Math.PI * 2) * far];
      return [x, -8, z, x, height * 0.5, z, x, height, z];
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
    geometry.setIndex(Array.from({ length: STEPS }, (_, step) => [0, 1].flatMap((row) => [step * 3 + row, step * 3 + 3 + row, step * 3 + row + 1, step * 3 + row + 1, step * 3 + 3 + row, step * 3 + 4 + row])).flat());
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    mesh.userData.flat = true;
    group.add(mesh);
    return { mesh, heights, tall, depth, capped };
  });
  // The lake: a band of water from the north-west round by the east to the south-east, coming out of the haze on
  // its near side and running in under the hills on its far one.
  const [from, to, ACROSS, RADII] = [-2.82, 1.2, 96, [1000, 1110, 1270, 1456]];
  const water = new THREE.BufferGeometry();
  water.setAttribute("position", new THREE.Float32BufferAttribute(Array.from({ length: ACROSS + 1 }, (_, step) => RADII.flatMap((far) => [Math.cos(from + ((to - from) * step) / ACROSS) * far, 1.5, Math.sin(from + ((to - from) * step) / ACROSS) * far])).flat(), 3));
  water.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((ACROSS + 1) * RADII.length * 4), 4));
  water.setIndex(Array.from({ length: ACROSS }, (_, step) => [0, 1, 2].flatMap((row) => [step * 4 + row, step * 4 + row + 1, step * 4 + 4 + row, step * 4 + row + 1, step * 4 + 5 + row, step * 4 + 4 + row])).flat());
  const lake = new THREE.Mesh(water, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, fog: false, depthWrite: false }));
  lake.frustumCulled = false;
  lake.userData.flat = true;
  group.add(lake);
  // Not shown until it has been given its colours.
  group.visible = false;
  scene.add(group);
  return { group, ranges, lake, ACROSS };
})();
/** Colours what is far off for the hour, the season and the weather; `clear` is how much of it can be made out at all. */
function paintDistance(now, snow, clear) {
  distance.group.visible = true;
  const haze = scene.fog.color;
  const [body, half, top, pale] = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(now.sky)];
  for (const { mesh, heights, tall, depth, capped } of distance.ranges) {
    body.setHex(now.far);
    // The nearest range is wooded; the further two are bare rock, with snow on their tops.
    if (!capped) body.lerp(top.setHex(0x5d8c5c).multiply(half.setHex(now.leaf)), 0.4);
    body.lerpColors(haze, body, depth * clear);
    half.lerpColors(haze, body, 0.82);
    const { color } = mesh.geometry.attributes;
    heights.forEach((height, step) => {
      // A little snow on the highest all year, more in winter, and more again when it lies in the town.
      top.copy(body).lerp(pale, capped * THREE.MathUtils.smoothstep(height / tall, 0.55, 0.95) * Math.min(1, 0.3 + now.season[3] * 0.5 + snow * 0.4) * clear * 0.85);
      color.setXYZ(step * 3, haze.r, haze.g, haze.b);
      color.setXYZ(step * 3 + 1, half.r, half.g, half.b);
      color.setXYZ(step * 3 + 2, top.r, top.g, top.b);
    });
    color.needsUpdate = true;
  }
  // The lake takes its colour from the sky over it, and is brightest in the middle of its breadth.
  body.setHex(now.water).lerp(top.setHex(now.top), 0.4).lerp(pale, 0.25 + snow * 0.4);
  body.lerpColors(haze, body, 0.62 * clear);
  half.copy(body).lerp(pale, 0.4);
  const { color } = distance.lake.geometry.attributes;
  for (let step = 0; step <= distance.ACROSS; step++) {
    const ends = THREE.MathUtils.smoothstep(Math.min(step, distance.ACROSS - step) / distance.ACROSS, 0, 0.07);
    [[body, 0], [body, 1], [half, 1], [body, 1]].forEach(([hue, shown], row) => color.setXYZW(step * 4 + row, hue.r, hue.g, hue.b, shown * ends * clear));
  }
  color.needsUpdate = true;
}
// A tree far off is three lobes and a stem.
const FAR_CROWN = limber(mergeGeometries([[0, 4.2, 0, 2.25], [1.35, 3.6, 0.5, 1.5], [-1.05, 3.9, -0.95, 1.6]].map(([x, y, z, size]) => new THREE.SphereGeometry(size, 6, 4).translate(x, y, z))), (y) => 0.035 * (y - 1));
const FAR_TRUNK = new THREE.CylinderGeometry(0.3, 0.42, 3.4, 4, 1, true).translate(0, 1.7, 0);
/** Plants the trees that stand beyond the wood, thinning out toward the hills: dressed through the year as the wood is, but never bare. */
function spinney(root, spots, leafy) {
  const lot = seeded(spots.length * 17 + 3);
  const pick = (list) => list[Math.floor(lot() * list.length)];
  const crowns = new THREE.InstancedMesh(FAR_CROWN, floor.leaf, spots.length);
  const trunks = new THREE.InstancedMesh(FAR_TRUNK, floor.bark, spots.length);
  const colour = new THREE.Color();
  const upright = new THREE.Vector3(0, 1, 0);
  const trees = spots.map(([x, z], index) => {
    const size = 0.8 + lot() * 0.75;
    const base = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(upright, lot() * Math.PI * 2), new THREE.Vector3(size, size * (0.9 + lot() * 0.3), size));
    crowns.setMatrixAt(index, base);
    trunks.setMatrixAt(index, base);
    const fir = lot() < 0.2;
    const blossom = !fir && lot() < 0.2;
    const summer = fir ? pick(FIRS) : colour.setHex(lot() < 0.085 ? pick(AUTUMN) : pick(LEAVES)).offsetHSL(0, 0, (lot() - 0.5) * 0.06).getHex();
    crowns.setColorAt(index, colour.setHex(summer));
    return { x, z, size, base, fir, blossom, late: (lot() - 0.5) * 0.05, summer, spring: fir ? summer : pick(FRESH), petal: blossom ? pick(BLOSSOM) : null, autumn: fir ? summer : pick(FALL) };
  });
  crowns.frustumCulled = trunks.frustumCulled = false;
  leafy.push({ mesh: crowns, own: trees.map((tree) => tree.summer), trees, distant: true });
  root.add(crowns, trunks);
}
// Mist lies in patches a little off the ground: each a soft-edged blot, drawn here.
const mistMap = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const pen = canvas.getContext("2d");
  const random = seeded(606);
  pen.globalCompositeOperation = "lighter";
  for (let blot = 0; blot < 11; blot++) {
    const [x, y, size] = [34 + random() * 60, 40 + random() * 48, 18 + random() * 16];
    const fade = pen.createRadialGradient(x, y, 1, x, y, size);
    fade.addColorStop(0, "rgba(255,255,255,0.34)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    pen.fillStyle = fade;
    pen.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(canvas);
})();

// ------------------------------------------------------------------ the hall's works: ribs, a turning floor, sorting arms

// The floor that turns under the dome: planks laid like the spokes of a wheel, a few of them blue, so its turning shows.
const plankMap = drawn(1024, (pen, size) => {
  const chance = seeded(4411);
  const [middle, wedges] = [size / 2, 72];
  const tones = ["#f1ece0", "#e2dccd", "#f7f3ea", "#d9d2c1", "#eae4d6"];
  for (let wedge = 0; wedge < wedges; wedge++) {
    const [from, to] = [(wedge / wedges) * Math.PI * 2, ((wedge + 1) / wedges) * Math.PI * 2];
    pen.beginPath();
    pen.moveTo(middle, middle);
    pen.arc(middle, middle, middle, from, to);
    pen.closePath();
    pen.fillStyle = wedge % 12 === 0 ? "#7fa9d8" : tones[Math.floor(chance() * tones.length)];
    pen.fill();
    pen.strokeStyle = "rgba(110, 100, 84, 0.5)";
    pen.lineWidth = 2.2;
    pen.stroke();
  }
  pen.strokeStyle = "rgba(120, 112, 96, 0.22)";
  pen.lineWidth = 2;
  for (const far of [0.62, 0.86]) (pen.beginPath(), pen.arc(middle, middle, middle * far, 0, Math.PI * 2), pen.stroke());
});
const WORKS = {
  planks: new THREE.MeshStandardMaterial({ map: plankMap, roughness: 0.85 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd9a63a, roughness: 0.35, metalness: 0.55 }),
  bulb: new THREE.MeshStandardMaterial({ color: 0xfff3d0, roughness: 0.4, emissive: 0xffd98a, emissiveIntensity: 0 }),
  // How long an arm's two limbs are, how far out from the mast its shoulder is, and how far over a parcel's foot its
  // hand is when it has hold of it.
  upper: 2.5, fore: 2.4, out: 0.9, grip: 0.97,
};
/**
 * What stands under the hall's dome and on top of it, built here: the dome's ribs, the floor that turns, the drum and
 * the mast in the middle with its ring of hooks, lamps hung from the ribs, the lantern on top, and the sorting arms.
 * `shape` is the dome's: how wide, where it starts, how high.
 */
function hubWorks({ radius, base, height, glazed = false }) {
  const group = new THREE.Group();
  if (glazed) {
    const glass = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 18, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, height / radius, 1).translate(0, base, 0), floor.glass);
    glass.userData.flat = true;
    glass.renderOrder = 2;
    group.add(glass);
  }
  const batch = new Map(); // material -> geometries: whatever stands still is drawn as one mesh a material
  const put = (material, ...geometries) => batch.set(material, [...(batch.get(material) ?? []), ...geometries]);
  const tube = (r, h, x, y, z, sides = 20, top = r) => new THREE.CylinderGeometry(top, r, h, sides).translate(x, y + h / 2, z);
  const hoop = (far, thick, y, around = 64) => new THREE.TorusGeometry(far, thick, 6, around).rotateX(Math.PI / 2).translate(0, y, 0);
  const cream = tint(0xf4f1ea);
  const white = tint(0xf8f6f1, 0.6);
  const pale = tint(0xe6edf2);
  const blue = tint(0x5d8fd0, 0.6);
  const dark = tint(0x2f333b, 0.5);
  const top = base + height;
  /** A point on the dome: how far round, and how far up from its foot (0) to its crown (1, as an angle). */
  const onDome = (round, up, inset = 0) => new THREE.Vector3(Math.cos(round) * (radius - inset) * Math.cos(up), base + (height - inset) * Math.sin(up), Math.sin(round) * (radius - inset) * Math.cos(up));

  // ---- the ribs: up from the foot to the lantern, and round at four heights, with a plate where they cross
  const [MERIDIANS, RINGS] = [16, [0.38, 0.74, 1.08]];
  for (let rib = 0; rib < MERIDIANS; rib++) {
    const round = ((rib + 0.5) / MERIDIANS) * Math.PI * 2;
    const way = new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, index) => onDome(round, (index / 8) * 1.4)));
    put(white, new THREE.TubeGeometry(way, 18, 0.085, 6, false));
  }
  put(white, hoop(radius, 0.13, base + 0.02, 72));
  for (const up of RINGS) put(white, hoop(radius * Math.cos(up), 0.07, base + height * Math.sin(up)));
  const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.1), white, MERIDIANS * RINGS.length);
  let plate = 0;
  for (let rib = 0; rib < MERIDIANS; rib++) {
    for (const up of RINGS) {
      pose.position.copy(onDome(((rib + 0.5) / MERIDIANS) * Math.PI * 2, up, -0.03));
      pose.lookAt(0, base, 0);
      pose.scale.setScalar(1);
      pose.updateMatrix();
      plates.setMatrixAt(plate++, pose.matrix);
    }
  }
  plates.castShadow = true;
  group.add(plates);

  // ---- the lantern on the crown: a ring of little columns under a red cap
  const crown = base + height * Math.sin(1.4);
  put(cream, tube(1.22, 0.2, 0, crown - 0.04, 0, 28), tube(1.02, 0.12, 0, crown + 0.82, 0, 28));
  for (let post = 0; post < 8; post++) put(white, tube(0.06, 0.66, Math.cos((post / 8) * Math.PI * 2) * 0.86, crown + 0.16, Math.sin((post / 8) * Math.PI * 2) * 0.86, 8));
  put(white, hoop(1.16, 0.035, crown + 0.5, 32));
  put(tint(0xd9634f, 0.7), new THREE.SphereGeometry(1, 22, 9, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).translate(0, crown + 0.94, 0));
  const lanternTop = crown + 0.94 + 0.6;

  // ---- the floor that turns, on its foot
  const floorTurning = new THREE.Group();
  const boards = new THREE.Mesh(new THREE.RingGeometry(2.42, 4.74, 96, 1).rotateX(-Math.PI / 2), WORKS.planks);
  boards.position.y = DECK - 0.004;
  boards.receiveShadow = true;
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(4.74, 4.8, 0.26, 96, 1, true).translate(0, DECK - 0.134, 0), cream);
  skirt.castShadow = skirt.receiveShadow = true;
  floorTurning.add(boards, skirt);
  group.add(floorTurning);
  put(pale, tube(4.5, DECK - 0.26, 0, 0, 0, 48));

  // ---- the drum in the middle, the mast, and the ring of hooks on it
  put(cream, tube(2.38, 1.5, 0, 0, 0, 48, 2.3), tube(1.62, 0.22, 0, 1.5, 0, 40, 1.5));
  put(blue, hoop(2.32, 0.075, 1.5, 72), tube(2.39, 0.09, 0, 0.96, 0, 48, 2.385));
  put(pale, tube(0.62, 3.9, 0, 1.72, 0, 24, 0.55), tube(0.8, 0.16, 0, 5.62, 0, 24));
  put(white, tube(0.16, crown - 5.78, 0, 5.78, 0, 12));
  const HOOKS = 14;
  put(WORKS.gold, hoop(0.98, 0.045, 5.2, 40));
  for (let strut = 0; strut < 4; strut++) put(WORKS.gold, new THREE.BoxGeometry(0.5, 0.05, 0.05).translate(0.76, 5.2, 0).rotateY((strut / 4) * Math.PI * 2 + 0.4));
  const hooks = new THREE.InstancedMesh(new THREE.TorusGeometry(0.13, 0.034, 6, 14), WORKS.gold, HOOKS);
  for (let hook = 0; hook < HOOKS; hook++) {
    const round = (hook / HOOKS) * Math.PI * 2;
    pose.position.set(Math.cos(round) * 0.98, 5.03, Math.sin(round) * 0.98);
    pose.rotation.set(0, -round + (hook % 2 ? 0.5 : -0.3), 0);
    pose.scale.setScalar(1);
    pose.updateMatrix();
    hooks.setMatrixAt(hook, pose.matrix);
  }
  hooks.castShadow = true;
  group.add(hooks);

  // ---- lamps hung from the ribs, lit when the street lamps are
  for (let hung = 0; hung < 8; hung++) {
    const round = ((hung + 0.5) / 8) * Math.PI * 2;
    const [x, z] = [Math.cos(round) * 5.05, Math.sin(round) * 5.05];
    const from = base + height * Math.sqrt(1 - (5.05 / radius) ** 2) - 0.05;
    put(dark, tube(0.014, from - 5.74, x, 5.74, z, 5));
    put(cream, new THREE.ConeGeometry(0.27, 0.16, 14, 1).translate(x, 5.7, z));
    put(WORKS.bulb, new THREE.SphereGeometry(0.13, 12, 8).translate(x, 5.56, z));
  }

  for (const [material, geometries] of batch) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries.map((each) => (each.index ? each.toNonIndexed() : each))), material);
    mesh.castShadow = material !== WORKS.bulb;
    mesh.receiveShadow = material !== WORKS.bulb;
    group.add(mesh);
  }

  // ---- the arms: each on a collar of its own round the mast, one above another, and free to swing all the way round
  const limb = (near, far, length) => new THREE.CylinderGeometry(far, near, length, 10).rotateZ(-Math.PI / 2).translate(length / 2, 0, 0);
  const wheel = (r, deep, x = 0) => new THREE.CylinderGeometry(r, r, deep, 18).rotateX(Math.PI / 2).translate(x, 0, 0);
  const made = (material, ...geometries) => {
    const mesh = new THREE.Mesh(geometries.length > 1 ? mergeGeometries(geometries.map((each) => (each.index ? each.toNonIndexed() : each))) : geometries[0], material);
    mesh.castShadow = true;
    return mesh;
  };
  const arms = [[2.3, 0xd9534a, 0.24, 0.5], [3.0, 0x3f6fd0, -0.19, 2.6], [3.7, 0xf0a04b, 0.15, 4.4]].map(([heightOf, colour, drift, angle]) => {
    const paint = tint(colour, 0.55);
    const turn = new THREE.Group();
    turn.position.y = heightOf;
    turn.add(made(paint, tube(0.8, 0.3, 0, -0.15, 0, 24), new THREE.BoxGeometry(0.5, 0.22, 0.3).translate(0.72, 0, 0)), made(dark, wheel(0.36, 0.4, WORKS.out)), made(paint, wheel(0.2, 0.48, WORKS.out)));
    const upper = new THREE.Group();
    upper.position.x = WORKS.out;
    upper.add(made(white, limb(0.19, 0.15, WORKS.upper)), made(dark, wheel(0.29, 0.36, WORKS.upper)), made(paint, wheel(0.16, 0.44, WORKS.upper)));
    const fore = new THREE.Group();
    fore.position.x = WORKS.upper;
    fore.add(made(white, limb(0.14, 0.11, WORKS.fore)));
    const hand = new THREE.Group();
    hand.position.x = WORKS.fore;
    // The hand hangs level whatever the limbs do: a wrist, a plate that comes down on the parcel, a finger each side.
    hand.add(made(tint(0x7d95b5, 0.6), new THREE.BoxGeometry(0.36, 0.3, 0.36).translate(0, -0.03, 0), new THREE.BoxGeometry(1.14, 0.09, 0.74).translate(0, -0.18, 0), new THREE.BoxGeometry(0.07, 0.34, 0.6).translate(-0.535, -0.39, 0), new THREE.BoxGeometry(0.07, 0.34, 0.6).translate(0.535, -0.39, 0)));
    fore.add(hand);
    upper.add(fore);
    turn.add(upper);
    group.add(turn);
    return { turn, upper, fore, hand, height: heightOf, drift, angle, busy: false, tip: new THREE.Vector3() };
  });
  for (const arm of arms) reach(arm, restOf(arm));
  return { group, floor: floorTurning, arms, bulbs: [WORKS.bulb], lanternTop };
}
/** Where an arm's hand is when it has nothing to do: out over the floor, on the side it is turned to. */
const restOf = (arm, into = new THREE.Vector3()) => into.set(Math.cos(arm.angle) * 3.3, arm.height - 0.3, Math.sin(arm.angle) * 3.3);
/** Puts an arm's hand at a place: it turns about the mast to face it, and bends its two limbs to reach. */
function reach(arm, tip) {
  arm.angle = Math.atan2(tip.z, tip.x);
  arm.turn.rotation.y = -arm.angle;
  const [u, v] = [Math.hypot(tip.x, tip.z) - WORKS.out, tip.y - arm.height];
  const far = THREE.MathUtils.clamp(Math.hypot(u, v), Math.abs(WORKS.upper - WORKS.fore) + 0.12, WORKS.upper + WORKS.fore - 0.02);
  // The elbow is kept up: over the line from the shoulder to the hand, not under it.
  const lifted = Math.atan2(v, u) + Math.acos(THREE.MathUtils.clamp((WORKS.upper ** 2 + far ** 2 - WORKS.fore ** 2) / (2 * WORKS.upper * far), -1, 1));
  const bent = Math.acos(THREE.MathUtils.clamp((WORKS.upper ** 2 + WORKS.fore ** 2 - far ** 2) / (2 * WORKS.upper * WORKS.fore), -1, 1)) - Math.PI;
  arm.upper.rotation.z = lifted;
  arm.fore.rotation.z = bent;
  arm.hand.rotation.z = -(lifted + bent);
  arm.tip.copy(tip);
}
/** The shorter way round from one angle to another. */
const roundTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
/** A place part of the way from one to another, going round the mast rather than through it, and up over an arc. */
function sweep(from, to, t, lift, into) {
  const [a, b] = [Math.atan2(from.z, from.x), Math.atan2(to.z, to.x)];
  const angle = a + roundTo(a, b) * t;
  const out = THREE.MathUtils.lerp(Math.hypot(from.x, from.z), Math.hypot(to.x, to.z), t);
  return into.set(Math.cos(angle) * out, THREE.MathUtils.lerp(from.y, to.y, t) + Math.sin(t * Math.PI) * lift, Math.sin(angle) * out);
}
/**
 * An arm takes a parcel from where it stands to where `target` says (which may be moving, as the floor is), swinging
 * it round the mast. Says false, having done nothing, when no arm is free or either place is out of an arm's reach.
 */
async function armCarry(home, parcel, target) {
  const arms = home.hall.arms;
  const within = (place) => place.y < 2.4 && Math.hypot(place.x, place.z) > 2.5 && Math.hypot(place.x, place.z) < 5.5;
  if (!arms?.length || still.matches || document.hidden || !within(parcel.position) || !within(target())) return false;
  const at = Math.atan2(parcel.position.z, parcel.position.x);
  const arm = arms.filter((each) => !each.busy).sort((a, b) => Math.abs(roundTo(a.angle, at)) - Math.abs(roundTo(b.angle, at)))[0];
  if (!arm) return false;
  arm.busy = true;
  const spot = new THREE.Vector3();
  const from = parcel.position.clone();
  const [began, over] = [arm.tip.clone(), from.clone().setY(from.y + WORKS.grip)];
  await tween(0.24 + (0.34 * Math.abs(roundTo(arm.angle, at))) / Math.PI, (t) => reach(arm, sweep(began, over, ease(t), 0.5, spot)));
  // Its lift differs from the other arms', so that two of them crossing don't put their loads through each other.
  const lift = 0.7 + (arm.height - 2.3) * 0.35;
  await tween(0.46 + (0.42 * Math.abs(roundTo(at, Math.atan2(target().z, target().x)))) / Math.PI, (t) => {
    parcel.position.copy(sweep(from, target(), ease(t), lift, spot));
    parcel.rotation.y = -Math.atan2(spot.z, spot.x);
    reach(arm, spot.setY(spot.y + WORKS.grip));
  });
  // It lets go and draws back, which nothing waits for.
  const held = arm.tip.clone();
  const rest = restOf(arm).clone();
  tween(0.4, (t) => reach(arm, sweep(held, rest, ease(t), 0.2, spot))).then(() => (arm.busy = false));
  return true;
}

// ------------------------------------------------------------------ plain shapes for models that aren't there yet

function roughHall() {
  const hall = new THREE.Group();
  const cream = tint(0xf6f0e4);
  for (let post = 0; post < 16; post++) {
    const angle = ((post + 0.5) / 16) * Math.PI * 2;
    hall.add(drum(cream, 0.4, 0.46, 3, Math.cos(angle) * 7.25, 0, Math.sin(angle) * 7.25, 10));
  }
  const cornice = new THREE.Mesh(new THREE.TorusGeometry(7.25, 0.44, 10, 56), tint(0x8db6dc));
  cornice.rotation.x = Math.PI / 2;
  cornice.position.y = 3;
  cornice.castShadow = true;
  const glass = new THREE.Mesh(new THREE.SphereGeometry(7, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2));
  glass.scale.y = 0.8;
  glass.position.y = 3;
  glass.name = "glass";
  const turntable = new THREE.Group();
  turntable.name = "turntable";
  turntable.add(drum(tint(0xdfe5ea, 0.5), 4.6, 4.7, DECK, 0, 0, 0, 48), drum(tint(0xffffff), 0.9, 1.3, 4.6, 0, DECK), ball(tint(0xd9534a), 1.05, 0, DECK + 4.8, 0));
  for (let spoke = 0; spoke < 6; spoke++) {
    const arm = new THREE.Group();
    arm.rotation.y = (spoke / 6) * Math.PI * 2;
    turntable.add(arm.add(block(tint(0x8db6dc), 2.6, 0.03, 0.2, 3.1, DECK, 0)));
  }
  return hall.add(cornice, glass, turntable);
}
function roughFigure(use) {
  const figure = new THREE.Group();
  const body = new THREE.Group();
  body.name = "body";
  const colour = tint(AGENT_TINTS[use] ?? 0x8fa6b8, 0.7);
  body.add(drum(colour, 0.9, 1.05, 1.8, 0, 0.2, 0, 16), ball(colour, 0.85, 0, 2.7, 0), block(tint(0x59626e), 1.2, 0.34, 0.2, 0, 2.6, 0.78));
  const spark = ball(new THREE.MeshStandardMaterial({ color: 0xfff6e2, roughness: 0.5 }), 0.42, 0, 4.3, 0);
  spark.name = "spark";
  return figure.add(body, spark);
}
function roughMachine(colour) {
  const machine = new THREE.Group();
  machine.add(block(tint(0xf6f0e4), 2.6, 2.3, 2.6), drum(tint(colour), 0.9, 1, 1.2, -0.3, 2.3, 0, 18), block(tint(0xcfd8e0, 0.5), 1.1, 0.2, 1.3, 1.3, DECK - 0.2, 0));
  return machine;
}

// ------------------------------------------------------------------ the town: a sorting hall under glass, in a wood

function build(state) {
  if (town) {
    for (const mover of town.movers) (mover.step(1), mover.done());
    for (const note of town.notes) note.element.remove();
    for (const { mesh } of town.turf ?? []) mesh.dispose();
    scene.remove(town.root);
    tags.replaceChildren();
    stories.clear();
    chase = null;
    document.body.classList.remove("chasing");
  }
  const root = new THREE.Group();
  scene.add(root);
  town = {
    root, lanes: new Map(), agents: new Map(), projects: [], spots: new Map(), tags: [], picks: [], movers: [], notes: [], belts: [], lamps: [], bulbs: [], pools: [], clocks: [],
    carousel: [], turn: 0, healed: false, puffs: [], paved: [],
    shown: { lanes: new Map(), inside: new Map(), done: new Map(), outbox: 0, house: 0, timers: 0, unrouted: 0 },
  };
  const random = seeded(20261112);
  const at = (x, z, y = 0) => new THREE.Vector3(x, y, z);
  const rim = (angle, radius, y = 0) => at(Math.cos(angle) * radius, Math.sin(angle) * radius, y);
  const rounds = []; // [x, z, radius]: where nothing grows
  const rects = []; // [x0, z0, x1, z1]
  const sandy = []; // [x0, z0, x1, z1]: streets, where nothing grows and nothing is hedged
  const lots = []; // the village's plots, for what is set out on them once everything stands
  const glades = []; // [x, z, radius]: kept clear of trees and shrubs, so the eye has a way through to an Agent
  const pickable = (object, pick) => ((object.userData.pick = pick), town.picks.push(object), object);
  /** A name plate over something: a dot, what it is, and how it's doing. */
  function label(where, pick, radius, extra = "") {
    const dot = node("i", { class: "dot" });
    const title = node("b", {});
    const status = node("span", {});
    const element = node("div", { class: `tag ${extra} of-${pick.kind}`, tabindex: "0", role: "button", onclick: () => select(pick) }, dot, title, status);
    element.addEventListener("keydown", (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), select(pick)));
    tags.append(element);
    const entry = { element, dot, title, status, at: where, pick };
    town.tags.push(entry);
    if (radius) town.spots.set(keyOf(pick), { centre: at(where.x, where.z), radius });
    return entry;
  }
  const lamp = (x, y, z, radius) => {
    const made = lampOf(radius);
    made.position.set(x, y, z);
    root.add(made);
    town.lamps.push(made);
    return made;
  };
  /** The lamp a model brings with it, lit and put out like the ones made here. */
  const adopt = (model) => {
    let mesh = model.getObjectByName("lamp");
    if (mesh && !mesh.isMesh) mesh = mesh.getObjectByProperty("isMesh", true);
    if (!mesh || Array.isArray(mesh.material)) return null;
    mesh.material = mesh.material.clone();
    town.lamps.push(mesh);
    return mesh;
  };
  const turning = (model, name, direction) => {
    const part = model.getObjectByName(name);
    return part ? { part, axis: axisIn(part, model, direction), rest: part.quaternion.clone(), home: part.position.clone() } : null;
  };

  // ---- the hall: the hub. Everything that comes in goes round on its carousel until someone comes for it.
  root.add(plaza(0, 0, 14.5));
  rounds.push([0, 0, 17.5]);
  // The rotunda, where its model is there: a wall of sixteen arches with a walkway and a clock over them, open to the
  // sky, for the dome and the works built here. A belt can only come through the middle of one of its arches, so with
  // it the village's belts meet the hall at those; the yards, whose belts come in from every angle, keep the arcade.
  // So does a village with more Agents than the seven arches there are on their side of it.
  const grand = VILLAGE && templates.has("fine_hub") && state.agents.length <= 7;
  const BAY = Math.PI / 8;
  const bays = new Set(); // the arches a belt goes through, counted round from the east
  const through = (angle) => (bays.add(((Math.round(angle / BAY) % 16) + 16) % 16), angle);
  const hall = pickable(grand ? spawn("fine_hub") : templates.has("fine_hall") || templates.has("dome_hall") ? newest("fine_hall", "dome_hall") : roughHall(), { kind: "hall" });
  hall.getObjectByName("glass")?.traverse((part) => {
    if (!part.isMesh) return;
    part.material = floor.glass;
    part.castShadow = false;
    part.userData.flat = true;
    part.renderOrder = 2;
  });
  root.add(hall);
  // The dome is a cage of ribs more than a roof of glass, and what goes on under it is the point of it. The model's own
  // thin ribs, and the tower it has standing in the middle, make way for what is built here.
  const glazed = new THREE.Box3().setFromObject(hall.getObjectByName("glass") ?? hall);
  for (const name of ["ribs", "turntable"]) hall.getObjectByName(name) && (hall.getObjectByName(name).visible = false);
  const under = hubWorks(
    grand ? { radius: 6.9, base: hall.getObjectByName("anchor_dome")?.position.y ?? 3.75, height: 5, glazed: true }
    : hall.getObjectByName("glass") ? { radius: (glazed.max.x - glazed.min.x) / 2, base: glazed.min.y, height: glazed.max.y - glazed.min.y }
    : { radius: 7, base: 3, height: 5.6 },
  );
  root.add(pickable(under.group, { kind: "hall" }));
  town.bulbs.push(...under.bulbs);
  hall.updateMatrixWorld(true);
  town.hall = { model: hall, turntable: under.floor, arms: under.arms, grand, hands: ["hand_hour", "hand_minute"].map((name) => turning(hall, name, new THREE.Vector3(0, 0, 1))), glazing: [], lamp: lamp(0, under.lanternTop + 0.26, 0, 0.32), note: at(0, 0, 13.4), top: at(0, 0, 7.4), tag: label(at(0, 0, under.lanternTop + 1.3), { kind: "hall" }, 15.5, "big") };
  // Cards wait at the south door for a channel to take them to the owner; checks asked for wait beside them; what no
  // rule would take is set down on the other side.
  const piles = { outbox: new THREE.Group(), timers: new THREE.Group(), lost: new THREE.Group() };
  for (const [name, x, z] of [["outbox", 3.4, 11.7], ["timers", -3.4, 11.7], ["lost", -10.4, 6.4]]) {
    root.add(block(tint(name === "lost" ? 0xcfd8e0 : 0xcba878), 2.8, name === "lost" ? 0.35 : 0.8, 1.6, x, 0.05, z), piles[name]);
    piles[name].position.set(x - 0.6, name === "lost" ? 0.42 : 0.87, z - 0.1);
  }
  town.outbox = { pile: piles.outbox, top: at(3.4, 11.7, 1.2), gate: at(1.2, 15.2), tag: label(at(3.4, 11.7, 2.7), { kind: "house" }, 0, "small") };
  town.timers = { pile: piles.timers, top: at(-3.4, 11.7, 1.2), tag: label(at(-3.4, 11.7, 2.7), { kind: "timers" }, 2.6, "small") };
  town.lost = { pile: piles.lost, top: at(-10.4, 6.4, 0.8), tag: label(at(-10.4, 6.4, 2.6), { kind: "lost" }, 2.6, "small") };

  // ---- to the west, a works for each project: one machine to a rule, and a belt from each to the hall
  const fromOf = (line) => (line.source === "schedule" ? "定时任务" : (state.sources.find((source) => source.id === line.source)?.name ?? line.source));
  const projectOf = (line) => state.projects?.[line.name] ?? fromOf(line);
  const works = new Map();
  for (const line of state.lines) works.set(projectOf(line), [...(works.get(projectOf(line)) ?? []), line]);
  if (VILLAGE) village();
  else yards();
  /** The works as yards in a row down the west side: a machine to a rule, and a belt from each straight to the hall. */
  function yards() {
    const deep = [...works.values()].map((lines) => Math.max(15, lines.length * 7 + 4.5));
    let cursor = -(deep.reduce((sum, each) => sum + each, 0) + (works.size - 1) * 7) / 2;
    const standing = [];
    [...works].forEach(([name, lines], index) => {
      const [z0, z1] = [cursor, cursor + deep[index]];
      cursor = z1 + 7;
      const colour = SOURCE_TINTS[index % SOURCE_TINTS.length];
      root.add(slab(-50, z0, -23.5, z1, floor.tiles), block(floor.edge, 26.9, 0.14, 0.4, -36.75, 0, z0 - 0.2), block(floor.edge, 26.9, 0.14, 0.4, -36.75, 0, z1 + 0.2), block(floor.edge, 0.4, 0.14, z1 - z0 + 0.8, -50.2, 0, (z0 + z1) / 2));
      rects.push([-52.5, z0 - 2.5, -21.5, z1 + 2.5]);
      const office = pickable(templates.has("fine_workshop") || templates.has("workshop") ? newest("fine_workshop", "workshop") : group(box("wall", 6, 2.8, 4.5), gable("roof_station", 6.6, 1.8, 5, 0, 2.8)), { kind: "project", id: name });
      office.position.set(-43.5, 0, z0 + 4.6);
      office.scale.setScalar(1.25);
      for (const roof of [...paints(office, "roof_blue"), ...paints(office, "roof_station")]) roof.color.setHex(colour);
      root.add(office);
      if (templates.has("bench")) root.add(spawn("bench").translateX(-36.5).translateZ(z0 + 2));
      const tag = label(at(-43.5, z0 + 4.6, 7.6), { kind: "project", id: name }, 6, "big");
      for (const [x, z, y] of [[-37.2, z0 + 3, 0], [-36, z0 + 3.4, 0], [-36.6, z0 + 3.2, 1], [-47.4, z1 - 2.6, 0], [-46.2, z1 - 2.2, 0]]) root.add(spawn("crate").translateX(x).translateY(y + 0.05).translateZ(z));
      const light = newest("town_lamp", "lamp").translateX(-48.4).translateZ(z0 + 1.6);
      root.add(light);
      town.bulbs.push(...paints(light, "bulb"));
      town.projects.push({ name, colour, lines, tag, office, z0, z1 });
      // A walkway down the works, between the stores and the machines.
      root.add(slab(-37.9, z0 + 5, -35.7, z1 - 1.5, floor.lane, 0.06, 1), slab(-38.03, z0 + 5, -37.9, z1 - 1.5, floor.line, 0.062, 1), slab(-35.7, z0 + 5, -35.57, z1 - 1.5, floor.line, 0.062, 1));
      lines.forEach((line, row) => standing.push({ line, colour, project: name, z: z0 + (deep[index] - (lines.length - 1) * 7) / 2 + row * 7 }));
    });
    const fan = Math.min(Math.PI / 8, (Math.PI * 0.67) / Math.max(1, standing.length));
    standing.forEach(({ line, colour, project, z }, index) => {
      const timed = line.source === "schedule";
      const kind = timed ? "machine_clock" : ["machine_press", "machine_tank", "machine_console"][index % 3];
      const machine = pickable(templates.has(finest(kind)) ? spawn(finest(kind)) : roughMachine(colour), { kind: "rule", id: line.name });
      machine.position.set(-28.6, 0, z);
      machine.scale.setScalar(1.45);
      root.add(machine);
      machine.updateMatrixWorld(true);
      // Paint on the floor: a striped frame round three sides of the machine, open where its belt leaves, and its number.
      for (const [x0, z0, x1, z1] of [[-31.3, z - 2.6, -26, z - 2.3], [-31.3, z + 2.3, -26, z + 2.6], [-31.3, z - 2.3, -31, z + 2.3]]) root.add(slab(x0, z0, x1, z1, floor.hazard, 0.062, 1.1));
      const bay = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2), numeral(String(index + 1).padStart(2, "0")));
      bay.position.set(-32.6, 0.064, z - 0.9);
      bay.receiveShadow = true;
      root.add(bay);
      const angle = Math.PI - (index - (standing.length - 1) / 2) * fan;
      const out = at(-26.2, z);
      const door = rim(angle, 7.8);
      const reach = out.distanceTo(door) * 0.45;
      const way = new THREE.CurvePath();
      way.add(new THREE.CubicBezierCurve3(out, at(out.x + reach, z), at(door.x + Math.cos(angle) * reach, door.z + Math.sin(angle) * reach), door));
      way.add(new THREE.LineCurve3(door, rim(angle, 4.85)));
      const belt = beltOf(way);
      root.add(belt.group);
      town.belts.push(belt);
      town.lanes.set(line.name, {
        machine, belt, angle, colour, project, timed, boost: 0, lamp: adopt(machine) ?? lamp(-28.6, 3.6, z, 0.3),
        press: turning(machine, "press", new THREE.Vector3(0, 1, 0)), spin: turning(machine, "spin", new THREE.Vector3(0, 1, 0)),
        hands: ["hand_hour", "hand_minute"].map((name) => turning(machine, name, new THREE.Vector3(0, 0, 1))),
        note: at(-28.6, z, 8.2), tag: label(at(-28.6, z, 6.4), { kind: "rule", id: line.name }, 4),
      });
    });
  }
  /**
   * The works as a village: a plot for each rule along the side streets, with its own house and its machine, and belts
   * that run down the streets and join, so that one comes into the hall from the north side of the main street and one
   * from the south. A project's plots keep together and share a roof colour.
   */
  function village() {
    // Where a belt turns in toward the hall, and how far off the main street's middle that puts it.
    const TURN = grand ? 9.4 : 7.8;
    const [RIB, STEP, FRONT, DEPTH, WIDE, GAP, NEAR, LANE, TRUNK] = [-41, 46, 4.6, DEPTH_OF_PLOT, 13, 4.5, 9.5, 2.4, grand ? TURN * Math.sin(BAY) : 2.4];
    const style = { half: 0.5, slim: true, rail: PLAIN ? floor.trim : capped(0xe6c473) };
    /** A belt others run into: it moves while anything rides any of the ways that go over it. */
    const shared = (belt) => {
      const users = [];
      Object.defineProperty(belt, "moving", { get: () => users.reduce((sum, way) => sum + way.moving, 0) });
      return Object.assign(belt, { users });
    };
    // Each plot takes the place nearest the hall that is still free. A column is one side of a side street, north or
    // south of the main street, built up outward plot by plot; a street further out costs about a plot more. A plot
    // of the same project as the one before it would much rather be across its street from that one or next to it,
    // and failing that across the main street: so a project is a stretch of one street, both sides of it.
    const columns = new Map();
    const SIDES = [[-1, 1], [1, 1], [-1, -1], [1, -1]]; // [north or south of the main street, west or east of its own]
    [...works].forEach(([name, lines], index) => {
      const colour = SOURCE_TINTS[index % SOURCE_TINTS.length];
      const record = { name, colour, lines, tag: null, windows: [] };
      town.projects.push(record);
      let last = null;
      for (const line of lines) {
        let best = null;
        for (let rib = 0; rib < 12; rib++) {
          for (const [half, side] of SIDES) {
            const key = `${rib}:${half}:${side}`;
            let cost = (columns.get(key)?.reach ?? NEAR) + rib * 18;
            if (last?.rib === rib) cost -= last.half !== half ? 10 : last.side === side ? 34 : 30;
            if (!best || cost < best.cost - 0.001) best = { key, rib, half, side, cost };
          }
        }
        if (!columns.has(best.key)) columns.set(best.key, { half: best.half, side: best.side, street: RIB - best.rib * STEP, reach: NEAR, lanes: [] });
        const column = columns.get(best.key);
        const from = column.reach;
        column.reach += WIDE + GAP;
        last = best;
        // The plot: paved, edged on the three sides away from the street; its house at the back, its machine in front.
        const { street, half, side } = column;
        const inward = (deep) => street + side * (FRONT + deep);
        const [z0, z1] = half < 0 ? [-(from + WIDE), -from] : [from, from + WIDE];
        const [x0, x1] = [Math.min(inward(0), inward(DEPTH)), Math.max(inward(0), inward(DEPTH))];
        const sort = trade(line, state.sources);
        root.add(slab(x0, z0, x1, z1, PLAIN || ["code", "alarm"].includes(sort) ? floor.tiles : floor.warm), block(floor.edge, DEPTH + 0.8, 0.14, 0.4, (x0 + x1) / 2, 0, z0 - 0.2), block(floor.edge, DEPTH + 0.8, 0.14, 0.4, (x0 + x1) / 2, 0, z1 + 0.2), block(floor.edge, 0.4, 0.14, WIDE + 0.8, inward(DEPTH + 0.2), 0, (z0 + z1) / 2));
        rects.push([x0 - 2, z0 - 2, x1 + 2, z1 + 2]);
        const model = PLAIN ? null : BUILDINGS[sort];
        const own = templates.has(model);
        const house = pickable(own ? spawn(model) : templates.has("fine_workshop") || templates.has("workshop") ? newest("fine_workshop", "workshop") : group(box("wall", 6, 2.8, 4.5), gable("roof_station", 6.6, 1.8, 5, 0, 2.8)), { kind: "rule", id: line.name });
        if (own) town.bulbs.push(...paints(house, "bulb"));
        const homeZ = half * (from + 4.3);
        house.position.set(inward(10.4), 0, homeZ);
        house.rotation.y = (-side * Math.PI) / 2;
        for (const roof of [...paints(house, "roof_blue"), ...paints(house, "roof_station")]) roof.color.setHex(colour);
        root.add(house);
        record.windows.push(...paints(house, "window"));
        const z = half * (from + 9.7);
        lots.push({ x0, x1, z0, z1, side, half, inward, homeZ, z, own });
        column.lanes.push({ line, colour, project: name, z, house });
      }
    });
    // The streets: one from the hall out through the village, and a side street wherever a column stands.
    const sand = (x0, z0, x1, z1) => (sandy.push([x0, z0, x1, z1]), root.add(slab(x0, z0, x1, z1, floor.path, 0.035)));
    const roundEnd = (x, z, radius) => (root.add(patch(x, z, radius, floor.path, 0.035)), town.paved.push([x, z, radius]), rounds.push([x, z, radius + 1.5]));
    const reaches = new Map();
    for (const column of columns.values()) reaches.set(`${column.street}:${column.half}`, Math.max(reaches.get(`${column.street}:${column.half}`) ?? 0, column.reach - GAP + 3));
    if (columns.size) {
      const west = Math.min(...[...columns.values()].map((column) => column.street)) - 4;
      sand(west, -5, -14.2, 5);
      roundEnd(west, 0, 5);
    }
    for (const [key, reach] of reaches) {
      const [street, half] = key.split(":").map(Number);
      sand(street - 4, half < 0 ? -reach : 5, street + 4, half < 0 ? -5 : reach);
      roundEnd(street, half * reach, 4);
    }
    // The belts. On each side of the main street the column furthest west carries on down it into the hall; every
    // other column on that side comes into that one from the side, and each machine's short belt comes into its
    // column's the same way: by an opening in the rail, where the belt that comes in stops.
    const order = new Map(state.lines.map((line, index) => [line.name, index]));
    const [HALF, MEET] = [style.half, style.half + 0.2];
    for (const half of [-1, 1]) {
      const mine = [...columns.values()].filter((column) => column.half === half && column.lanes.length).sort((a, b) => a.street + a.side * LANE - (b.street + b.side * LANE));
      const angle = grand ? Math.PI - half * BAY : Math.PI - half * 0.313;
      if (mine.length) through(angle);
      const [door, end] = [rim(angle, TURN), rim(angle, 4.85)];
      const laneOf = (column) => column.street + column.side * LANE;
      const startOf = (column) => at(laneOf(column), half * (Math.max(...column.lanes.map(({ z }) => Math.abs(z))) + 1.6));
      const machineAt = (column) => column.street + column.side * (FRONT + 3.4);
      // Where each belt runs. The first column's is the trunk.
      const ways = mine.map((column, index) => (index ? route([startOf(column), at(laneOf(column), half * (TRUNK + HALF))], 0) : route([startOf(column), at(laneOf(column), half * TRUNK), door, end], [0, 1.8, 1.4, 0])));
      const made = mine.map((column, index) => {
        const way = ways[index];
        // Openings: for each of its own machines, and in the trunk for each column that comes into it.
        const gaps = column.lanes.map(({ z }) => [farOf(way, at(laneOf(column), z)), column.side * half, MEET]);
        if (!index) for (const other of mine.slice(1)) gaps.push([farOf(way, at(laneOf(other), half * TRUNK)), half, MEET]);
        const belt = shared(beltOf(way, { ...style, gaps }));
        root.add(belt.group);
        town.belts.push(belt);
        return belt;
      });
      mine.forEach((column, at0) => {
        const [lane, collector, trunk] = [laneOf(column), made[at0], made[0]];
        for (const { line, colour, project, z, house } of column.lanes) {
          const index = order.get(line.name);
          const timed = line.source === "schedule";
          const sort = trade(line, state.sources);
          const kind = sort === "clock" ? "machine_clock" : !PLAIN && templates.has(`machine_${sort}`) ? `machine_${sort}` : ["machine_press", "machine_tank", "machine_console"][index % 3];
          const machine = pickable(templates.has(finest(kind)) ? spawn(finest(kind)) : roughMachine(colour), { kind: "rule", id: line.name });
          for (const roof of paints(machine, "roof_blue")) roof.color.setHex(colour);
          const x = machineAt(column);
          const out = -column.side; // which way along x its belt leaves: toward the street
          machine.position.set(x, 0, z);
          machine.rotation.y = out > 0 ? 0 : Math.PI;
          machine.scale.setScalar(1.45);
          root.add(machine);
          machine.updateMatrixWorld(true);
          // Paint on the floor: a striped frame round three sides of the machine, open where its belt leaves, and its number.
          const span = (a, b) => [Math.min(x + out * a, x + out * b), Math.max(x + out * a, x + out * b)];
          for (const [[x0, x1], z0, z1] of [[span(-2.7, 2.2), z - 2.6, z - 2.3], [span(-2.7, 2.2), z + 2.3, z + 2.6], [span(-2.7, -2.4), z - 2.3, z + 2.3]]) root.add(slab(x0, z0, x1, z1, floor.hazard, 0.062, 1.1));
          const bay = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2), numeral(String(index + 1).padStart(2, "0")));
          bay.position.set(x - out * 4, 0.064, z - 0.9);
          bay.receiveShadow = true;
          root.add(bay);
          const from = at(x + out * 2.4, z);
          const branch = shared(beltOf(route([from, at(lane + column.side * HALF, z)], 0), style));
          root.add(branch.group);
          town.belts.push(branch);
          // What a parcel rides: its machine's belt, round into the column's, and (for any column but the first) round
          // into the trunk; then down the main street and in at the hall's door.
          const stops = at0 ? [from, at(lane, z), at(lane, half * TRUNK), door, end] : [from, at(lane, z), at(lane, half * TRUNK), door, end];
          const way = route(stops, at0 ? [0, 0.8, 0.8, 1.4, 0] : [0, 0.8, 1.8, 1.4, 0]);
          const riding = { curve: way, length: way.getLength(), moving: 0 };
          for (const belt of new Set([branch, collector, trunk])) belt.users.push(riding);
          town.lanes.set(line.name, {
            machine, belt: riding, angle, colour, project, timed, boost: 0, lamp: adopt(machine) ?? lamp(x, 3.6, z, 0.3),
            press: turning(machine, "press", new THREE.Vector3(0, 1, 0)), spin: turning(machine, "spin", new THREE.Vector3(0, 1, 0)),
            hands: ["hand_hour", "hand_minute"].map((name) => turning(machine, name, new THREE.Vector3(0, 0, 1))),
            note: at(x, z, 8.2), tag: label(at(x, z, 6.4), { kind: "rule", id: line.name }, 4),
            house, gears: ["gear_big", "gear_small"].map((name) => turning(house, name, new THREE.Vector3(1, 0, 0))),
            dish: turning(house, "dish", new THREE.Vector3(0, 1, 0)), bell: turning(house, "bell", new THREE.Vector3(1, 0, 0)), heading: 0, aim: 0, rang: -1e9,
            vent: turning(house, "vent", new THREE.Vector3(0, 1, 0)), beacon: turning(house, "beacon", new THREE.Vector3(0, 1, 0)), signal: adopt(house),
          });
          const hands = ["hand_hour", "hand_minute"].map((name) => turning(house, name, new THREE.Vector3(0, 0, 1)));
          if (hands.every(Boolean)) town.clocks.push(...hands);
          const { signal } = town.lanes.get(line.name);
          if (signal) {
            const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffMap, color: TONE.crit, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
            house.updateMatrixWorld(true);
            halo.position.copy(root.worldToLocal(new THREE.Box3().setFromObject(signal).getCenter(new THREE.Vector3())));
            halo.scale.setScalar(3.4);
            halo.visible = false;
            halo.userData.flat = true;
            root.add(halo);
            town.lanes.get(line.name).halo = halo;
          }
        }
      });
    }
  }

  // ---- to the east, a stage for each Agent, and a belt from the hall to each
  const spread = Math.min(Math.PI / 5.5, (Math.PI * 0.67) / Math.max(1, state.agents.length));
  const HOME = VILLAGE ? [3, 46] : [9.5, 45]; // where the owner's house stands, unless a belt or a stage has that place
  // With the rotunda each Agent has an arch of its own and stands straight out from it: those through even arches
  // nearer, those through odd ones further, so that neighbours have room. The arches are taken in an order that fills
  // the north-east first and leaves the south-east to the post office and the owner's house; the ones facing due north
  // and due south are the footpaths'.
  const arches = grand ? [0, -1, 1, -2, -3, 2, 3].slice(0, state.agents.length).sort((a, b) => a - b) : [];
  // Where each stage stands: [x, z, the angle its belt leaves the hall at, whether it is one of the fan].
  const stands = state.agents.map((_, index) => {
    const offset = index - (state.agents.length - 1) / 2;
    if (arches[index] === undefined) return [36, offset * 24, offset * spread, false];
    const [angle, far] = [arches[index] * BAY, [34, 54, 38, 58][Math.abs(arches[index])]];
    return [Math.cos(angle) * far, Math.sin(angle) * far, angle, true];
  });
  // The plaza, where its models are there: a stepped dais in a ring of water, columns with lamps round it and a
  // portal with a rose window behind. Without them, two plain discs.
  const formal = !PLAIN && ["agent_plaza", "plaza_column", "plaza_arch"].every((name) => templates.has(name));
  // An Agent is watched from the south-west, from a little above, unless something built would stand in the way of
  // that: another Agent's plaza, the hall, the post office, the house. Then the eye goes round the stage a step at a
  // time, a little to one side and to the other before further, and stops at the first place that nothing is in the
  // way of; and where there is none, at the one with least.
  const watchOf = (index) => {
    const [x, z] = stands[index];
    const from = (swing) => {
      const [cos, sin] = [Math.cos(swing), Math.sin(swing)];
      const swung = ([dx, y, dz]) => [dx * cos + dz * sin, y, dz * cos - dx * sin];
      return { swing, eye: swung(WATCH.eye), at: swung(WATCH.at) };
    };
    // What can stand in the way, each as a round place of some size: a plaza with its columns and portal is all of it.
    const built = [...stands.filter((_, other) => other !== index).map(([ox, oz]) => [ox, oz, formal ? 11 : 6]), [0, 0, 10], [-4.5, 26, 7], [HOME[0] - 1.5, HOME[1], 8]];
    const inWay = ({ eye }) => {
      const [ex, ez, length] = [x + eye[0], z + eye[2], Math.hypot(eye[0], eye[2])];
      const [fx, fz] = [-eye[0] / length, -eye[2] / length];
      // In the way: short of the Agent, and inside what the eye takes in on its way there, which widens as it goes.
      return built.filter(([ox, oz, radius]) => {
        const along = (ox - ex) * fx + (oz - ez) * fz;
        return along > -radius && along < length - 4 && Math.abs((ox - ex) * fz - (oz - ez) * fx) < Math.max(0, along) * 0.36 + radius;
      }).length;
    };
    const tries = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8].map((step) => from((step * Math.PI) / 12));
    return tries.reduce((best, each) => (inWay(each) < inWay(best) ? each : best));
  };
  state.agents.forEach((agent, index) => {
    const [x, z, angle, fanned] = stands[index];
    if (fanned) through(angle);
    // What stands on a stage is set out as seen along the belt that comes to it: this turns such a place to face the hall.
    const turned = fanned ? angle : 0;
    const spot = (dx, dz, y = 0) => at(x + Math.cos(turned) * dx - Math.sin(turned) * dz, z + Math.sin(turned) * dx + Math.cos(turned) * dz, y);
    // What is stacked beyond the figure stands to the right of the belt; to its left on the stages furthest south, where
    // the right is between the figure and the eye.
    const beyond = (dx, dz, y = 0) => spot(dx, arches[index] >= 2 ? -dz : dz, y);
    const watch = watchOf(index);
    const colour = AGENT_TINTS[agent.use] ?? 0x8fa6b8;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.45, 0.17, 8, 64), new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.5, emissive: colour, emissiveIntensity: 0 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0.56, z);
    root.add(plaza(x, z, 10.5), ring);
    if (formal) {
      const dais = pickable(spawn("agent_plaza"), { kind: "agent", id: agent.id });
      dais.position.set(x, 0, z);
      dais.rotation.y = -turned;
      // Its pool is the same water as the pond's: it glints, takes the rain, and freezes over when the pond does.
      dais.getObjectByName("water")?.traverse((part) => {
        if (!part.isMesh) return;
        if (!part.geometry.getAttribute("shore")) part.geometry.setAttribute("shore", new THREE.Float32BufferAttribute(new Float32Array(part.geometry.attributes.position.count).fill(0.42), 1));
        part.material = floor.water;
        part.castShadow = false;
      });
      town.bulbs.push(...paints(dais, "bulb"));
      root.add(dais);
    } else root.add(drum(tint(0xe9e4da), 6.6, 6.8, 0.45, x, 0.05, z, 56), drum(tint(0xf7f4ee), 4.5, 4.6, 0.3, x, 0.5, z, 48));
    rounds.push([x, z, 12]);
    for (const [along, radius] of [[0.45, 7], [0.72, 7.5], [1, 6.5]]) glades.push([x + watch.eye[0] * along, z + watch.eye[2] * along, radius]);
    // A kind of Agent with a figure of its own gets it where that model has been put in models/; none comes with the
    // town. Otherwise the plain robot stands in, painted in the kind's colour so two of them can be told apart.
    const own = agent.use === "claude" ? "agent_claude" : agent.use === "codex" ? "agent_codex" : null;
    const kind = own && templates.has(finest(own)) ? own : "agent_bot";
    const figure = pickable(templates.has(finest(kind)) ? spawn(kind) : roughFigure(agent.use), { kind: "agent", id: agent.id });
    if (kind !== own && AGENT_TINTS[agent.use]) for (const paint of paints(figure, "bot")) paint.color.setHex(colour);
    figure.position.set(x + 0.3, 0.8, z - 0.4);
    // It half faces the eye that watches it.
    figure.rotation.y = -0.4 + watch.swing * 0.75;
    figure.scale.setScalar(1.55);
    root.add(figure);
    const body = figure.getObjectByName("body") ?? figure;
    const spark = figure.getObjectByName("spark");
    if (spark?.isMesh) spark.material = spark.material.clone();
    const door = rim(angle, grand ? 8.6 : 7.8);
    const end = spot(-7, 1.4);
    // In the column a belt to a stage far up or down it turns in toward that stage late, so as not to swing wide.
    const reach = Math.min(door.distanceTo(end) * 0.45, fanned ? Infinity : 14);
    const way = new THREE.CurvePath();
    way.add(new THREE.LineCurve3(rim(angle, 4.85), door));
    way.add(new THREE.CubicBezierCurve3(door, at(door.x + Math.cos(angle) * reach, door.z + Math.sin(angle) * reach), at(end.x - Math.cos(turned) * reach, end.z - Math.sin(turned) * reach), end));
    const belt = beltOf(way, VILLAGE ? { half: 0.5, slim: true, rail: PLAIN ? floor.trim : capped(new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.18).getHex()) } : undefined);
    root.add(belt.group);
    town.belts.push(belt);
    const pallet = new THREE.Group();
    pallet.position.copy(beyond(3.6, 3.9, templates.has("pallet") ? 0.66 : 0.5));
    pallet.rotation.y = -turned;
    if (templates.has("pallet")) {
      const boards = spawn("pallet");
      boards.position.copy(beyond(4.05, 4.35, 0.5));
      boards.rotation.y = -turned;
      root.add(boards);
    }
    root.add(pallet);
    // What stands round a formal plaza is set out by where it is watched from: the eye looks in through a gap between
    // two columns, and the portal stands in the gap straight across, behind the Agent. Where that would put one of the
    // portal's piers in the belt's way it stands astride the belt instead, which then runs in under its window.
    const furniture = { rose: [], over: null, gaps: [], plate: 9.8 };
    if (formal) {
      const mine = { kind: "agent", id: agent.id };
      const eyed = Math.atan2(watch.eye[2], watch.eye[0]) - turned; // the eye's bearing, as the stage is laid out
      const set = (bearing, far, y = 0) => spot(Math.cos(bearing) * far, Math.sin(bearing) * far, y);
      const apart = (one, other) => Math.abs(Math.atan2(Math.sin(one - other), Math.cos(one - other)));
      const inLane = (bearing, far, room) => Math.cos(bearing) * far < 0 && Math.abs(Math.sin(bearing) * far - 1.4) < room;
      const belted = Math.atan2(1.4, -9.6); // where the belt crosses the ring the portal stands on
      const astride = apart(eyed + Math.PI, belted) < 0.46;
      const portalAt = astride ? belted : eyed + Math.PI;
      const portal = pickable(spawn("plaza_arch"), mine);
      portal.position.copy(astride ? spot(-9.6, 1.4) : set(portalAt, 9.6));
      // Its front is turned to the middle of the plaza; astride the belt, square to the belt.
      const out = (astride ? Math.PI : portalAt) + turned;
      portal.rotation.y = Math.atan2(-Math.cos(out), -Math.sin(out));
      furniture.rose = paints(portal, "rose");
      for (const glass of furniture.rose) (glass.color.setHex(colour), glass.emissive.setHex(colour));
      town.bulbs.push(...paints(portal, "bulb"));
      root.add(portal);
      const posts = Array.from({ length: 8 }, (_, index) => eyed + Math.PI / 8 + (index * Math.PI) / 4).filter((bearing) => !inLane(bearing, 9.4, 1.5) && apart(bearing, portalAt) > 0.33);
      scatter(root, "plaza_column", posts.map((bearing) => new THREE.Matrix4().compose(set(bearing, 9.4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(bearing + turned)), new THREE.Vector3(1, 1, 1))), mine);
      // Seats at the sides and planters in the other gaps between the columns; the gap the eye looks in through is left open.
      for (const gap of [1, 2, 3, 4, 5, 6, 7]) {
        const bearing = eyed + (gap * Math.PI) / 4;
        if (!inLane(bearing, 9.3, 2.2) && apart(bearing, portalAt) > 0.5) furniture.gaps.push({ at: set(bearing, 9.3), bearing: bearing + turned, seat: gap === 2 || gap === 6 });
      }
      figure.updateMatrixWorld(true);
      const hub = spark ? spark.getWorldPosition(new THREE.Vector3()) : at(figure.position.x, figure.position.z, new THREE.Box3().setFromObject(figure).max.y + 1.9);
      furniture.over = orrery(colour, hub.y - 0.8, 2.8);
      furniture.over.group.position.copy(hub);
      root.add(furniture.over.group);
      furniture.plate = Math.max(9.8, hub.y + 2.9);
    }
    town.agents.set(agent.id, {
      figure, body, spark, ring, belt, angle, colour, pallet, baseY: body.position.y, facing: body.rotation.y, at: at(x, z), rest: spot(-4.6, 2.6, 0.5), aside: new THREE.Vector3(-Math.sin(turned), 0, Math.cos(turned)), beyond, watch,
      rose: furniture.rose, over: furniture.over, gaps: furniture.gaps,
      loads: new Map(), rounds: new Map(), hopped: -1e9, twirled: -1e9, beat: -1e9, sparkY: spark?.position.y ?? 0, busy: false, online: true, note: at(x, z, 12), tag: label(at(x, z, furniture.plate), { kind: "agent", id: agent.id }, 7.4, "big"),
    });
  });

  if (grand) {
    const out = hall.getObjectByName("anchor_bay")?.position.x ?? 7.4;
    const facing = (angle, far, y = 0, turned = 0) => new THREE.Matrix4().compose(rim(angle, far, y), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 - angle + turned), new THREE.Vector3(1, 1, 1));
    if (templates.has("hub_infill")) {
      scatter(root, "hub_infill", Array.from({ length: 16 }, (_, bay) => bay).filter((bay) => !bays.has(bay)).map((bay) => facing(bay * BAY, out)), { kind: "hall" });
      town.hall.glazing = paints(templates.get("hub_infill"), "window");
    }
    if (templates.has("hub_pigeon")) {
      const rail = hall.getObjectByName("anchor_rail")?.position ?? at(7.82, 0, 3.48);
      // Nothing they do stands for anything: they are only there, as the fish in the pond are.
      scatter(root, "hub_pigeon", [[0.62, 0.3], [0.86, -2.6], [2.5, 1.2], [3.6, 0.2], [4.05, 2.9], [5.2, -0.5], [5.44, 0.9]].map(([angle, turned]) => facing(angle, rail.x, rail.y, turned)));
    }
  }

  // ---- to the south: the post office, which is the channels, and beyond it where the owner lives. A channel comes
  // to the hall for a card, takes it down this path to the owner, and brings the answer back up it.
  const office = pickable(newest("fine_post", "town_post", "postoffice"), { kind: "post" });
  office.position.set(-6.5, 0, 26);
  office.rotation.y = Math.PI / 2;
  office.scale.setScalar(1.2);
  root.add(office, plaza(-4.5, 26, 7.6, 0.045));
  office.updateMatrixWorld(true);
  rounds.push([-4.5, 26, 9.2]);
  const counter = office.getObjectByName("anchor_out")?.getWorldPosition(new THREE.Vector3()).setY(0) ?? at(-1, 26);
  const parked = newest("town_scooter", "scooter");
  parked.position.copy(counter).add(at(0.4, 2.4));
  parked.rotation.y = Math.PI * 0.75;
  root.add(parked);
  town.post = { model: office, out: counter, scooter: parked, away: 0, tag: label(at(-6.5, 26, 7.2), { kind: "post" }, 7.6, "big") };
  // The two footpaths out of town, north and south.
  const footways = [new THREE.CatmullRomCurve3(VILLAGE ? [at(-1, -14.6), at(-6, -30), at(-9, -52), at(-3, -90), at(3, -135)] : [at(0, -14.6), at(-3, -32), at(4, -58), at(-2, -90), at(3, -135)]), new THREE.CatmullRomCurve3([at(-3, 33.5), at(-7, 44), at(-4, 62), at(-12, 84), at(-8, 130)])];
  const trodden = footways.flatMap((curve) => curve.getSpacedPoints(Math.ceil(curve.getLength() / 3)));
  /** Whether a round place of this size, here, would stand clear of what is laid out so far: of what is built, of belts, and of the footpaths by `off` from its middle. */
  const clearAt = (x, z, radius, off = radius) =>
    !rounds.some(([cx, cz, other]) => Math.hypot(x - cx, z - cz) < other + radius - 1.5) &&
    ![...rects, ...sandy].some(([x0, z0, x1, z1]) => x > x0 - radius && x < x1 + radius && z > z0 - radius && z < z1 + radius) &&
    !town.belts.some((belt) => belt.taken.some((point) => Math.hypot(x - point.x, z - point.z) < radius + 1.2)) &&
    !trodden.some((point) => Math.hypot(x - point.x, z - point.z) < off);
  /** Places round the hall, ring after ring outward, each ring taken from this bearing and then by turns to either side of it. */
  const roundabout = (bearing, rings) => rings.flatMap((far) => Array.from({ length: 24 }, (_, turn) => bearing + ((turn % 2 ? 1 : -1) * Math.ceil(turn / 2) * Math.PI) / 12).map((angle) => [Math.cos(angle) * far, Math.sin(angle) * far]));
  const home = pickable(newest("fine_house", "town_house", "house"), { kind: "house" });
  // The house: down the footpath from the post office, its yard against the path, where that is free; else the first
  // clear place round the south of the town. Never where it would stand between an Agent and the eye that watches it.
  const homeFree = ([x, z]) => clearAt(x - 1.5, z, 10.8, 8) && !glades.some(([gx, gz, radius]) => Math.hypot(x - gx, z - gz) < radius + 4.5);
  const homeAt = VILLAGE ? ([HOME, [13.5, 38], [16, 58], ...roundabout(Math.PI / 2, [48, 60, 72])].find(homeFree) ?? HOME) : HOME;
  home.position.set(homeAt[0], 0, homeAt[1]);
  home.rotation.y = -Math.PI / 2;
  home.scale.setScalar(1.15);
  root.add(home, plaza(homeAt[0] - 1.5, homeAt[1], 8.8, 0.045));
  home.updateMatrixWorld(true);
  rounds.push([homeAt[0] - 1.5, homeAt[1], 10.8]);
  const doorstep = home.getObjectByName("anchor_door")?.getWorldPosition(new THREE.Vector3()).setY(0) ?? at(homeAt[0] - 6, homeAt[1]);
  const letters = new THREE.Group();
  letters.position.copy(doorstep).add(at(0.2, -1.5, 0.15));
  root.add(letters);
  town.house = { model: home, door: doorstep, pile: letters, flag: paints(home, "flag"), tag: label(at(homeAt[0] - 1.5, homeAt[1], 8.4), { kind: "house" }, 8.5, "big") };
  // The postman's rounds: from the office to the hall for a card, down to the house with it, and home again.
  town.mail = { fetch: bend(counter, town.outbox.gate), home: bend(town.outbox.gate, doorstep), back: bend(doorstep, counter) };
  // The notice board: on the grass at the edge of the hall's plaza, to the south-west where that is free of belts and
  // paths, else at the first bearing round it that is; its face turned away from the hall.
  const walkedBy = [...trodden, ...Object.values(town.mail).flatMap((curve) => curve.getSpacedPoints(24))];
  const boardFree = (bearing) => {
    const [x, z] = [Math.cos(bearing) * 16, Math.sin(bearing) * 16];
    return (
      !town.belts.some((belt) => belt.taken.some((point) => Math.hypot(x - point.x, z - point.z) < 3.4)) &&
      !walkedBy.some((point) => Math.hypot(x - point.x, z - point.z) < 3.6) &&
      ![...rects, ...sandy].some(([x0, z0, x1, z1]) => x > x0 - 2.6 && x < x1 + 2.6 && z > z0 - 2.6 && z < z1 + 2.6)
    );
  };
  const boardAt = [2.2, 2.45, 1.95, 1.05, 0.8, 2.7, -2.2, -1.05, -2.6].find(boardFree) ?? 2.2;
  town.board = noticeBoard();
  town.board.group.position.copy(rim(boardAt, 16));
  town.board.group.rotation.y = Math.PI / 2 - boardAt;
  root.add(pickable(town.board.group, { kind: "hall" }));
  glades.push([Math.cos(boardAt) * 16, Math.sin(boardAt) * 16, 2.4]);
  const paths = [town.mail.home, town.mail.fetch, ...footways];
  paths.forEach((curve, index) => {
    const way = new THREE.Mesh(strip(across(curve, 1.6), [-1.25, 0.03 + index * 0.002], [1.25, 0.03 + index * 0.002], 6), floor.path);
    way.receiveShadow = true;
    root.add(way);
  });
  // A pond, with lily pads: north-east of the hall where no belt or stage is in the way, else the first place round the
  // town that is clear, the postman's ways included.
  const walked = [town.mail.home, town.mail.fetch].flatMap((curve) => curve.getSpacedPoints(Math.ceil(curve.getLength() / 4)));
  const pondFree = ([x, z]) => clearAt(x, z, 13.5, 14) && !walked.some((point) => Math.hypot(x - point.x, z - point.z) < 14);
  const pond = VILLAGE ? at(...([[13, -37], [47, 47], [16, -56], [-16, 60], ...roundabout(-Math.PI / 2, [34, 44, 56, 70])].find(pondFree) ?? [13, -37])) : at(-25, 44);
  const shore = Array.from({ length: 10 }, (_, index) => {
    const angle = (index / 10) * Math.PI * 2;
    const far = 7.5 + random() * 3.5;
    return new THREE.Vector2(Math.cos(angle) * far * 1.25, Math.sin(angle) * far);
  });
  // The bed shelves from sand through the shallows into the deep; the surface over it is thin, and shows what swims.
  const outline = new THREE.CatmullRomCurve3(shore.map((point) => new THREE.Vector3(point.x, point.y, 0)), true).getPoints(80).slice(0, 80);
  const chance = seeded(977); // chance for whatever was added later, so that what was here before stays where it was
  for (const [material, reach, y] of [[floor.sand, 1.13, 0.035], [floor.water, 1, 0.16]]) {
    const mesh = new THREE.Mesh(pondFan(outline, 8, reach), material);
    mesh.position.set(pond.x, y, pond.z);
    mesh.receiveShadow = material === floor.sand;
    mesh.renderOrder = material === floor.water ? -1 : 0;
    root.add(mesh);
  }
  const leaves = Array.from({ length: 16 }, () => at(pond.x + (random() - 0.5) * 13, pond.z + (random() - 0.5) * 8, 0.175));
  const pads = new THREE.InstancedMesh(new THREE.CircleGeometry(0.62, 14, 0, Math.PI * 2 - 0.55).rotateX(-Math.PI / 2), tint(0x5fae4a), leaves.length);
  leaves.forEach((leaf, index) => pads.setMatrixAt(index, new THREE.Matrix4().compose(leaf, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), chance() * Math.PI * 2), new THREE.Vector3().setScalar(0.85 + chance() * 0.4))));
  pads.castShadow = true;
  root.add(pads);
  // Nothing in the pond stands for anything: it is only somewhere for the eye to rest. So it is kept small and slow.
  // What it does show is the weather: rain pocks the water and stirs the frogs, snow freezes it over, night slows the fish.
  const life = new THREE.Group();
  root.add(life);
  const fish = [0xf08a3c, 0xfdfaf2, 0xe5533d, 0xf2b33d, 0xf7c9a0].map((colour, index) => {
    const body = new THREE.Group();
    const scales = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.5 });
    const trunk = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8).scale(0.8, 0.42, 2), scales);
    const tail = new THREE.Group();
    tail.position.z = -0.38;
    tail.add(new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.5, 4).rotateX(Math.PI / 2).scale(1, 0.25, 1).translate(0, 0, -0.22), scales));
    // A patch of another colour on most of them, the way carp are marked.
    if (index % 2 === 0) body.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6).scale(0.9, 0.3, 1.1).translate(0, 0.05, 0.12), tint(index ? 0xfdfaf2 : 0xe5533d, 0.5)));
    body.add(trunk, tail);
    body.scale.setScalar(1.5);
    life.add(body);
    return { body, tail, way: random() < 0.5 ? 1 : -1, round: random() * Math.PI * 2, pace: 0.2 + random() * 0.18, middle: [(random() - 0.5) * 5, (random() - 0.5) * 3], reach: [2.4 + random() * 2.2, 1.5 + random() * 1.5], rise: 0 };
  });
  const frogs = [0, 5, 11].map((leaf) => {
    const frog = new THREE.Group();
    const skin = tint(0x4f9f3e, 0.6);
    frog.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8).scale(1, 0.6, 1.2).translate(0, 0.17, 0), skin));
    for (const side of [-0.14, 0.14]) frog.add(ball(tint(0x7cc65a, 0.5), 0.1, side, 0.33, 0.18), ball(tint(0x26331f, 0.4), 0.05, side, 0.36, 0.25));
    frog.scale.setScalar(1.35);
    frog.position.copy(leaves[leaf]);
    frog.rotation.y = random() * Math.PI * 2;
    life.add(frog);
    return { frog, leaf, from: null, to: null, began: 0, next: performance.now() + 4000 + random() * 9000 };
  });
  const rings = Array.from({ length: 14 }, () => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.userData.flat = true;
    ring.visible = false;
    root.add(ring);
    return { ring, born: -1e9 };
  });
  town.pond = { at: pond, leaves, pads, fish, frogs, rings, life, frozen: false, nextDrop: 0 };
  rounds.push([pond.x, pond.z, VILLAGE ? 12.5 : 14]);

  // ---- the ground, and the wood all round
  const land = new THREE.PlaneGeometry(6000, 6000);
  land.rotateX(-Math.PI / 2);
  const earth = new THREE.Mesh(land, ground.grass);
  earth.receiveShadow = true;
  root.add(earth);
  // Snow lies on the grass, under the paving and everything that stands: a white sheet that comes and goes.
  town.blanket = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf6f9fc, roughness: 1, transparent: true, opacity: 0, depthWrite: false }));
  town.blanket.position.y = 0.02;
  town.blanket.receiveShadow = true;
  town.blanket.userData.flat = true;
  town.blanket.visible = false;
  root.add(town.blanket);
  const edges = [...rects, ...sandy, ...rounds.map(([x, z, r]) => [x - r + 2.5, z - r + 2.5, x + r - 2.5, z + r - 2.5])];
  const bounds = edges.reduce((box, [x0, z0, x1, z1]) => [Math.min(box[0], x0), Math.min(box[1], z0), Math.max(box[2], x1), Math.max(box[3], z1)], [0, 0, 0, 0]);
  const busy = [...town.belts.flatMap((belt) => belt.taken), ...paths.flatMap((curve) => curve.getSpacedPoints(Math.ceil(curve.getLength() / 3)))];
  const free = (x, z, room) =>
    !rects.some(([x0, z0, x1, z1]) => x > x0 - room && x < x1 + room && z > z0 - room && z < z1 + room) &&
    !sandy.some(([x0, z0, x1, z1]) => x > x0 - room - 1.5 && x < x1 + room + 1.5 && z > z0 - room - 1.5 && z < z1 + room + 1.5) &&
    !rounds.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) < radius + room) &&
    !glades.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) < radius + room) &&
    !busy.some((point) => Math.hypot(x - point.x, z - point.z) < 3.4 + room);
  const far = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2 + 95;
  const middle = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const grid = new Set();
  const spots = [];
  for (let tries = 0; tries < 9000 && spots.length < 900; tries++) {
    const angle = random() * Math.PI * 2;
    const out = Math.sqrt(random()) * far;
    const [x, z] = [middle[0] + Math.cos(angle) * out * 1.15, middle[1] + Math.sin(angle) * out];
    const cell = `${Math.round(x / 5.2)}:${Math.round(z / 5.2)}`;
    if (grid.has(cell) || !free(x, z, 1.6)) continue;
    grid.add(cell);
    spots.push([x, z]);
  }
  town.leafy = [];
  wood(root, spots, random, town.leafy);
  // Beyond the wood they thin out toward the hills, further apart the further off.
  const beyond = [];
  const thinly = seeded(spots.length + 5150);
  const outer = new Set();
  for (let tries = 0; tries < 9000 && beyond.length < 1300; tries++) {
    const angle = thinly() * Math.PI * 2;
    const out = far * 0.93 + Math.pow(thinly(), 1.7) * (800 - far * 0.93);
    const [x, z] = [middle[0] + Math.cos(angle) * out * 1.15, middle[1] + Math.sin(angle) * out];
    const cell = `${Math.round(x / 8.5)}:${Math.round(z / 8.5)}`;
    if (outer.has(cell) || !free(x, z, 2)) continue;
    outer.add(cell);
    beyond.push([x, z]);
  }
  spinney(root, beyond, town.leafy);
  const blooms = [];
  for (let patchOf = 0; patchOf < 46; patchOf++) {
    const angle = random() * Math.PI * 2;
    const out = 16 + random() * (far * 0.55);
    const [cx, cz] = [middle[0] + Math.cos(angle) * out, middle[1] + Math.sin(angle) * out];
    for (let each = 0; each < 9; each++) {
      const [x, z] = [cx + (random() - 0.5) * 4.5, cz + (random() - 0.5) * 4.5];
      if (free(x, z, 0.2)) blooms.push([x, z, 0.7 + random() * 0.7, random() < 0.75 ? 0x9a7be0 : 0xf3a6c8]);
    }
  }
  const flowers = new THREE.InstancedMesh(limber(new THREE.ConeGeometry(0.2, 1, 6, 3).translate(0, 0.5, 0), (y) => 0.13 * y * y), floor.bloom, blooms.length);
  const hue = new THREE.Color();
  blooms.forEach(([x, z, size, colour], index) => {
    flowers.setMatrixAt(index, new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(size, size, size)));
    flowers.setColorAt(index, hue.setHex(colour));
  });
  flowers.userData.all = blooms.length;
  town.flowers = flowers;
  root.add(flowers);
  // ---- what makes it a place: things lying about the works, set round the plazas, growing at the edges
  const upright = new THREE.Vector3(0, 1, 0);
  const sets = Object.fromEntries(Object.keys(SMALL).map((name) => [name, []]));
  const sit = (name, x, z, { size = 1, y = 0, turn = random() * Math.PI * 2, colour } = {}) =>
    sets[name].push([new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(upright, turn), new THREE.Vector3(size, size, size)), colour]);
  const clearOf = (x, z, room) => !busy.some((point) => Math.hypot(x - point.x, z - point.z) < room);
  const grassy = (x, z) => !sandy.some(([x0, z0, x1, z1]) => x > x0 - 0.6 && x < x1 + 0.6 && z > z0 - 0.6 && z < z1 + 0.6) && !rects.some(([x0, z0, x1, z1]) => x > x0 + 1.8 && x < x1 - 1.8 && z > z0 + 1.8 && z < z1 - 1.8) && !rounds.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) < radius - 1.6) && clearOf(x, z, 1.8);
  const green = () => LEAVES[Math.floor(random() * LEAVES.length)];
  const planter = (x, z) => (sit("pot", x, z, { colour: 0xf1ebe0 }), sit("bush", x, z, { size: 0.62, y: 0.42, colour: green() }));
  const lantern = (x, z) => (sit("post", x, z, { colour: 0xf4f0e8 }), sit("glow", x, z));
  const seat = (x, z, turn) => {
    if (!templates.has("bench")) return;
    const bench = spawn("bench");
    bench.position.set(x, 0.05, z);
    bench.rotation.y = turn;
    root.add(bench);
  };
  /** Things set evenly round a plaza, leaving out wherever a belt or a path comes through. */
  const round = (cx, cz, radius, count, each, start = 0) => {
    for (let index = 0; index < count; index++) {
      const angle = start + (index / count) * Math.PI * 2;
      const [x, z] = [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
      if (clearOf(x, z, 2.1)) each(x, z, angle);
    }
  };
  // Stepping stones down every path.
  for (const curve of paths) {
    across(curve, 1.45).forEach(({ point, side }, index) => {
      const off = (index % 2 ? 0.42 : -0.42) + (random() - 0.5) * 0.3;
      if (Math.hypot(point.x, point.z) > 15 || point.z > 0) sit("stone", point.x + side.x * off, point.z + side.z * off, { size: 0.8 + random() * 0.5, y: 0.035, colour: 0xe6e0d2 });
    });
  }
  // The hall's plaza: lanterns all round the rim, planters and seats inside them.
  round(0, 0, 13.7, 20, lantern, 0.16);
  round(0, 0, 12.2, 10, planter, 0.5);
  round(0, 0, 11.1, 6, (x, z, angle) => seat(x, z, -angle - Math.PI / 2), 1.05);
  // Each Agent's stage: a ring of lanterns, a planter or two, a seat, and boxes by the pallet.
  for (const agent of town.agents.values()) {
    // A formal plaza has its columns for lamps, and its seats and planters in the gaps between them.
    if (agent.over) for (const gap of agent.gaps) gap.seat ? seat(gap.at.x, gap.at.z, -gap.bearing - Math.PI / 2) : planter(gap.at.x, gap.at.z);
    else {
      round(agent.at.x, agent.at.z, 9.7, 12, lantern, 0.26);
      round(agent.at.x, agent.at.z, 8.4, 5, planter, 1.1);
      round(agent.at.x, agent.at.z, 8.2, 3, (x, z, angle) => seat(x, z, -angle - Math.PI / 2), 2.4);
    }
    for (const [dx, dz, dy] of agent.over ? [[4.9, 1.5, 0], [5.75, 1.9, 0], [5.3, 1.7, 0.66]] : [[5.2, 1.6, 0], [6.1, 2.1, 0], [5.6, 1.8, 0.66]]) sit("crate", agent.beyond(dx, dz).x, agent.beyond(dx, dz).z, { y: 0.5 + dy, turn: random() * 0.5, colour: TONE.card });
  }
  round(-4.5, 26, 6.9, 9, lantern, 0.4);
  round(-4.5, 26, 5.9, 4, planter, 1.9);
  round(homeAt[0] - 1.5, homeAt[1], 8.1, 10, lantern, 0.2);
  round(homeAt[0] - 1.5, homeAt[1], 7.1, 5, planter, 0.9);
  // Each works: fenced on three sides, with tanks, barrels and stacked boxes down the side the machines aren't on.
  const fences = [];
  for (const { z0, z1 } of VILLAGE ? [] : town.projects) {
    if (templates.has("fence")) fences.push(...along(at(-50, z0 + 0.1), at(-23.6, z0 + 0.1), 3, "x"), ...along(at(-50, z1 - 0.1), at(-23.6, z1 - 0.1), 3, "x"), ...along(at(-49.9, z0), at(-49.9, z1), 3, "x"));
    for (const [x, z] of [[-49.2, z0 + 0.9], [-24.3, z0 + 0.9], [-49.2, z1 - 0.9], [-24.3, z1 - 0.9]]) lantern(x, z);
    for (let z = z0 + 10.4, row = 0; z < z1 - 2.2; z += 5.4, row++) {
      const kind = row % 3;
      if (kind === 0) {
        root.add(drum(capped(0xf6f0e4), 1.15, 1.2, 2.2, -46.6, 0.05, z, 20), drum(capped(0xd9634f), 1.18, 1.18, 0.34, -46.6, 1.35, z, 20), ball(capped(0xf6f0e4), 1.15, -46.6, 2.25, z));
        for (const offset of [0, 1]) sit("barrel", -44.2 + offset * 1, z + 0.9 - offset * 0.5, { colour: [0x4f93d8, 0xf0a560][offset] });
      } else if (kind === 1) {
        for (const [dx, dz, colour] of [[0, 0, 0x52b788], [1, 0.25, 0x4f93d8], [0.5, 0.95, 0xf0a560], [1.55, 1.05, 0xd9634f]]) sit("barrel", -46.8 + dx, z - 0.5 + dz, { colour });
      } else {
        if (templates.has("pallet")) root.add(spawn("pallet").translateX(-45.9).translateY(0.05).translateZ(z));
        for (const [dx, dz, dy] of [[-0.45, -0.2, 0], [0.45, -0.2, 0], [0, 0.35, 0], [-0.1, -0.1, 0.66]]) sit("crate", -45.9 + dx, z + dz, { y: 0.21 + dy, turn: random() * 0.3, colour: TONE.card });
      }
      planter(-33.4, z + 1.2);
      planter(-40.2, z - 1.6);
    }
  }
  if (fences.length) scatter(root, "fence", fences);
  for (const lane of town.lanes.values()) if (lane.hands.every(Boolean)) town.clocks.push(...lane.hands);
  if (VILLAGE) {
    // Each plot: a lantern at the two back corners, stores beside the house, something green at the front.
    for (const { x0, x1, z0, z1, side, half, inward, homeZ, z, own } of lots) {
      for (const cornerZ of [z0 + 0.8, z1 - 0.8]) lantern(inward(DEPTH_OF_PLOT - 0.8), cornerZ);
      const beside = homeZ + half * 4.6;
      for (const [dx, dz, colour] of [[0, 0, 0x4f93d8], [1, 0.3, 0xf0a560], [0.45, 1, 0x52b788]]) sit("barrel", inward(12.6) - side * dx, beside + half * dz, { colour });
      for (const [dx, dz, dy] of [[0, 0, 0], [0.95, 0.1, 0], [0.4, 0.05, 0.66]]) sit("crate", inward(own ? 5.2 : 7.2) + side * dx, homeZ - half * 2.6 + dz, { y: 0.05 + dy, turn: random() * 0.3, colour: TONE.card });
      planter(inward(1.2), homeZ - half * 3.2);
      if (!own) planter(inward(6.4), homeZ + half * 0.2);
    }
    // Street lamps down both sides of every street, one side a half step on from the other, wherever no belt comes
    // across. They are one model set out many times; at night each has its pool of light on the ground under it.
    const lit = [];
    for (const [x0, z0, x1, z1] of sandy) {
      const long = x1 - x0 > z1 - z0;
      for (const [edge, begin] of [[0.5, 4], [-0.5, 9]]) {
        for (let far = begin; far < (long ? x1 - x0 : z1 - z0) - 2; far += 10) {
          const [x, z] = long ? [x0 + far, edge > 0 ? z0 + edge : z1 + edge] : [edge > 0 ? x0 + edge : x1 + edge, z0 + far];
          const beyond = -Math.sign(edge) * 1.1; // just off the street on that side
          const spot = [[x, z], long ? [x, z + beyond] : [x + beyond, z]].find(([sx, sz]) => clearOf(sx, sz, 1.6) && !rounds.some(([cx, cz, radius]) => Math.hypot(sx - cx, sz - cz) < radius - 3));
          if (spot) lit.push(spot);
        }
      }
    }
    const lampName = ["fine_town_lamp", "town_lamp", "lamp"].find((name) => templates.has(name));
    if (lampName && lit.length) {
      const template = templates.get(lampName);
      template.updateMatrixWorld(true);
      const shared = new Map();
      template.traverse((part) => {
        if (!part.isMesh) return;
        // One material for all the bulbs, so that lighting it lights them all.
        if (!shared.has(part.material)) shared.set(part.material, part.material.clone());
        const many = new THREE.InstancedMesh(part.geometry, shared.get(part.material), lit.length);
        lit.forEach(([x, z], index) => many.setMatrixAt(index, new THREE.Matrix4().makeTranslation(x, 0, z).multiply(part.matrixWorld)));
        many.castShadow = many.receiveShadow = true;
        root.add(many);
      });
      town.bulbs.push(...[...shared.values()].filter((material) => material.name === "bulb"));
      const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), floor.pool, lit.length);
      lit.forEach(([x, z], index) => pools.setMatrixAt(index, new THREE.Matrix4().makeTranslation(x, 0.075, z)));
      pools.userData.flat = true;
      pools.renderOrder = 1;
      root.add(pools);
    }
    // The townsfolk walk the streets, keeping clear of the belts that run along them.
    if (!PLAIN) {
      const ways = sandy.flatMap(([x0, z0, x1, z1]) => {
        const long = x1 - x0 > z1 - z0;
        const [line, from, to] = long ? [(z0 + z1) / 2, x0 + 2.5, x1 - 2.5] : [(x0 + x1) / 2, z0 + 2.5, z1 - 2.5];
        if (to - from < 8) return [];
        const fits = (offset) => {
          for (let far = from; far <= to; far += 2) {
            for (const aside of [-0.55, 0.55]) if (!clearOf(long ? far : line + offset + aside, long ? line + offset + aside : far, 1.2)) return false;
          }
          return true;
        };
        const offset = [0, -0.9, 0.9, -1.6, 1.6].find(fits);
        return offset === undefined ? [] : [{ long, line: line + offset, from, to }];
      });
      town.folk = folkOf(root, ways, random);
    }
  }
  // Shrubs at the edge of every paved place; tufts of grass, and a rock here and there, wherever there's grass.
  for (const [cx, cz, radius] of rounds) {
    for (let each = 0, count = Math.round(radius * 1.5); each < count; each++) {
      const angle = random() * Math.PI * 2;
      const out = radius - 1.3 + random() * 2.2;
      const [x, z] = [cx + Math.cos(angle) * out, cz + Math.sin(angle) * out];
      if (clearOf(x, z, 2.3) && !rounds.some(([ox, oz, other]) => Math.hypot(x - ox, z - oz) < other - 1.7) && !glades.some(([ox, oz, other]) => Math.hypot(x - ox, z - oz) < other)) sit("bush", x, z, { size: 0.7 + random() * 0.7, colour: green() });
    }
  }
  for (const [x0, z0, x1, z1] of rects) {
    for (let each = 0, count = Math.round((x1 - x0 + z1 - z0) * 0.5); each < count; each++) {
      const along = random();
      const [x, z] = random() < 0.5 ? [x0 + along * (x1 - x0), random() < 0.5 ? z0 + 1.1 : z1 - 1.1] : [x0 + 1.1, z0 + along * (z1 - z0)];
      if (clearOf(x, z, 2.3) && !glades.some(([ox, oz, other]) => Math.hypot(x - ox, z - oz) < other)) sit("bush", x, z, { size: 0.7 + random() * 0.6, colour: green() });
    }
  }
  for (let tries = 0, placed = 0; tries < 6000 && placed < 1500; tries++) {
    const angle = random() * Math.PI * 2;
    const out = Math.sqrt(random()) * far * 0.7;
    const [x, z] = [middle[0] + Math.cos(angle) * out * 1.15, middle[1] + Math.sin(angle) * out];
    if (!grassy(x, z)) continue;
    placed += 1;
    if (placed % 22 === 0) sit("rock", x, z, { size: 0.5 + random() * 1.1, colour: 0xbfbbb0 });
    else sit("tuft", x, z, { size: 0.8 + random() * 0.9, colour: random() < 0.5 ? 0x7dbb58 : 0x93cc6c });
  }
  // Reeds along the shore, and a rock or two.
  const bank = new THREE.CatmullRomCurve3(shore.map((point) => new THREE.Vector3(point.x, 0, -point.y)), true);
  for (let each = 0; each < 90; each++) {
    const point = bank.getPointAt(random()).multiplyScalar(0.96 + random() * 0.12);
    if (each % 9 === 0) sit("rock", pond.x + point.x * 1.08, pond.z + point.z * 1.08, { size: 0.7 + random() * 0.9, colour: 0xc9c5b8 });
    else sit("reed", pond.x + point.x, pond.z + point.z, { size: 0.7 + random() * 0.7, colour: random() < 0.3 ? 0x8fb24a : 0x5f9a44 });
  }
  for (const [name, list] of Object.entries(sets)) {
    if (!list.length) continue;
    const many = new THREE.InstancedMesh(SMALL[name], name === "glow" ? floor.glow : ["bush", "tuft", "reed"].includes(name) ? floor.leaf : floor.prop, list.length);
    const hue = new THREE.Color();
    list.forEach(([where, colour], index) => {
      many.setMatrixAt(index, where);
      if (colour !== undefined) many.setColorAt(index, hue.setHex(colour));
    });
    if (["bush", "tuft", "reed"].includes(name)) town.leafy.push({ mesh: many, own: list.map(([, colour]) => colour ?? 0xffffff) });
    many.castShadow = !["tuft", "stone", "glow"].includes(name);
    if (["bush", "reed"].includes(name)) many.customDepthMaterial = windDepth;
    many.receiveShadow = name !== "glow";
    root.add(many);
  }
  for (const [x, z] of [[-10.4, -10.4], [10.4, -10.4], [-10.8, 9.4], [10.8, 9.8], [5.6, 25], [3, 36.4]]) {
    const post = newest("town_lamp", "lamp");
    post.position.set(x, 0, z);
    root.add(post);
    town.bulbs.push(...paints(post, "bulb"));
    const pool = new THREE.PointLight(0xffc878, 0, 34, 1.5);
    pool.position.set(x, 3.6, z);
    root.add(pool);
    town.pools.push(pool);
  }
  town.ring = new THREE.Mesh(new THREE.RingGeometry(0.955, 1, 80), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
  town.ring.rotation.x = -Math.PI / 2;
  town.ring.visible = false;
  town.ring.userData.flat = true;
  root.add(town.ring);

  // ---- turf: tufts of grass wherever nothing is paved, wet or trodden. Only those near the eye are ever drawn.
  {
    const margin = 24;
    const lawn = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
    const plot = 0.5;
    const [columns, lines] = [Math.ceil((lawn[2] - lawn[0]) / plot), Math.ceil((lawn[3] - lawn[1]) / plot)];
    const bare = new Uint8Array(columns * lines);
    /** Marks as bare every plot in a box, or those of them a test picks out. */
    const strike = (x0, z0, x1, z1, test) => {
      const [c0, c1] = [Math.max(0, Math.floor((x0 - lawn[0]) / plot)), Math.min(columns - 1, Math.floor((x1 - lawn[0]) / plot))];
      const [l0, l1] = [Math.max(0, Math.floor((z0 - lawn[1]) / plot)), Math.min(lines - 1, Math.floor((z1 - lawn[1]) / plot))];
      for (let line = l0; line <= l1; line++)
        for (let column = c0; column <= c1; column++)
          if (!test || test(lawn[0] + (column + 0.5) * plot, lawn[1] + (line + 0.5) * plot)) bare[line * columns + column] = 1;
    };
    const within = (x, z, radius) => (px, pz) => Math.hypot(px - x, pz - z) < radius;
    for (const [x0, z0, x1, z1] of rects) strike(x0 + 2, z0 + 2, x1 - 2, z1 - 2);
    for (const [x0, z0, x1, z1] of sandy) strike(x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3);
    for (const [x, z, radius] of town.paved) strike(x - radius - 1, z - radius - 1, x + radius + 1, z + radius + 1, within(x, z, radius + 0.15));
    for (const point of town.belts.flatMap((belt) => belt.taken)) strike(point.x - 1.2, point.z - 1.2, point.x + 1.2, point.z + 1.2, within(point.x, point.z, 1.1));
    for (const curve of paths)
      for (const point of curve.getSpacedPoints(Math.ceil(curve.getLength() / 0.6))) strike(point.x - 1.7, point.z - 1.7, point.x + 1.7, point.z + 1.7, within(point.x, point.z, 1.5));
    strike(pond.x - 19, pond.z - 16, pond.x + 19, pond.z + 16, (px, pz) => insideOf(outline, (px - pond.x) / 1.17, (pond.z - pz) / 1.17));
    const tufts = new Map();
    const tries = Math.round((lawn[2] - lawn[0]) * (lawn[3] - lawn[1]) * 5.5);
    for (let each = 0; each < tries; each++) {
      const [x, z] = [lawn[0] + chance() * (lawn[2] - lawn[0]), lawn[1] + chance() * (lawn[3] - lawn[1])];
      // It thins out toward the edge of where it grows, so that there is no edge to see.
      const edge = Math.min(x - lawn[0], lawn[2] - x, z - lawn[1], lawn[3] - z);
      if (chance() * 14 > edge || bare[Math.floor((z - lawn[1]) / plot) * columns + Math.floor((x - lawn[0]) / plot)]) continue;
      const key = `${Math.floor(x / 18)}:${Math.floor(z / 18)}`;
      if (!tufts.has(key)) tufts.set(key, []);
      tufts.get(key).push(x, z);
    }
    const where = new THREE.Matrix4();
    const turned = new THREE.Quaternion();
    town.turf = [...tufts.values()].map((stand) => {
      const mesh = new THREE.InstancedMesh(TUFT, bladeMaterial, stand.length / 2);
      for (let index = 0; index < stand.length; index += 2) {
        const size = 0.7 + chance() * 0.75;
        mesh.setMatrixAt(index / 2, where.compose(at(stand[index], stand[index + 1]), turned.setFromAxisAngle(upright, chance() * Math.PI * 2), new THREE.Vector3(size, size * (0.8 + chance() * 0.5), size)));
      }
      mesh.receiveShadow = true;
      mesh.userData.flat = true;
      mesh.visible = false;
      mesh.computeBoundingSphere();
      root.add(mesh);
      return { mesh, centre: mesh.boundingSphere.center.clone(), radius: mesh.boundingSphere.radius };
    });
  }
  // ---- what's alive in it: birds wheeling over by day, butterflies at the flowers, fireflies after dark.
  {
    const birds = Array.from({ length: 7 }, (_, index) => ({ round: chance() * Math.PI * 2, far: 22 + chance() * 40, high: 22 + chance() * 12, way: index % 3 ? 1 : -1, beat: chance() * 6, pace: 7 + chance() * 3 }));
    const wings = new THREE.InstancedMesh(WING, feather, birds.length * 2);
    const bodies = new THREE.InstancedMesh(BIRD, feather, birds.length);
    birds.forEach((_, index) => {
      hue.setHex([0xfbf8f0, 0x66758f, 0xfbf8f0, 0x8d98ad, 0x4f5d75][index % 5]);
      for (const [flock, slot] of [[bodies, index], [wings, index * 2], [wings, index * 2 + 1]]) flock.setColorAt(slot, hue);
    });
    const flyers = Array.from({ length: Math.min(16, blooms.length) }, () => {
      const [x, z] = blooms[Math.floor(chance() * blooms.length)];
      return { home: at(x, z, 0.9 + chance() * 0.7), far: 1.2 + chance() * 2, pace: 0.5 + chance() * 0.6, beat: chance() * 20, was: at(x, z), heading: 0 };
    });
    const flutter = new THREE.InstancedMesh(PETAL, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide }), Math.max(1, flyers.length * 2));
    flutter.count = flyers.length * 2;
    flyers.forEach((_, index) => {
      hue.setHex([0xffffff, 0xffd84d, 0xff9ec4, 0x8fc7ff, 0xffa64d][index % 5]);
      flutter.setColorAt(index * 2, hue);
      flutter.setColorAt(index * 2 + 1, hue);
    });
    for (const flock of [wings, bodies, flutter]) ((flock.frustumCulled = false), (flock.castShadow = flock !== flutter), root.add(flock));
    // Fireflies keep to the pond's edge and to the trees nearest the town.
    const close = spots.filter(([x, z]) => Math.hypot(x - middle[0], z - middle[1]) < 78);
    const sparks = Array.from({ length: 70 }, (_, index) => {
      const shoreAt = bank.getPointAt(chance()).multiplyScalar(1.05 + chance() * 0.5);
      const [x, z] = index < 26 || !close.length ? [pond.x + shoreAt.x, pond.z + shoreAt.z] : close[Math.floor(chance() * close.length)].map((value) => value + (chance() - 0.5) * 6);
      return { home: at(x, z, 0.6 + chance() * 2.4), beat: chance() * 50, pace: 0.5 + chance() * 0.9 };
    });
    const glow = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ map: puffMap, size: 1.7, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true }),
    );
    glow.geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(sparks.length * 3), 3));
    glow.geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(sparks.length * 3), 3));
    glow.frustumCulled = false;
    glow.userData.flat = true;
    root.add(glow);
    town.life = { birds, wings, bodies, flyers, flutter, sparks, glow };
  }

  // Rain is streaks and snow is flakes, each falling through the air over the town and starting again at the top.
  const air = { x: [bounds[0] - 30, bounds[2] + 30], z: [bounds[1] - 30, bounds[3] + 30], top: 85 };
  const scattered = (count) => Array.from({ length: count }, () => [air.x[0] + random() * (air.x[1] - air.x[0]), random() * air.top, air.z[0] + random() * (air.z[1] - air.z[0]), random()]);
  const streaks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd6e4f2, transparent: true, opacity: 0.5, depthWrite: false }));
  streaks.geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(1500 * 6), 3));
  const flakes = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, map: puffMap, size: 1.15, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false }));
  flakes.geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(1700 * 3), 3));
  for (const falling of [streaks, flakes]) ((falling.frustumCulled = false), (falling.visible = false), (falling.userData.flat = true), root.add(falling));
  town.air = { ...air, streaks, flakes, drops: scattered(1500), bits: scattered(1700), flashUntil: 0, nextFlash: 0 };
  // Leaves come down in autumn and petals in spring, a few at a time, from the trees that have them to let go.
  const fallen = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 0.26), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide }), 320);
  fallen.count = 0;
  fallen.frustumCulled = fallen.visible = false;
  root.add(fallen);
  // Mist, on a still morning: patches of it over the town and the wood, drifting a little.
  const veil = new THREE.MeshBasicMaterial({ map: mistMap, transparent: true, opacity: 0, depthWrite: false });
  const drifting = seeded(8080);
  const banks = new THREE.Group();
  banks.visible = false;
  town.mist = {
    veil, banks,
    patches: Array.from({ length: 26 }, () => {
      const bank = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), veil);
      const [angle, out] = [drifting() * Math.PI * 2, 18 + Math.sqrt(drifting()) * (far + 60)];
      bank.position.set(middle[0] + Math.cos(angle) * out * 1.15, 1.5 + drifting() * 3.2, middle[1] + Math.sin(angle) * out);
      bank.scale.set(70 + drifting() * 80, 1, 46 + drifting() * 50);
      bank.rotation.y = drifting() * Math.PI;
      bank.userData.flat = true;
      bank.renderOrder = 3;
      banks.add(bank);
      return { bank, home: bank.position.clone(), beat: drifting() * 40 };
    }),
  };
  root.add(banks);
  town.air.leaves = { mesh: fallen, from: [], each: Array.from({ length: 320 }, () => ({ x: 0, y: -1, z: 0, pace: 1, spin: 1, turn: 0, beat: 0, lain: 0, rest: Math.random() * 9 })) };
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2 + 30;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 20, far: 700 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.set(middle[0], 0, middle[1]);
  town.frame = { middle, bounds, boxes: edges };
  clouds.middle.value.set(middle[0], middle[1]);
  overview(false);
  restyle();
  pace.since = performance.now() + 5000;
  pace.frames = 0;
}

/**
 * The whole town in view, from the south and well above, whatever its size and the window's shape: as near as the eye
 * can come with every corner of the town still in the picture, clear of the list where that is out.
 */
function overview(smooth = true) {
  const { middle, bounds } = town.frame;
  const target = new THREE.Vector3(middle[0], 0, middle[1] - 1);
  const toward = new THREE.Vector3(-0.1, 0.74, 0.66).normalize();
  const probe = camera.clone();
  const left = -0.95 + (!calm.on && holder.clientWidth > 1100 ? 700 / holder.clientWidth : 0);
  // What has to be in the picture: the corners of what is built, on the ground and at roof height.
  const corners = (town.frame.boxes ?? [bounds]).flatMap(([x0, z0, x1, z1]) => [x0, x1].flatMap((x) => [z0, z1].flatMap((z) => [0, 6].map((y) => new THREE.Vector3(x, y, z)))));
  const seen = new THREE.Vector3();
  const fits = (far) => {
    probe.position.copy(toward).multiplyScalar(far).add(target);
    probe.lookAt(target);
    probe.updateMatrixWorld(true);
    return corners.every((corner) => (seen.copy(corner).project(probe), seen.x > left && seen.x < 0.96 && seen.y > -0.93 && seen.y < 0.88));
  };
  let [near, far] = [20, 1500];
  for (let step = 0; step < 24; step++) {
    const mid = (near + far) / 2;
    if (fits(mid)) far = mid;
    else near = mid;
  }
  town.frame.far = far;
  const eye = toward.clone().multiplyScalar(far).add(target);
  if (!smooth) return void (controls.target.copy(target), camera.position.copy(eye), controls.update());
  const [fromEye, fromTarget] = [camera.position.clone(), controls.target.clone()];
  tween(0.7, (t) => (camera.position.lerpVectors(fromEye, eye, t), controls.target.lerpVectors(fromTarget, target, t)));
}

function restyle() {
  const now = (lit.now = lookAt(timeNow()));
  lit.stamp = stampOf(now);
  // Snow lies when it is falling, and for as long after as the weather service says there is snow on the ground there.
  const lying = !weather.preview && (weather.live?.snowDepth ?? 0) >= 0.01 ? 1 : 0;
  const sky = { ...SKIES[skyNow()], snow: Math.max(SKIES[skyNow()].snow, lying) };
  const dull = sky.wet || sky.snow || sky.sun < 0.6;
  scene.fog.color.setHex(now.horizon).lerp(new THREE.Color(sky.snow ? 0xe6edf4 : 0xb4c0c4).lerp(new THREE.Color(0x202a4a), now.glow), dull ? 0.55 : 0);
  // Mist gathers only where nothing is falling, and a fog has no need of it.
  const mist = sky.fall || skyNow() === "fog" ? 0 : now.mist;
  scene.fog.color.lerp(new THREE.Color(0x7f88a8).lerp(new THREE.Color(0xf6eee2), now.light), mist * 0.45);
  // The sky comes down to the colour the plain fades into, and is the greyer overhead the less sun there is.
  paintSky({ ...now, horizon: scene.fog.color.getHex(), top: new THREE.Color(now.top).lerp(scene.fog.color, dull ? 0.6 : sky.sun < 1 ? 0.25 : mist * 0.4).getHex() }, calendar.play !== null);
  hemi.color.setHex(now.sky);
  hemi.groundColor.setHex(now.earth);
  hemi.intensity = now.hemi * sky.hemi;
  sun.color.setHex(now.sun);
  sun.intensity = now.sunPower * sky.sun;
  sun.position.set(...now.sunFrom).normalize().multiplyScalar(320).add(sun.target.position);
  renderer.toneMappingExposure = now.exposure * sky.exposure;
  // Wet ground is darker and shines; snow whitens what it lies on.
  const damp = new THREE.Color(1, 1, 1).multiplyScalar(1 - sky.wet * 0.17);
  // The turf is at its freshest in spring, yellows in autumn and is straw in winter.
  const turfOf = [[1.03, 1.06, 0.94], [1, 1, 1], [1.17, 0.96, 0.9], [1.22, 0.9, 1.12]];
  const turf = new THREE.Color().setRGB(...[0, 1, 2].map((channel) => now.season.reduce((sum, share, index) => sum + share * turfOf[index][channel], 0)));
  ground.grass.color.setHex(now.grass).multiply(damp).multiply(turf);
  for (const material of [floor.radial, floor.tiles, floor.warm, floor.path, floor.edge, floor.sand, floor.hazard, floor.line, ...numerals.values()]) {
    material.color.setHex(now.plaza).multiply(damp);
    material.roughness = THREE.MathUtils.lerp(0.92, 0.42, sky.wet);
  }
  floor.water.color.setHex(sky.snow ? (now.dark ? 0x8296c8 : 0xd3e8f3) : now.water);
  floor.water.roughness = sky.snow ? 0.4 : 0.08;
  if (town?.pond) {
    town.pond.frozen = sky.snow > 0;
    town.pond.life.visible = !town.pond.frozen;
    // Frost on the lily pads: bright green on ice reads as a mistake.
    town.pond.pads.material.color.setHex(town.pond.frozen ? (now.dark ? 0x7d92ae : 0xb9d1b6) : 0x5fae4a).lerp(new THREE.Color(0x8d8f55), town.pond.frozen ? 0 : now.season[2] * 0.3 + now.season[3] * 0.7);
  }
  floor.leaf.color.setHex(now.leaf);
  floor.prop.color.setHex(now.plaza);
  floor.glow.emissiveIntensity = now.glow * (sky.snow ? 1.1 : 1.7);
  if (bloom) ((bloom.enabled = now.bloom > 0), (bloom.strength = now.bloom * (sky.snow ? 0.55 : 0.8)));
  wind.gust.value = GUSTS[skyNow()] ?? 1;
  pondLook.ice.value = sky.snow > 0 ? 1 : 0;
  pondLook.snow.value = sky.snow;
  pondLook.chop.value = sky.fall === "rain" ? (skyNow() === "storm" ? 2.6 : 2) : sky.fall === "drizzle" ? 1.5 : 1;
  pondLook.sun.value = now.dark ? 0.4 : sky.sun >= 0.75 ? 1 : sky.sun >= 0.5 ? 0.45 : 0.15;
  bladeMaterial.color.copy(ground.grass.color);
  blades.snow.value = sky.snow;
  floor.bloom.color.setHex(now.leaf);
  floor.lane.color.setHex(0x6aa98c).multiply(floor.tiles.color);
  // Clouds throw their shade only when the sun is out to be hidden: a few on a clear day, more when it's cloudy.
  stars.material.opacity = now.glow * now.glow * (dull ? 0.12 : sky.sun < 1 ? 0.5 : 1) * (1 - mist);
  stars.visible = stars.material.opacity > 0.02;
  clouds.dark.value = sky.sun < 0.75 ? 0 : 0.26 * now.light;
  clouds.cover.value = sky.sun < 1 ? 0.46 : 0.55;
  cloudShade.visible = clouds.dark.value > 0;
  if (!town) return;
  const reach = town.frame?.far ?? 230;
  const haze = [THREE.MathUtils.lerp(sky.haze[0], 0.8, mist * 0.85), THREE.MathUtils.lerp(sky.haze[1], 2.1, mist * 0.85)];
  scene.fog.near = reach * haze[0];
  scene.fog.far = reach * haze[1];
  paintDistance(now, sky.snow, THREE.MathUtils.smoothstep(haze[1], 1.7, 3.4) * (dull ? 0.75 : 1));
  town.mist.banks.visible = mist > 0.01;
  town.mist.veil.opacity = mist * 0.36;
  town.mist.veil.color.setHex(0x8f98b8).lerp(new THREE.Color(0xfffaf0), now.light);
  town.exposure = renderer.toneMappingExposure;
  town.blanket.visible = sky.snow > 0;
  town.blanket.material.opacity = sky.snow * 0.86;
  const dressed = `${now.season.map((share) => Math.round(share * 48))}:${sky.snow}`;
  if (town.dressed !== dressed) {
    town.dressed = dressed;
    const white = new THREE.Color(0xf4f7fb);
    dress(sky.snow);
    // Hedges, creepers and window boxes that came with a building frost over like everything else that grows.
    for (const model of [town.house.model, town.post.model]) {
      for (const material of paints(model, "green")) {
        material.userData.own ??= material.color.getHex();
        material.color.setHex(material.userData.own).lerp(white, sky.snow * 0.62);
      }
    }
  }
  town.air.streaks.visible = sky.fall === "rain" || sky.fall === "drizzle";
  town.air.streaks.material.opacity = sky.fall === "drizzle" ? 0.3 : 0.5;
  town.air.streaks.geometry.setDrawRange(0, (sky.fall === "drizzle" ? 550 : 1500) * 2);
  town.air.flakes.visible = sky.fall === "snow";
  // Birds and butterflies keep out of the rain and the dark; fireflies come out when it's dark and dry.
  const fair = !sky.fall && !still.matches;
  town.life.wings.visible = town.life.bodies.visible = fair && !now.dark;
  town.life.flutter.visible = fair && !now.dark && sky.sun >= 0.5 && now.season[3] < 0.5;
  town.life.glow.visible = fair && now.dark;
  for (const bulb of town.bulbs) (bulb.emissive.setHex(0xffd98a), (bulb.emissiveIntensity = now.glow * 1.7));
  town.board.face.emissiveIntensity = now.glow * 0.42;
  for (const pool of town.pools) pool.intensity = now.glow * (sky.snow ? 24 : 50);
  floor.pool.opacity = now.glow * 0.5;
  floor.pool.visible = now.glow > 0.01;
  town.blanket.material.color.setHex(0xf6f9fc).lerp(new THREE.Color(0xbfcbe8), now.glow);
  town.ring.material.color.setHex(now.dark ? 0xffffff : 0x2b2f36);
  if (current) paintTown(current);
}

// ------------------------------------------------------------------ things that move

/** Runs a step from 0 to 1 over some seconds. With nobody watching, or motion unwanted, it's simply done. */
function tween(seconds, step) {
  if (!town || still.matches || document.hidden || seconds <= 0) {
    step(1);
    return Promise.resolve();
  }
  const home = town;
  return new Promise((done) => home.movers.push({ began: performance.now(), seconds, step, done }));
}
const pause = (seconds) => tween(seconds, () => {});
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
function drive(vehicle, curve, seconds, backwards = false) {
  town.root.add(vehicle);
  return tween(seconds, (t) => {
    const u = Math.min(0.9999, backwards ? 1 - ease(t) : ease(t));
    const where = curve.getPointAt(u);
    const ahead = curve.getTangentAt(u).multiplyScalar(backwards ? -1 : 1);
    vehicle.position.copy(where);
    vehicle.lookAt(where.x + ahead.x, where.y, where.z + ahead.z);
  });
}
/** Along a belt, which moves while it carries it. */
function ride(item, belt, backwards = false, speed = 8) {
  town.root.add(item);
  belt.moving += backwards ? -1 : 1;
  return tween(belt.length / speed, (t) => item.position.copy(belt.curve.getPointAt(Math.min(0.9999, backwards ? 1 - t : t))).setY(DECK)).then(() => {
    belt.moving -= backwards ? -1 : 1;
  });
}
/** Through the air from one place to another, in an arc. */
function hop(item, to, seconds = 0.5, height = 1.4) {
  town.root.add(item);
  const from = item.position.clone();
  return tween(seconds, (t) => {
    item.position.lerpVectors(from, to, t);
    item.position.y += Math.sin(t * Math.PI) * height;
  });
}
function flash(lampMesh, colour, seconds = 2.2) {
  lampMesh.userData.flash = colour;
  lampMesh.userData.until = performance.now() + seconds * 1000;
}
/** A caption over where something has just happened, gone again in a few seconds. */
function say(target, words, seconds = 3.6, tone = "") {
  if (!town || document.hidden) return;
  const element = node("div", { class: `say ${tone}` }, words);
  tags.append(element);
  for (const older of town.notes) if (older.target === target) older.until = 0;
  town.notes.push({ element, target, until: performance.now() + seconds * 1000 });
  while (town.notes.length > 7) town.notes.shift().element.remove();
}
const spanOf = (from, to) => {
  const ms = Date.parse(to) - Date.parse(from);
  if (!(ms >= 0)) return "";
  return ms < 1000 ? `${ms} 毫秒` : ms < 90000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms / 60000)} 分钟`;
};

// One thing after another for each round and each card, however fast the facts about it came.
const chains = new Map();
let pending = 0;
let quietSince = 0;
function after(key, work) {
  pending += 1;
  const next = (chains.get(key) ?? Promise.resolve())
    .then(work)
    .catch((error) => console.warn(error))
    .finally(() => {
      pending -= 1;
      if (!pending) quietSince = performance.now();
    });
  chains.set(key, next);
  if (chains.size > 400) chains.delete(chains.keys().next().value);
  return next;
}
function bump(kind, key, change) {
  const shown = town.shown;
  if (shown[kind] instanceof Map) shown[kind].set(key, Math.max(0, (shown[kind].get(key) ?? 0) + change));
  else shown[kind] = Math.max(0, shown[kind] + change);
  if (current) paintPiles(current);
}

// The hall's carousel: what's waiting for an Agent goes round on it, each thing in a place of its own.
const PLACES = 16;
const placeOf = (entry) => {
  const angle = entry.place * ((Math.PI * 2) / PLACES) + town.turn;
  return new THREE.Vector3(Math.cos(angle) * 3.6, DECK, Math.sin(angle) * 3.6);
};
/** The free place nearest to where something comes in, or none when the carousel is full. */
function freePlace(angle) {
  const wanted = Math.round(((angle - town.turn) / (Math.PI * 2)) * PLACES);
  for (let off = 0; off < PLACES; off++) {
    for (const place of [wanted + off, wanted - off]) {
      const wrapped = ((place % PLACES) + PLACES) % PLACES;
      if (!town.carousel.some((entry) => entry.place === wrapped)) return wrapped;
    }
  }
  return null;
}
async function board(parcel, rule, angle) {
  const place = freePlace(angle);
  if (place === null) return void parcel.removeFromParent();
  const entry = { parcel, rule, place, settling: true };
  town.carousel.push(entry);
  if (!(await armCarry(town, parcel, () => placeOf(entry)))) await hop(parcel, placeOf(entry), 0.35, 0.5);
  entry.settling = false;
}
function alight(rule) {
  const index = town.carousel.findIndex((entry) => entry.rule === rule && !entry.settling);
  return index < 0 ? null : town.carousel.splice(index, 1)[0].parcel;
}
/** Sets the carousel straight by what's really waiting: for when nothing is playing, or the page has just opened. */
function settleCarousel() {
  for (const [rule, lane] of town.lanes) {
    const wanted = town.shown.lanes.get(rule) ?? 0;
    const mine = town.carousel.filter((entry) => entry.rule === rule);
    for (const extra of mine.slice(wanted)) (extra.parcel.removeFromParent(), town.carousel.splice(town.carousel.indexOf(extra), 1));
    for (let more = mine.length; more < wanted; more++) {
      const place = freePlace(lane.angle);
      if (place === null) break;
      const entry = { parcel: parcelOf(lane.colour), rule, place, settling: false };
      town.root.add(entry.parcel);
      town.carousel.push(entry);
    }
  }
  for (const stray of town.carousel.filter((entry) => !town.lanes.has(entry.rule))) (stray.parcel.removeFromParent(), town.carousel.splice(town.carousel.indexOf(stray), 1));
}

/** An event comes in. Its rule's machine turns out a parcel, which rides that machine's belt to the hall. */
function arrive(event, routed, fact, wait) {
  const home = town;
  const from = event.source === "schedule" ? "定时" : (current?.sources.find((source) => source.id === event.source)?.name ?? event.source);
  const what = event.type === "run.manual" ? "手动派的一单" : event.type.startsWith("task.") ? "你交代的事" : event.type;
  const inside = fact.type === "finish" ? "receipt" : event.type === "card.answered" ? "answer" : event.type === "timer.due" ? "timer" : null;
  if (!routed.length) {
    return after(`event-${event.id}`, async () => {
      await wait;
      const parcel = parcelOf(TONE.idle, event.hops ?? 0);
      parcel.position.copy(home.lost.top).setY(9);
      say(home.lost.top, `${from} · ${what}：没有规则接`, 4.4, "crit");
      await hop(parcel, home.lost.top, 0.6, 0);
      parcel.removeFromParent();
      bump("unrouted", null, 1);
    });
  }
  for (const target of routed) {
    after(target.run, async () => {
      await wait;
      const lane = home.lanes.get(target.rule);
      if (!lane) return;
      const parcel = parcelOf(lane.colour, event.hops ?? 0);
      // One that starts a round of its own has a story: the plate that rides with it, and what the eye may follow.
      const story = target.fresh ? storyOf(target.run, target.rule) : null;
      if (story) storyAt(story, "in", parcel);
      if (inside) {
        // What a receipt sent, an answer, or a check falling due starts inside the hall: it never left it.
        const start = inside === "receipt" ? home.hall.top : inside === "answer" ? home.outbox.gate.clone().setY(1) : home.timers.top;
        parcel.position.copy(start);
        say(home.hall.note, inside === "receipt" ? `回执发出一条新事件 · 第 ${event.hops ?? 1} 层` : inside === "answer" ? "你的回答回到中台" : "约好的复查到点了", 3.6);
      } else {
        lane.boost = performance.now() + 1200;
        lane.rang = performance.now();
        if (lane.dish) lane.aim += lane.aim > 0.5 ? -1.1 : 0.9;
        if (lane.signal) flash(lane.signal, TONE.crit, 3.2);
        flash(lane.lamp, TONE.good, 1.4);
        shout(lane.note.clone().setY(4.4), event.summary || (event.source === "schedule" ? "到点了" : event.type === "run.manual" ? what : `${from} · ${what}`));
        await pause(0.5);
        parcel.position.copy(lane.belt.curve.getPointAt(0)).setY(DECK);
        await ride(parcel, lane.belt);
      }
      if (!target.fresh) return void parcel.removeFromParent();
      await board(parcel, target.rule, inside ? lane.angle + 0.6 : lane.angle);
      if (story) storyAt(story, "wait");
      bump("lanes", target.rule, 1);
    });
  }
}
/** A worker has come for the round: it leaves the carousel down the Agent's belt, with a slip good for this one go. */
async function collect(row) {
  const home = town;
  const agent = home.agents.get(row.agent);
  const parcel = alight(row.rule) ?? parcelOf(home.lanes.get(row.rule)?.colour ?? TONE.idle);
  bump("lanes", row.rule, -1);
  if (!agent) return void parcel.removeFromParent();
  home.root.add(parcel);
  // One the town never saw come in is found on the floor, by the door it will leave through.
  if (!parcel.position.lengthSq()) parcel.position.set(Math.cos(agent.angle) * 3.6, DECK, Math.sin(agent.angle) * 3.6);
  const story = storyOf(row.id, row.rule);
  story.agent = row.agent;
  storyAt(story, "out", parcel);
  const door = agent.belt.curve.getPointAt(0).setY(DECK);
  if (!(await armCarry(home, parcel, () => door))) await hop(parcel, door, 0.45, 0.6);
  say(agent.note, `第 ${row.id} 轮 · 提货单 #${row.issued}`, 4.6);
  await ride(parcel, agent.belt);
  await hop(parcel, agent.rest.clone().addScaledVector(agent.aside, agent.loads.size * 1.05), 0.4, 1.1);
  agent.loads.set(row.id, parcel);
  agent.hopped = performance.now();
  agent.rounds.set(row.id, { live: true, at: performance.now() });
  storyAt(story, "work");
  bump("inside", row.agent, 1);
  await pause(2.2);
}
/** The round is over: the Agent turns about, and its receipt goes back up the belt to be gone through at the hall. */
async function handIn(row, asked, reached) {
  const home = town;
  const agent = home.agents.get(row.agent);
  bump("inside", row.agent, -1);
  if (!agent) return void reached();
  const story = stories.get(row.id);
  if (story) (storyAt(story, "done"), (story.ended = performance.now()));
  // A round is often over before its parcel has got to the Agent: the town plays what happened, a little behind. For
  // whoever is watching this Agent, what it did comes out step by step before it hands in; a few seconds at most.
  for (let waited = 0; waited < 7; waited += 0.3) {
    const bubble = agent.bubble;
    if (!bubble?.wanted || bubble.run !== row.id) break;
    const most = bubble.steps.length - (["done", "fail"].includes(bubble.steps.at(-1)?.kind) ? 1 : 0);
    if (bubble.got === row.id && bubble.shown >= most) break;
    await pause(0.3);
  }
  agent.rounds.delete(row.id);
  agent.rounds.set(row.id, { live: false, at: performance.now(), state: row.state, summary: row.summary ?? "" });
  agent.twirled = performance.now();
  await pause(0.85);
  agent.loads.get(row.id)?.removeFromParent();
  agent.loads.delete(row.id);
  if (row.state === "done") bump("done", row.agent, 1);
  const sheet = paperOf();
  sheet.position.copy(agent.belt.curve.getPointAt(0.9999)).setY(DECK);
  await ride(sheet, agent.belt, true, 15);
  await hop(sheet, home.hall.top, 0.35, 0.8);
  sheet.removeFromParent();
  const turned = JSON.parse(row.last_answer || "[]");
  const took = spanOf(row.claimed_at, row.finished_at);
  const outcome = { done: "做成了", nothing: "没事可做", cancelled: "没做成" }[row.state];
  flash(home.hall.lamp, turned.length ? TONE.crit : TONE.good, 3.2);
  say(home.hall.note, `第 ${row.id} 轮交回：${outcome}${took ? ` · 跑了 ${took}` : ""} · ${turned.length ? `回执有 ${turned.length} 项不受理` : "回执核对通过"}`, 5.5, turned.length ? "crit" : "good");
  reached();
  const fling = (item, to, then) => {
    item.position.copy(home.hall.top);
    return hop(item, to, 1, 3).then(() => (item.removeFromParent(), then()));
  };
  for (const card of asked.cards) {
    fling(letterOf(card.kind), home.outbox.top, () => bump("outbox", null, 1));
    await pause(0.25);
  }
  for (let each = 0; each < asked.timers; each++) {
    fling(clockOf(), home.timers.top, () => bump("timers", null, 1));
    await pause(0.25);
  }
}
/** It didn't get done: back up the belt it goes, to wait on the carousel until it may be tried again. */
async function sendBack(row) {
  const home = town;
  const agent = home.agents.get(row.agent);
  const lane = home.lanes.get(row.rule);
  bump("inside", row.agent, -1);
  if (!agent) return;
  const parcel = agent.loads.get(row.id) ?? parcelOf(TONE.crit);
  agent.loads.delete(row.id);
  const story = stories.get(row.id);
  if (story) storyAt(story, "back", parcel);
  agent.rounds.delete(row.id);
  agent.rounds.set(row.id, { live: false, at: performance.now(), state: "retry", summary: row.error ?? "" });
  for (const band of paints(parcel, "band")) band.color.setHex(TONE.crit);
  say(agent.note, `第 ${row.id} 轮没跑成${row.error ? `：${row.error}` : ""} · 第 ${row.attempts} 次，${clock(row.not_before).slice(0, 5)} 再试`, 6, "crit");
  await hop(parcel, agent.belt.curve.getPointAt(0.9999).setY(DECK), 0.4, 1);
  await ride(parcel, agent.belt, true, 10);
  if (lane) await board(parcel, row.rule, agent.angle);
  else parcel.removeFromParent();
  if (story) storyAt(story, "wait");
  bump("lanes", row.rule, 1);
}
/** A channel has shown the card to the owner: it goes down the path to the house. */
/** The postman sets out from the post office, which has no scooter standing at its door while one is out. */
function setOut(home) {
  home.post.away += 1;
  home.post.scooter.visible = false;
  return newest("town_scooter", "scooter");
}
function comeIn(home, scooter) {
  scooter.removeFromParent();
  home.post.away -= 1;
  home.post.scooter.visible = home.post.away === 0;
}
async function carry(id, card, channel) {
  const home = town;
  const name = current?.channels.find((each) => each.id === channel)?.name ?? channel;
  const scooter = setOut(home);
  await drive(scooter, home.mail.fetch, 1.7);
  bump("outbox", null, -1);
  const letter = letterOf(card.kind).translateY(1.15).translateZ(-0.5);
  scooter.add(letter);
  say(scooter, `${name}把卡片 #${id} 送到你面前`, 4.6, "warn");
  await drive(scooter, home.mail.home, 3);
  letter.removeFromParent();
  card.at = "house";
  if (card.state === "open") bump("house", null, 1);
  await drive(scooter, home.mail.back, 2.4);
  comeIn(home, scooter);
}
async function settled(id, row) {
  const home = town;
  const card = known.cards.get(id);
  if (!card) return;
  const where = card.at;
  card.at = "gone";
  if (where === "outbox") return bump("outbox", null, -1);
  if (where !== "house") return;
  bump("house", null, -1);
  if (row.state !== "decided") return;
  const scooter = setOut(home);
  await drive(scooter, home.mail.back, 2.2, true);
  say(scooter, `你答了卡片 #${id}${row.answer ? `：${row.answer}` : ""}`, 4.6, "good");
  await drive(scooter, home.mail.home, 2.8, true);
  // The answer is at the hall now: whatever waits on it can go on while the postman rides home.
  drive(scooter, home.mail.fetch, 1.5, true).then(() => comeIn(home, scooter));
}

// ------------------------------------------------------------------ a round's story: its plate, the Agent's words, the eye that follows

// Each round on its way has a story: where its parcel is now, and a plate that rides with it. "in" is down its
// rule's belt to the hall, "wait" on the carousel, "out" down an Agent's belt, "work" at the Agent, "back" returned to
// be tried again, "done" handed in.
const stories = new Map(); // round -> { run, rule, parcel, phase, plate, status, dot, agent, born, ended }
function storyOf(run, rule) {
  let story = stories.get(run);
  if (!story) {
    const dot = node("i", { class: "dot" });
    const status = node("span", {});
    const plate = node("div", { class: "tag small riding", role: "button", tabindex: "0", title: "点一下，跟着它看到做完；Esc 回全景", onclick: () => chaseRun(run) }, dot, node("b", {}, rule), status);
    plate.style.display = "none";
    tags.append(plate);
    story = { run, rule, parcel: null, phase: "in", plate, status, dot, agent: null, born: performance.now(), ended: 0 };
    stories.set(run, story);
  }
  return story;
}
function storyAt(story, phase, parcel) {
  story.phase = phase;
  if (parcel) story.parcel = parcel;
  const [words, colour] = phase === "out" || phase === "work" ? ["处理中", "#34a853"] : phase === "done" ? ["做完了", "#aab2bb"] : phase === "back" ? ["等重试", "#dc4c43"] : ["排队", "#4f93d8"];
  story.status.textContent = words;
  story.dot.style.background = colour;
}

/** An event shouts as it comes in: a burst over the machine it comes to, with what it says. */
function shout(target, words) {
  if (!town || document.hidden) return;
  const letters = [...String(words).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim()];
  const element = node("div", { class: "burst" }, node("div", { class: "pop" }, node("b", {}, "叮！"), node("span", {}, letters.length > 14 ? `${letters.slice(0, 13).join("")}…` : letters.join(""))));
  tags.append(element);
  town.notes.push({ element, target, until: performance.now() + 3200, burst: true });
  while (town.notes.length > 7) town.notes.shift().element.remove();
}

// What an Agent is doing, said beside it while it works: the round's steps, a few words each, as the town's server
// reads them from the round's own record. Shown only from near by, or when the eye is on that Agent.
function bubbleOf(entry, agent) {
  if (entry.bubble) return entry.bubble;
  const dot = node("i", { class: "dot" });
  dot.style.background = hex(entry.colour);
  const state = node("span", {});
  const list = node("ol", {});
  const foot = node("footer", {});
  const element = node("div", { class: "work" }, node("header", {}, dot, node("b", {}, agent.name), state), list, foot);
  element.style.display = "none";
  tags.append(element);
  entry.bubble = { element, state, list, foot, run: null, steps: [], shown: 0, asking: false, wanted: false, key: "" };
  return entry.bubble;
}
/**
 * Which round of an Agent's to show: the one the eye is following, if it is this Agent's; else the one it took up
 * last and is still at; else the one it handed in last, for a few seconds more. An Agent may have several in hand.
 */
function workOf(id, entry) {
  const now = performance.now();
  for (const [run, round] of entry.rounds) if (!round.live && now - round.at > 9000) entry.rounds.delete(run);
  const of = (run) => ({ run, live: entry.rounds.get(run).live, ended: entry.rounds.get(run).live ? null : entry.rounds.get(run) });
  if (chase?.run !== undefined && entry.rounds.has(chase.run)) return of(chase.run);
  const live = [...entry.rounds].filter(([, round]) => round.live).at(-1);
  if (live) return of(live[0]);
  // The page was opened with it already at work: the town hasn't seen it taken up, but the hub's state says which.
  if (entry.busy) {
    const run = current?.runs.filter((each) => each.agent === id && ["claimed", "unknown"].includes(each.state)).sort((a, b) => Date.parse(b.claimedAt ?? 0) - Date.parse(a.claimedAt ?? 0))[0]?.id;
    if (run != null) return { run, live: true, ended: null };
  }
  const handed = [...entry.rounds].filter(([, round]) => !round.live && now - round.at < 8000).at(-1);
  return handed ? of(handed[0]) : null;
}
function paintBubble(entry, work) {
  const bubble = entry.bubble;
  const run = current?.runs.find((each) => each.id === work.run);
  const steps = bubble.steps;
  // While the Agent is still seen at work, how the round ends is kept back: that comes when it hands in.
  const closing = ["done", "fail"].includes(steps.at(-1)?.kind) ? steps.at(-1) : null;
  const body = closing ? steps.slice(0, -1) : steps;
  const shown = body.slice(0, bubble.shown);
  const first = run ? `收到：${run.rule}${run.events?.[0]?.summary ? `「${[...run.events[0].summary].slice(0, 16).join("")}」` : ""}` : `第 ${work.run} 轮`;
  const ended = work.ended;
  const outcome = ended ? (ended.state === "done" ? "已完成" : ended.state === "nothing" ? "没事可做" : ended.state === "retry" ? "没跑成，等重试" : "没做成") : "正在处理";
  const last = ended && shown.length === body.length ? (closing?.words || ended.summary) : "";
  const key = JSON.stringify([work.run, shown.length, outcome, last, first]);
  if (key === bubble.key) return;
  const grew = bubble.lines !== undefined && bubble.lines.run === work.run && shown.length > bubble.lines.count;
  bubble.lines = { run: work.run, count: shown.length };
  bubble.key = key;
  bubble.state.textContent = outcome;
  bubble.state.className = ended ? (ended.state === "done" || ended.state === "nothing" ? "good" : "bad") : "going";
  const rows = [node("li", { class: "got" }, first), ...shown.map((step) => node("li", { class: `k-${step.kind}${step.ok === false ? " bad" : ""}` }, step.words))].slice(-7);
  if (!ended) rows.at(-1).classList.add("cursor");
  if (grew) rows.at(-1).classList.add("new");
  bubble.list.replaceChildren(...rows);
  bubble.foot.hidden = !last;
  bubble.foot.className = ended && ended.state !== "done" && ended.state !== "nothing" ? "bad" : "";
  bubble.foot.textContent = last;
}
// The steps are asked for while a bubble is up, and come out one at a time, as if being typed.
setInterval(async () => {
  if (!town || document.hidden) return;
  for (const entry of town.agents.values()) {
    const bubble = entry.bubble;
    if (!bubble?.wanted || !Number.isSafeInteger(bubble.run) || bubble.run < 1 || bubble.asking) continue;
    const asked = bubble.run;
    bubble.asking = true;
    try {
      const response = await fetch(`api/runs/${asked}/steps`, { headers: { "x-town-token": TOKEN }, cache: "no-store" });
      const got = response.ok ? await response.json() : null;
      if (got && Array.isArray(got.steps) && bubble.run === asked) ((bubble.steps = got.steps.filter((step) => typeof step?.words === "string").slice(-40)), (bubble.got = asked));
    } catch {
      // The server is away for a moment: what is up stays up.
    } finally {
      bubble.asking = false;
    }
  }
}, 1100);
setInterval(() => {
  if (!town) return;
  for (const entry of town.agents.values()) {
    const bubble = entry.bubble;
    if (!bubble?.wanted) continue;
    const most = bubble.steps.length - (["done", "fail"].includes(bubble.steps.at(-1)?.kind) ? 1 : 0);
    if (bubble.shown < most) bubble.shown += 1;
    else if (bubble.shown > most) bubble.shown = most;
  }
}, 420);

// The eye follows a round from where it comes in to the Agent that takes it, and stays to see it done; or stays on one
// Agent. A drag, or Esc, lets go.
let chase = null; // { run } or { agent }
const LIMITS = { near: controls.minDistance, tilt: controls.maxPolarAngle };
const eyes = { at: new THREE.Vector3(), eye: new THREE.Vector3(), heading: new THREE.Vector3(1, 0, 0), last: new THREE.Vector3(), step: new THREE.Vector3(), here: new THREE.Vector3(), side: new THREE.Vector3(), keep: new THREE.Vector3() };
function startChase(what) {
  if (still.matches) return;
  chase = { ...what, fresh: true };
  // Nearer the ground, and nearer to things, than the hand is let go.
  controls.minDistance = 5;
  controls.maxPolarAngle = 1.5;
  document.body.classList.add("chasing");
}
const chaseRun = (run) => (stories.has(run) ? startChase({ run }) : null);
const watchAgent = (id) => (town?.agents.has(id) ? startChase({ agent: id }) : null);
/** Lets go of what the eye was following; `home` takes it back to where the whole town is in view. */
function stopChase(home = true) {
  const was = chase;
  chase = null;
  document.body.classList.remove("chasing");
  if (!home || !town) return;
  if (was || controls.minDistance !== LIMITS.near) {
    overview();
    setTimeout(() => !chase && ((controls.minDistance = LIMITS.near), (controls.maxPolarAngle = LIMITS.tilt)), 900);
  }
}
function stepChase(now, elapsed) {
  const story = chase.run !== undefined ? stories.get(chase.run) : null;
  if (chase.run !== undefined && !story) return stopChase();
  const riding = story && ["in", "out", "back"].includes(story.phase) && story.parcel?.parent;
  const agent = chase.agent ?? (story && !riding && ["work", "done"].includes(story.phase) ? story.agent : null);
  const { at, eye, heading, last, step, here } = eyes;
  if (agent != null) {
    const entry = town.agents.get(agent);
    if (!entry) return stopChase();
    // Its last words have been up a while: there is nothing more to see of this round.
    if (story?.phase === "done" && now - story.ended > 7000) return stopChase();
    at.set(entry.at.x + entry.watch.at[0], entry.watch.at[1], entry.at.z + entry.watch.at[2]);
    eye.set(entry.at.x + entry.watch.eye[0], entry.watch.eye[1], entry.at.z + entry.watch.eye[2]);
  } else if (riding) {
    story.parcel.getWorldPosition(here);
    if (chase.fresh) last.copy(here);
    step.copy(here).sub(last).setY(0);
    if (step.lengthSq() > 1e-6) heading.lerp(step.normalize(), Math.min(1, elapsed * 2.2)).normalize();
    last.copy(here);
    at.copy(here).addScaledVector(heading, 4).setY(1.3);
    eye.copy(here).addScaledVector(heading, -22).add(step.set(-heading.z, 0, heading.x).multiplyScalar(6)).setY(7.5);
    // From behind, the eye would be in the hall while the parcel is just out of it: there it looks on from the
    // south, as it did while the parcel waited, and comes round behind as the parcel gets away.
    const away = THREE.MathUtils.smoothstep(Math.hypot(here.x, here.z), 16, 34);
    if (story.phase === "out" && away < 1) {
      eyes.side.set(here.x * 0.6 - 4, 21, here.z + 42);
      eye.lerpVectors(eyes.side, eye, away);
      at.lerpVectors(eyes.keep.copy(here).setY(1.6), at, away);
    }
  } else {
    // Waiting its turn on the carousel: the hall from the south, with the belts in on the left and out on the right.
    at.set(0, 3.5, 0);
    eye.set(-10, 23, 46);
  }
  chase.fresh = false;
  const pull = 1 - Math.exp(-elapsed * 2.4);
  camera.position.lerp(eye, pull);
  controls.target.lerp(at, pull);
}
controls.addEventListener("start", () => chase && stopChase(false));

// The director: with it on, nobody need touch anything. Between rounds the eye drifts slowly round the whole town; when
// an event comes in it goes after that round, stays to see the Agent do it, and comes back. Only what the hub records
// is ever followed. A hand on the picture takes over at once, and the director keeps off for half a minute after.
const director = { on: new URLSearchParams(location.search).has("desk") || localStorage.getItem("town.desk") === "1", touched: -1e9, rested: 0, own: null, waited: 0 };
function setDirector(on) {
  director.on = on;
  localStorage.setItem("town.desk", on ? "1" : "0");
  document.body.classList.toggle("desk", on);
  if (!on) ((controls.autoRotate = false), director.own !== null && chase?.run === director.own && stopChase());
  director.own = null;
}
document.body.classList.toggle("desk", director.on);
function direct(now) {
  const free = director.on && town && !still.matches && !document.hidden && now - director.touched > 30_000;
  // Round the town, slowly, while nothing is being followed: once in about four minutes.
  controls.autoRotate = Boolean(free && !chase && !selected && controls.minDistance === LIMITS.near);
  if (!free) return;
  if (chase) {
    // One it went after itself that has been standing in the queue too long is left to wait without an audience.
    const story = chase.run === director.own ? stories.get(chase.run) : null;
    if (story?.phase !== "wait") director.waited = now;
    else if (now - director.waited > 18_000) stopChase();
    director.rested = now;
    return;
  }
  director.own = null;
  // A breath between one round and the next; then the round that has come in most lately, if it is still on its way in.
  if (selected || now - director.rested < 7000) return;
  const next = [...stories.values()].filter((story) => story.phase === "in" && story.parcel?.parent && now - story.born < 6000).at(-1);
  if (!next) return;
  director.own = next.run;
  director.waited = now;
  chaseRun(next.run);
}
for (const kind of ["pointerdown", "wheel", "keydown"]) addEventListener(kind, () => (director.touched = performance.now()), { passive: true });
addEventListener("keydown", (event) => event.key === "Escape" && (chase || controls.minDistance !== LIMITS.near) && stopChase());

// ------------------------------------------------------------------ the hub's log, one fact at a time

const known = { runs: new Map(), cards: new Map(), timers: new Map(), events: new Set() };
function onFact(fact) {
  if (!town || !current || replay.on) return;
  if (fact.type === "heartbeat") {
    for (const { table, row } of fact.changes) {
      if (table !== "seen" || row?.kind !== "worker") continue;
      for (const agent of current.agents.filter((each) => each.worker === row.name)) town.agents.get(agent.id) && (town.agents.get(agent.id).beat = performance.now());
    }
    return;
  }
  if (fact.type === "channelSeen") return;
  // A fact gives whole rows, and the same row more than once: the last is how it was left.
  const last = new Map();
  for (const change of fact.changes) last.set(`${change.table}:${change.key}`, change);
  const of = (table) => [...last.values()].filter((change) => change.table === table);
  const before = new Map(known.runs);
  const rows = new Map(of("runs").filter((change) => change.row).map((change) => [change.row.id, change.row]));
  const cards = of("cards").filter((change) => change.row).map((change) => change.row);
  const fresh = of("timers").filter((change) => change.row && change.row.event_id == null && !known.timers.has(Number(change.key))).length;
  const handed = new Set();
  let atHall = null;

  for (const change of of("runs")) {
    const id = Number(change.key);
    const was = before.get(id);
    const row = change.row;
    if (!row) {
      known.runs.delete(id);
      if (was?.state === "queued") bump("lanes", was.rule, -1);
      continue;
    }
    known.runs.set(id, { state: row.state, attempts: row.attempts, rule: row.rule, agent: row.agent });
    if (!was || (was.state === row.state && was.attempts === row.attempts)) continue;
    const running = ["claimed", "unknown"].includes(was.state);
    if (was.state === "queued" && row.state === "claimed") after(id, () => collect(row));
    else if (running && ENDED.includes(row.state)) {
      let reached;
      atHall = new Promise((done) => (reached = done));
      handed.add(id);
      const mine = cards.filter((card) => card.run_id === id && !known.cards.has(card.id));
      after(id, () => handIn(row, { cards: mine, timers: fresh }, reached));
    } else if (running && row.state === "queued") after(id, () => sendBack(row));
    else if (was.state === "claimed" && row.state === "unknown") say(town.agents.get(row.agent)?.note ?? town.hall.note, `第 ${id} 轮 5 分钟没消息：不确定还在不在跑`, 6, "warn");
    else if (was.state === "queued" && ENDED.includes(row.state)) after(id, () => (bump("lanes", row.rule, -1), say(town.hall.note, `第 ${id} 轮不做了${row.summary ? `：${row.summary}` : ""}`, 5, "crit")));
  }
  for (const row of cards) {
    const was = known.cards.get(row.id);
    if (!was) {
      known.cards.set(row.id, { state: row.state, kind: row.kind, at: "outbox", rule: row.rule });
      // One a receipt asked for is flung across from the hall; any other is the hub's own word, and is simply there.
      if (!handed.has(row.run_id)) after(`card-${row.id}`, () => (bump("outbox", null, 1), say(town.outbox.top, `新卡片：${row.title ?? ""}`, 4, "warn")));
    } else if (was.state === "open" && row.state !== "open") {
      was.state = row.state;
      after(`card-${row.id}`, () => settled(row.id, row));
    } else was.state = row.state;
  }
  for (const { row } of of("deliveries")) {
    const card = row && row.ref != null ? known.cards.get(Number(row.card_id)) : null;
    if (!card || card.at !== "outbox") continue;
    card.at = "on the way";
    after(`card-${row.card_id}`, () => carry(Number(row.card_id), card, row.channel));
  }
  for (const { key, row } of of("timers")) {
    const id = Number(key);
    const was = known.timers.get(id);
    if (row && row.event_id == null) {
      if (!was) (known.timers.set(id, true), handed.size || bump("timers", null, 1));
    } else {
      if (was !== false) bump("timers", null, -1);
      row ? known.timers.set(id, false) : known.timers.delete(id);
    }
  }
  const links = of("run_events").filter((change) => change.row).map((change) => change.row);
  for (const { row: event } of of("events")) {
    if (!event || known.events.has(event.id)) continue;
    known.events.add(event.id);
    if (known.events.size > 800) known.events.delete(known.events.values().next().value);
    const routed = links.filter((link) => link.event_id === event.id).map((link) => ({ run: link.run_id, rule: rows.get(link.run_id)?.rule ?? known.runs.get(link.run_id)?.rule, fresh: !before.has(link.run_id) }));
    const answered = event.type === "card.answered" ? cards.find((card) => card.answer_event === event.id) : null;
    arrive(event, routed, fact, (answered ? chains.get(`card-${answered.id}`) : atHall) ?? Promise.resolve());
  }
}
/** Reads the log from where the state the page has left off, and again from where it broke off if it breaks. */
async function follow(from) {
  let cursor = from;
  for (;;) {
    try {
      const response = await fetch(`api/stream?after=${cursor}`, { headers: { "x-town-token": TOKEN }, cache: "no-store" });
      if (!response.ok) throw new Error(`事实流 ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (let cut = text.indexOf("\n\n"); cut >= 0; cut = text.indexOf("\n\n")) {
          const data = /^data: (.*)$/m.exec(text.slice(0, cut))?.[1];
          text = text.slice(cut + 2);
          if (!data) continue;
          const fact = JSON.parse(data);
          if (fact.seq <= cursor) continue;
          cursor = fact.seq;
          onFact(fact);
        }
      }
    } catch {
      // The hub is down or restarting: the state poll says so, and this asks again.
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
}

// ------------------------------------------------------------------ painting the town as it is now

let current = null;
let selected = null;
const painted = {};
/** Repaints a panel only when what it shows has changed, so a button isn't replaced under the pointer. */
function paint(id, key, make) {
  const text = JSON.stringify(key);
  if (painted[id] === text) return;
  painted[id] = text;
  $(id).replaceChildren(...[make()].flat().filter(Boolean));
}
const same = (pick, other) => pick?.kind === other?.kind && pick?.id === other?.id;

/** What stands where is moved by what has been played. When nothing is playing it is set straight by the state. */
function heal(state) {
  if (town.healed && (pending > 0 || performance.now() - quietSince < 2500)) return;
  town.healed = true;
  const shown = town.shown;
  for (const line of state.lines) shown.lanes.set(line.name, line.totals.queued);
  for (const agent of state.agents) (shown.inside.set(agent.id, agent.totals.running + agent.totals.unknown), shown.done.set(agent.id, agent.totals.doneToday ?? agent.totals.done ?? 0));
  shown.timers = state.timers.length;
  shown.unrouted = state.unrouted.length;
  known.runs.clear();
  for (const run of state.runs) known.runs.set(run.id, { state: run.state, attempts: run.attempts, rule: run.rule, agent: run.agent });
  const open = new Set(state.cards.map((card) => card.id));
  for (const id of [...known.cards.keys()]) if (!open.has(id)) known.cards.delete(id);
  // One that was open before this page was is taken to have reached the owner: the state doesn't say.
  for (const card of state.cards) if (!known.cards.has(card.id)) known.cards.set(card.id, { state: "open", kind: card.kind, at: "house", rule: card.rule });
  const where = [...known.cards.values()];
  shown.outbox = where.filter((card) => card.at === "outbox").length;
  shown.house = where.filter((card) => card.at === "house").length;
  settleCarousel();
  for (const agent of town.agents.values()) {
    for (const load of agent.loads.values()) load.removeFromParent();
    agent.loads.clear();
  }
}
function paintPiles(state) {
  const shown = town.shown;
  const some = (count, most, each) => Array.from({ length: Math.min(count, most) }, (_, index) => each(index));
  for (const [id, agent] of town.agents) {
    const done = shown.done.get(id) ?? 0;
    setPile(agent.pallet, `${done}`, some(done, 20, () => boxOf()), 2, [0.86, 0.64, 0.86], 2);
  }
  setPile(town.lost.pile, `${shown.unrouted}`, some(shown.unrouted, 4, () => parcelOf(TONE.idle)), 2, [1.05, 0.78, 0]);
  setPile(town.outbox.pile, `${shown.outbox}`, some(shown.outbox, 8, () => letterOf("ask")), 1, [0, 0.12, 0]);
  setPile(town.timers.pile, `${shown.timers}`, some(shown.timers, 3, clockOf), 3, [0.85, 1, 0]);
  setPile(town.house.pile, `${shown.house}`, some(shown.house, 6, () => letterOf("ask")), 1, [0, 0.12, 0]);
}

function paintTown(state) {
  heal(state);
  paintBoard(state);
  const glow = look().glow;
  const light = (materials, on, colour = 0xffd27a, power = 1.5) => {
    for (const material of materials) (material.emissive.setHex(colour), (material.emissiveIntensity = on ? power : 0));
  };
  const shown = town.shown;
  const tagged = (entry, colour, title, status, hollow = false) => {
    entry.dot.style.background = hollow ? "transparent" : colour;
    entry.dot.style.boxShadow = hollow ? `inset 0 0 0 2px ${colour}` : "none";
    entry.title.textContent = title;
    entry.status.textContent = status;
  };
  const hex = (colour) => `#${colour.toString(16).padStart(6, "0")}`;
  for (const line of state.lines) {
    const lane = town.lanes.get(line.name);
    if (!lane) continue;
    const waiting = shown.lanes.get(line.name) ?? 0;
    const retrying = state.runs.filter((run) => run.rule === line.name && run.state === "queued" && run.attempts > 0);
    lane.running = line.totals.running > 0;
    lane.lamp.userData.steady = line.paused ? null : lane.running ? TONE.good : waiting ? 0x4f93d8 : null;
    if (lane.signal) lane.signal.userData.steady = lane.lamp.userData.steady;
    const status = line.paused ? "已暂停" : retrying.length ? `第 ${Math.max(...retrying.map((run) => run.attempts))} 次重试 · ${clock(retrying.map((run) => run.notBefore).sort()[0]).slice(0, 5)}` : lane.running ? "运行中" : waiting ? `排队 ${waiting}` : line.every ? line.every : "待机";
    tagged(lane.tag, retrying.length ? "#dc4c43" : lane.running ? "#34a853" : waiting ? "#4f93d8" : "#aab2bb", line.name, status, !lane.running && !waiting && Boolean(line.every));
    light(paints(lane.machine, "window"), glow);
  }
  for (const project of town.projects) {
    const busy = project.lines.filter((line) => state.lines.find((each) => each.name === line.name)?.totals.running).length;
    if (project.tag) tagged(project.tag, hex(project.colour), project.name, busy ? `${busy} 条在忙` : "");
    light(project.windows ?? [...paints(project.office, "window")], glow, 0xffd27a, 1.3);
  }
  for (const agent of state.agents) {
    const entry = town.agents.get(agent.id);
    if (!entry) continue;
    const inside = shown.inside.get(agent.id) ?? 0;
    const really = agent.totals.running + agent.totals.unknown;
    entry.busy = inside > 0;
    entry.online = agent.online;
    tagged(entry.tag, agent.online ? hex(entry.colour) : "#aab2bb", agent.name, !agent.online ? "离线" : !inside ? "待命" : really >= inside ? `处理中 ${inside}` : "回放中");
  }
  const waiting = state.cards.length;
  tagged(town.hall.tag, "#d9634f", "Webhook 中台", state.totals.queued ? `在转 ${state.totals.queued} 件` : "中转站");
  town.hall.lamp.userData.steady = waiting ? TONE.warn : null;
  const reach = state.channels.filter((channel) => channel.online);
  tagged(town.post.tag, reach.length ? "#34a853" : "#aab2bb", "邮局", state.channels.length ? state.channels.map((channel) => `${channel.name}${channel.online ? "" : "（离线）"}`).join("、") : "没接通道");
  light(paints(town.post.model, "window"), glow, 0xffd27a, 1.3);
  light([...paints(town.hall.model, "window"), ...town.hall.glazing], glow, 0xffd27a, 1.3);
  tagged(town.house.tag, waiting ? "#f5a524" : "#aab2bb", "你", waiting ? `${waiting} 件事等你拍板` : "");
  town.house.tag.element.classList.toggle("attention", waiting > 0);
  for (const material of town.house.flag) material.color.setHex(waiting ? 0xfab219 : 0xc3c2b7);
  light(paints(town.house.model, "window"), glow, 0xffd27a, 1.3);
  const quiet = (entry, count, colour, title, status) => {
    entry.tag.element.hidden = !count;
    tagged(entry.tag, colour, title, status);
  };
  quiet(town.outbox, shown.outbox, "#f5a524", "等通道来取", `${shown.outbox} 张卡片`);
  const due = state.timers.map((timer) => timer.at).sort()[0];
  quiet(town.timers, shown.timers, "#4f93d8", "到点复查", `${shown.timers} 个${due ? ` · ${clock(due).slice(0, 5)}` : ""}`);
  quiet(town.lost, shown.unrouted, "#dc4c43", "没人接", `${shown.unrouted} 件`);
  paintPiles(state);

  const chosen = selected && town.spots.get(keyOf(selected));
  for (const entry of town.tags) entry.element.classList.toggle("selected", Boolean(selected) && same(entry.pick, selected));
  town.ring.visible = Boolean(chosen);
  if (chosen) (town.ring.position.set(chosen.centre.x, 0.2, chosen.centre.z), town.ring.scale.setScalar(chosen.radius + 0.6));
}

// ------------------------------------------------------------------ the cards laid over the town

const open = { task: false, feed: false, cards: false, filter: "all" };
const ICONS = {
  home: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v8.5h11V10"/>',
  left: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.8v4.2h4.2"/>',
  right: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.5 4.8v4.2h-4.2"/>',
  nearer: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4M8.5 11h5M11 8.5v5"/>',
  farther: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4M8.5 11h5"/>',
  plate: '<path d="M4 6.5h9.5L19 12l-5.5 5.5H4z"/><circle cx="8" cy="12" r="1"/>',
  moon: '<path d="M19 14.2A7.5 7.5 0 1 1 9.8 5a6 6 0 0 0 9.2 9.2z"/>',
  pen: '<path d="m5 19 3.6-.8L19 7.8 16.2 5 5.8 15.4z"/><path d="m14.4 6.8 2.8 2.8"/>',
  play: '<path d="M8.5 6.5v11l9-5.5z"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.8v4.2h4.2"/><path d="M12 8.2v4.1l2.8 1.7"/>',
  list: '<path d="M9 7h10M9 12h10M9 17h10"/><path d="M5 7h.01M5 12h.01M5 17h.01"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5.5 12.5 4.2 4.2L18.5 8"/>',
  clock: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.2l2.8 1.8"/>',
  play: '<path d="M9 7v10l8-5z"/>',
  retry: '<path d="M18.5 12a6.5 6.5 0 1 1-2-4.7"/><path d="M18.5 5.5v3.8h-3.8"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>',
  cloud: '<path d="M7.5 18.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/>',
  rain: '<path d="M7.5 15a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/><path d="M9 18l-.8 2.2M12.5 18l-.8 2.2M16 18l-.8 2.2"/>',
  snow: '<path d="M7.5 14.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/><path d="M8.5 18.5h.01M12 19.5h.01M15.5 18.5h.01M10.2 21h.01M13.8 21h.01"/>',
  fog: '<path d="M5 9h14M4 13h16M6.5 17h11"/>',
  storm: '<path d="M7.5 14.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.5 6.7z"/><path d="m12.5 13.5-2 3.5h3l-2 3.5"/>',
  dash: '<path d="M7.5 12h9"/>',
  ask: '<path d="M9.4 9.6a2.7 2.7 0 1 1 3.9 2.4c-.8.5-1.3 1-1.3 2"/><path d="M12 17.2h.01"/>',
  bell: '<path d="M7 16.5V11a5 5 0 0 1 10 0v5.5l1.5 1.5h-13z"/><path d="M10.5 20h3"/>',
  chevron: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  clip: '<path d="M8.6 12.6 13.9 7.3a2.75 2.75 0 0 1 3.9 3.9l-7.1 7.1a4.3 4.3 0 0 1-6.1-6.1l6.6-6.6"/>',
  file: '<path d="M7 4.5h6.5L18 9v10.5H7z"/><path d="M13.5 4.5V9H18"/>',
  send: '<path d="M5 12 19 5.5l-5 13.5-2.6-5.8z"/>',
  unsure: '<path d="M12 7v6"/><path d="M12 16.8h.01"/><circle cx="12" cy="12" r="8"/>',
};
/** One of the icons above. They are fixed drawings written here, never anything a hub or an Agent sent. */
function icon(name, size = 18) {
  const drawing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) drawing.setAttribute(key, value);
  drawing.innerHTML = ICONS[name];
  return drawing;
}
const HOW = {
  claimed: ["运行中", "play", "run"], queued: ["排队", "clock", "wait"], retrying: ["等重试", "retry", "bad"], unknown: ["不确定", "unsure", "unsure"],
  done: ["做成了", "check", "ok"], nothing: ["没事可做", "dash", "quiet"], cancelled: ["没做成", "close", "bad"],
};
/** How a round stands, as a word with its own mark and colour: never colour alone. */
const stateOf = (run) => {
  const [words, mark, tone] = Object.hasOwn(HOW, kindOf(run)) ? HOW[kindOf(run)] : HOW.unknown;
  return node("span", { class: `state ${tone}` }, icon(mark, 14), words);
};
const hex = (colour) => `#${colour.toString(16).padStart(6, "0")}`;
const dotOf = (colour, hollow = false) => node("i", { class: "dot", style: hollow ? `box-shadow: inset 0 0 0 2px ${colour}` : `background:${colour}` });
const agentChip = (state, id) => {
  const agent = state.agents.find((each) => each.id === id);
  return node("span", { class: "pill" }, dotOf(hex(AGENT_TINTS[agent?.use] ?? 0x8fa6b8)), agent?.name ?? id);
};
/** How a rule is doing, in a word, and the colour that goes with it. */
function standing(line, state) {
  const retrying = state.runs.filter((run) => run.rule === line.name && run.state === "queued" && run.attempts > 0);
  if (line.paused) return ["已暂停", "#aab2bb", "muted"];
  if (retrying.length) return [`等重试`, "#dc4c43", "crit"];
  if (line.totals.running) return ["运行中", "#34a853", "good"];
  if (line.totals.queued) return [`排队 ${line.totals.queued}`, "#4f93d8", "blue"];
  if (line.next) return [`下次 ${clock(line.next).slice(0, 5)}`, "#aab2bb", "muted"];
  return ["待机", "#aab2bb", "muted"];
}

function paintLines(state) {
  const key = [town.projects.map((project) => project.name), state.lines.map((line) => [line.name, line.agent, standing(line, state)[0]]), state.agents.map((agent) => [agent.id, agent.online, agent.totals.running, agent.totals.doneToday]), selected];
  paint("lines", key, () => [
    ...town.projects.flatMap((project) => {
      const lines = project.lines.map((line) => state.lines.find((each) => each.name === line.name)).filter(Boolean);
      const busy = lines.filter((line) => line.totals.running).length;
      return [
        node("div", { class: "group", onclick: () => select({ kind: "project", id: project.name }) }, dotOf(hex(project.colour)), node("b", {}, project.name), node("span", {}, `${lines.length} 条产线${busy ? ` · ${busy} 条在忙` : ""}`)),
        ...lines.map((line) => {
          const [words, colour, tone] = standing(line, state);
          const chosen = selected?.kind === "rule" && selected.id === line.name;
          return node("div", { class: `line ${chosen ? "chosen" : ""}`, tabindex: "0", role: "button", onclick: () => select({ kind: "rule", id: line.name }) },
            node("div", { class: "head" }, dotOf(colour, tone === "muted" && Boolean(line.every)), node("b", {}, line.name), node("span", { class: tone }, words)),
            node("div", { class: "sub" }, line.every ?? "实时", " → ", agentChip(state, line.agent)),
          );
        }),
      ];
    }),
    node("div", { class: "section" }, "Agent"),
    ...state.agents.map((agent) =>
      node("div", { class: `line ${selected?.kind === "agent" && selected.id === agent.id ? "chosen" : ""}`, tabindex: "0", role: "button", onclick: () => select({ kind: "agent", id: agent.id }) },
        node("div", { class: "head" }, dotOf(agent.online ? "#34a853" : "#aab2bb"), node("b", {}, agent.name), node("span", { class: agent.totals.running ? "good" : "muted" }, !agent.online ? "离线" : agent.totals.running ? `处理中 ${agent.totals.running}` : "待命")),
        node("div", { class: "sub" }, node("span", { class: "pill" }, dotOf(hex(AGENT_TINTS[agent.use] ?? 0x8fa6b8)), `${agent.worker} 上的 ${agent.use}`), ` 今日完成 ${agent.totals.doneToday ?? agent.totals.done ?? 0}`),
      ),
    ),
  ]);
}
// The page is calm unless the panels have been asked for: the town, a count of the lines running, the clock, and
// whatever waits on the owner. The count is also the way to the panels; the dock has the way back.
const calm = { on: localStorage.getItem("town.panels") !== "1" };
function setCalm(on) {
  calm.on = on;
  localStorage.setItem("town.panels", on ? "0" : "1");
  document.body.classList.toggle("calm", on);
  fit();
  if (town) overview();
}
document.body.classList.toggle("calm", calm.on);
/** How many lines are running, said the way a sign over the town would say it. */
function paintCount(state) {
  const running = state.lines.filter((line) => !line.paused).length;
  const waiting = state.cards.length;
  const tone = state.totals.attention ? "warn" : "good";
  paint("count", [running, tone, waiting], () => [
    node("span", { class: `dot ${tone}` }),
    node("b", {}, String(running)),
    node("span", {}, "条流水线运转中"),
  ]);
}
function paintStats(state) {
  const { totals, spending } = state;
  const today = spending.today;
  const priced = today.rounds > today.missingCost;
  const stats = [["运行中", totals.running, "good"], ["排队", totals.queued, "blue"], ["需留意", totals.attention, totals.attention ? "warn" : "muted"], ["今日完成", totals.doneToday, ""]];
  paint("tiles", [stats, priced && today.cost.toFixed(2)], () => [
    ...stats.map(([name, value, tone]) => node("div", { class: "stat" }, node("b", { class: tone }, String(value)), node("span", {}, name))),
    node("div", { class: "cost", title: "今天的花费和用量" }, priced ? `$${today.cost.toFixed(2)}` : "", ` ${compact.format(today.tokens)} Token`),
  ]);
}

/** The hall's clock, where it has one, shows the time it is. */
function setHallClock(now = timeNow()) {
  const turns = [(now.getHours() % 12) / 12 + now.getMinutes() / 720, now.getMinutes() / 60 + now.getSeconds() / 3600];
  town?.hall?.hands?.forEach((each, index) => each && each.part.quaternion.copy(each.rest).multiply(new THREE.Quaternion().setFromAxisAngle(each.axis, -turns[index] * Math.PI * 2)));
  // A building's clock: its hands come in pairs, the hour's first.
  town?.clocks?.forEach((each, index) => each && each.part.quaternion.copy(each.rest).multiply(new THREE.Quaternion().setFromAxisAngle(each.axis, -turns[index % 2] * Math.PI * 2)));
}
function paintClock() {
  const now = timeNow();
  setHallClock(now);
  const sky = SKIES[skyNow()];
  const mark = sky.icon === "sun" && isNight() ? "moon" : sky.icon;
  const words = weather.preview ? `试看：${sky.words}` : weather.live ? `${weather.live.city} · ${sky.words} ${weather.live.temperature}°` : weather.error ? weather.error : weather.city ? `${weather.city} · 正在取天气` : "设个城市，看天气";
  const hour = replay.on ? " · 回放" : calendar.pretend !== null ? " · 试看" : { auto: "", night: " · 手动夜晚", day: " · 手动白天", gold: " · 手动黄昏" }[lookMode];
  paint("clock", [now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), words, mark, hour], () => [
    node("b", {}, now.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })),
    node("span", {}, `${now.getMonth() + 1}月${now.getDate()}日周${"日一二三四五六"[now.getDay()]}${hour}`),
    node("button", { class: "skyline", "aria-label": "天气和城市", onclick: () => (($("sky").hidden = !$("sky").hidden), paintWeather()) }, icon(mark, 15), words),
  ]);
  if (stampOf(lookAt(now)) !== lit.stamp) restyle();
}

/**
 * Runs through the day to come, or the year to come, in twenty-four seconds, and comes back to now: the day hour by
 * hour, the year at the same hour of every afternoon. Asked again while it runs, it stops.
 */
function playAhead(kind) {
  if (replay.on) closeReplay();
  const running = calendar.play?.kind;
  calendar.play = calendar.pretend = null;
  if (running !== kind) ((lookMode = "auto"), (calendar.play = { kind, began: performance.now(), from: Date.now() }));
  paintClock();
  paintWeather();
  restyle();
}
function stepAhead(now) {
  const { kind, began, from } = calendar.play;
  const part = (now - began) / 24_000;
  if (part >= 1) return playAhead(kind);
  const then = new Date(from + part * (kind === "day" ? 1 : 365) * 86_400_000);
  if (kind === "year") then.setHours(14, 30, 0, 0);
  calendar.pretend = then.getTime();
  paintClock();
}

// ------------------------------------------------------------------ the day played back
// The day so far, run through again from the hub's own record of it: every round, when it was asked for, taken up
// and finished, and every card, when it was put and when answered. While it plays the town is set out as it stood at
// that moment, and the clock and the light go with it. Nothing that happens meanwhile is drawn; when it is closed the
// town is set straight from the hub again.
const replay = { on: false, playing: false, dragging: false, at: 0, from: 0, to: 0, fast: 1, slow: 1, spans: [], runs: [], cards: [], more: false, live: null, key: "", painted: 0, look: "auto" };
// How long the day so far takes to watch, in milliseconds: the hours nothing happened in, and then what did happen,
// at so long a round but within these bounds.
const REPLAY = { idle: 30_000, each: 1200, least: 4000, most: 40_000, pad: 20_000 };
/** How fast the day is going by at a moment of it, in milliseconds of the day to one of watching: slowly where anything was happening. */
const replayPace = (moment) => (replay.spans.some(([start, end]) => moment >= start && moment < end) ? replay.slow : replay.fast);
async function openReplay() {
  if (replay.on || replay.asking || !current || !town) return;
  const since = new Date().setHours(0, 0, 0, 0);
  let day;
  replay.asking = true;
  try {
    const response = await fetch(`api/day?since=${since}`, { headers: { "x-town-token": TOKEN }, cache: "no-store" });
    day = await response.json().catch(() => ({}));
    // A town server started before this was added doesn't know the question.
    if (response.status === 404) throw new Error("小镇的服务是旧的，重启它以后才有");
    if (!response.ok || !Array.isArray(day.runs) || !Array.isArray(day.cards)) throw new Error(day.error || `中台返回 ${response.status}`);
  } catch (error) {
    return complain(`回放不了：${error.message}`);
  } finally {
    replay.asking = false;
  }
  if (replay.on || !current) return;
  if (calendar.play) playAhead(calendar.play.kind);
  const to = Math.max(since + 60_000, Number(day.now) || Date.now());
  Object.assign(replay, {
    on: true, playing: true, dragging: false, from: since, to, at: since, more: Boolean(day.more), live: current, key: "", painted: 0, look: lookMode,
    runs: day.runs.map(([id, rule, agent, state, attempts, created, claimed, finished, cost]) => ({ id, rule, agent, state, attempts, created, claimed, finished, cost })),
    cards: day.cards.map(([id, rule, created, over]) => ({ id, rule, created, over })),
  });
  // The stretches of the day anything was happening in: from a little before a round was asked for to a little after
  // it was finished, and round the moment a card was put; run together where they touch.
  replay.spans = [];
  const stretches = [...replay.runs.map((run) => [run.created - REPLAY.pad, (run.finished ?? to) + REPLAY.pad]), ...replay.cards.map((card) => [card.created - REPLAY.pad, card.created + REPLAY.pad])]
    .map(([start, end]) => [Math.max(since, start), Math.min(to, end)])
    .filter(([start, end]) => end > start)
    .sort((one, other) => one[0] - other[0]);
  for (const [start, end] of stretches) {
    const last = replay.spans.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else replay.spans.push([start, end]);
  }
  const busy = replay.spans.reduce((sum, [start, end]) => sum + end - start, 0);
  const began = replay.runs.filter((run) => run.created >= since).length + replay.cards.filter((card) => card.created >= since).length;
  replay.slow = Math.max(1, busy / THREE.MathUtils.clamp(began * REPLAY.each, REPLAY.least, REPLAY.most));
  // A day that was busy from end to end has no empty hours to hurry through: it goes by at the one pace.
  replay.fast = Math.max(replay.slow, (to - since - busy) / REPLAY.idle);
  // What was on its way when the playing began belongs to now, not to the day played back.
  for (const [run, story] of stories) (story.plate.remove(), stories.delete(run));
  for (const note of town.notes.splice(0)) note.element.remove();
  // The sky is part of it: a look held by hand is let go while the day plays, and taken up again after.
  lookMode = "auto";
  calendar.today = true;
  document.body.classList.add("replaying");
  paintCards({ ...current, cards: [] });
  paintReplay();
}
/** Leaves the day played back, without setting the town out again: whoever calls does that. */
function quitReplay() {
  if (!replay.on) return;
  replay.on = replay.playing = replay.dragging = false;
  calendar.pretend = null;
  calendar.today = false;
  lookMode = replay.look;
  document.body.classList.remove("replaying");
  $("replay").hidden = true;
  town.healed = false;
}
function closeReplay() {
  if (!replay.on) return;
  quitReplay();
  render(replay.live);
  paintClock();
  restyle();
  refresh();
}
/**
 * The town's state as it stood at a moment of the day: the hub's state as it is now, with the counts, the latest
 * rounds and the cards put back to what the day's record says they were then. `grace` keeps a round at work for at
 * least that long after it was taken up: played fast, a round of a few seconds would otherwise never be seen.
 */
function stateAt(moment, grace = 0) {
  const live = replay.live;
  const stamp = (time) => new Date(time).toISOString();
  const blank = () => ({ running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, doneToday: 0, nothing: 0 });
  const [byLine, byAgent, all] = [new Map(live.lines.map((line) => [line.name, blank()])), new Map(live.agents.map((agent) => [agent.id, blank()])), blank()];
  const runs = [];
  let [cost, rounds] = [0, 0];
  for (const run of replay.runs) {
    if (run.created > moment) break;
    const over = run.finished !== null && Math.max(run.finished, (run.claimed ?? run.finished) + grace) <= moment;
    // One that is waiting to be tried again now has been taken up before, but when it went back to waiting isn't kept: it is shown waiting.
    const state = over ? run.state : run.claimed !== null && run.claimed <= moment && run.state !== "queued" ? "claimed" : "queued";
    const again = state === "queued" && !over && run.finished === null && run.attempts > 0;
    for (const tally of [byLine.get(run.rule), byAgent.get(run.agent), all]) {
      if (!tally) continue;
      if (state === "claimed") tally.running += 1;
      else if (state === "queued") ((tally.queued += 1), again && (tally.retrying += 1));
      else if (state === "done") ((tally.done += 1), (tally.doneToday += run.finished >= replay.from ? 1 : 0));
      else if (state === "nothing") tally.nothing += 1;
    }
    if (over) ((cost += run.cost), (rounds += 1));
    runs.push({
      id: run.id, rule: run.rule, agent: run.agent, state, attempts: again || over ? run.attempts : 0, createdAt: stamp(run.created), claimedAt: state === "queued" ? null : stamp(run.claimed ?? run.created),
      finishedAt: over ? stamp(run.finished) : null, notBefore: stamp(run.created), summary: "", error: "", link: "", session: null, usage: null, stopping: false, manual: false, events: [],
    });
  }
  // What was done before today is as it is now: the day's record only says what today added to it.
  const since = (totals, tally) => ({ ...totals, ...tally, done: tally.done + Math.max(0, (totals.done ?? 0) - (totals.doneToday ?? totals.done ?? 0)) });
  const known = new Map([...(live.recentCards ?? []), ...live.cards].map((card) => [card.id, card]));
  const cards = replay.cards
    .filter((card) => card.created <= moment && (card.over === null || card.over > moment))
    .map((card) => ({ ...(known.get(card.id) ?? { id: card.id, version: 0, kind: "ask", title: "", text: "", options: [], rule: card.rule, createdAt: stamp(card.created) }), state: "open" }));
  return {
    ...live, now: stamp(moment), cards, runs: runs.slice(-60).reverse(), timers: [], unrouted: [],
    lines: live.lines.map((line) => ({ ...line, totals: since(line.totals, byLine.get(line.name)) })),
    agents: live.agents.map((agent) => ({ ...agent, totals: since(agent.totals, byAgent.get(agent.id)) })),
    totals: { ...since(live.totals, all), attention: cards.length },
    spending: { ...live.spending, today: { ...live.spending?.today, rounds, cost } },
  };
}
/** Each frame while the day is played back: the moment moves on, and the town is set out for it when it has changed. */
function stepReplay(now, elapsed) {
  const pace = replayPace(replay.at);
  if (replay.playing && !replay.dragging) {
    // Hurrying through empty hours it stops short at the next stretch something happened in, and goes on slowly from there.
    const ahead = pace === replay.fast ? (replay.spans.find(([start]) => start > replay.at)?.[0] ?? replay.to) : replay.to;
    replay.at = Math.min(ahead, replay.at + elapsed * 1000 * pace);
    if (replay.at >= replay.to) replay.playing = false;
  }
  calendar.pretend = replay.at;
  paintClock();
  const state = stateAt(replay.at, replay.playing && !replay.dragging ? Math.min(pace, replay.slow) * 700 : 0);
  const key = JSON.stringify([state.lines.map((line) => [line.totals.running, line.totals.queued]), state.agents.map((agent) => [agent.totals.running, agent.totals.doneToday]), state.cards.map((card) => card.id)]);
  if (key !== replay.key || now - replay.painted > 250) {
    replay.key = key;
    replay.painted = now;
    current = state;
    // Set straight from the state every time: there is nothing in flight for it to wait for.
    town.healed = false;
    paintTown(state);
    paintCount(state);
    if (!calm.on) (paintLines(state), paintStats(state));
    paintDetail(state);
  }
  const bar = $("replay");
  bar.querySelector(".head").style.left = `${((replay.at - replay.from) / (replay.to - replay.from)) * 100}%`;
  bar.querySelector(".when").textContent = `${new Date(replay.at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} · 做完 ${state.totals.doneToday} 件`;
  const playing = replay.playing ? "pause" : "play";
  if (bar.dataset.playing !== playing) ((bar.dataset.playing = playing), bar.querySelector(".toggle").replaceChildren(icon(playing, 18)));
}
/** The bar along the bottom: play or pause, the day as a strip to drag along, the moment it is at, and a way out. */
function paintReplay() {
  const bar = $("replay");
  bar.hidden = false;
  delete bar.dataset.playing;
  const strip = document.createElement("canvas");
  const toggle = node("button", { class: "toggle ghost", "aria-label": "播放或暂停", onclick: () => ((replay.playing = !replay.playing), replay.playing && replay.at >= replay.to && (replay.at = replay.from)) });
  const track = node("div", { class: "track", role: "slider", tabindex: "0", "aria-label": "今天的时间", "aria-valuemin": "0", "aria-valuemax": "100" }, strip, node("i", { class: "head" }));
  const seek = (event) => {
    const box = track.getBoundingClientRect();
    replay.at = replay.from + THREE.MathUtils.clamp((event.clientX - box.left) / box.width, 0, 1) * (replay.to - replay.from);
  };
  track.addEventListener("pointerdown", (event) => ((replay.dragging = true), (replay.playing = false), seek(event), track.setPointerCapture(event.pointerId)));
  track.addEventListener("pointermove", (event) => replay.dragging && seek(event));
  for (const kind of ["pointerup", "pointercancel"]) track.addEventListener(kind, () => (replay.dragging = false));
  track.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    replay.playing = false;
    replay.at = THREE.MathUtils.clamp(replay.at + step * (event.shiftKey ? 3_600_000 : 600_000), replay.from, replay.to);
  });
  bar.replaceChildren(
    ...[
      toggle, track, node("span", { class: "when" }),
      replay.more && node("span", { class: "fine", title: "今天的轮次太多，只取到了最近的一部分" }, "只到最近几千轮"),
      node("button", { class: "ghost", "aria-label": "回到现在", title: "回到现在", onclick: closeReplay }, icon("close", 16)),
    ].filter(Boolean),
  );
  // The strip: the day's light behind, a mark for every round where it was asked for, a dot for every card.
  const [width, height] = [Math.round(track.clientWidth * devicePixelRatio) || 1040, Math.round(40 * devicePixelRatio)];
  [strip.width, strip.height] = [width, height];
  const pen = strip.getContext("2d");
  const [dark, bright, golden, mixed] = [new THREE.Color(0x27315c), new THREE.Color(0xd6eaf6), new THREE.Color(0xf6c9a0), new THREE.Color()];
  const span = replay.to - replay.from;
  for (let x = 0; x < width; x++) {
    const { light, gold } = lightAt(new Date(replay.from + (x / width) * span));
    pen.fillStyle = `#${mixed.lerpColors(dark, bright, light).lerp(golden, gold * 0.7).getHexString()}`;
    pen.fillRect(x, 0, 1, height);
  }
  pen.fillStyle = "rgba(255, 255, 255, 0.5)";
  for (let hour = 3; replay.from + hour * 3_600_000 < replay.to; hour += 3) pen.fillRect(Math.round(((hour * 3_600_000) / span) * width), hour % 6 ? height * 0.8 : height * 0.62, Math.max(1, devicePixelRatio), height);
  const wide = Math.max(1.5, devicePixelRatio * 1.5);
  for (const run of replay.runs) {
    if (run.created < replay.from) continue;
    const tall = run.state === "done" ? 0.62 : run.state === "nothing" ? 0.34 : 0.48;
    pen.fillStyle = run.state === "cancelled" ? "#dc4c43" : `#${(town.lanes.get(run.rule)?.colour ?? 0x8fa6b8).toString(16).padStart(6, "0")}`;
    pen.fillRect(((run.created - replay.from) / span) * width - wide / 2, height * (0.9 - tall), wide, height * tall);
  }
  pen.fillStyle = "#f5a524";
  for (const card of replay.cards) {
    if (card.created < replay.from) continue;
    pen.beginPath();
    pen.arc(((card.created - replay.from) / span) * width, height * 0.16, height * 0.09, 0, Math.PI * 2);
    pen.fill();
  }
}

/** Asks the town's own server what the weather is where the owner says they are. */
async function askWeather() {
  if (!weather.city) return;
  try {
    const response = await fetch(`api/weather?city=${encodeURIComponent(weather.city)}`, { headers: { "x-town-token": TOKEN }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "天气取不到");
    weather.live = data;
    weather.error = "";
  } catch (error) {
    weather.live = null;
    weather.error = `${weather.city} · ${error.message}`;
  }
  paintClock();
  paintWeather();
  restyle();
}
function paintWeather() {
  if ($("sky").hidden) return;
  const place = node("input", { type: "text", maxlength: "40", value: weather.city, placeholder: "比如 北京", "aria-label": "城市" });
  const save = node("form", { class: "reply" }, place, node("button", { class: "ghost", "aria-label": "保存" }, icon("check", 16)));
  save.addEventListener("submit", (event) => {
    event.preventDefault();
    weather.city = place.value.trim();
    weather.live = null;
    weather.error = "";
    weather.city ? localStorage.setItem("town.city", weather.city) : localStorage.removeItem("town.city");
    paintClock();
    restyle();
    askWeather();
  });
  const tryOn = (kind) => ((weather.preview = kind), paintClock(), paintWeather(), restyle());
  $("sky").replaceChildren(
    node("header", { class: "head" }, node("span", { class: "badge" }, icon("cloud", 17)), node("h2", {}, "天气"), node("button", { class: "ghost", "aria-label": "收起", onclick: () => ($("sky").hidden = true) }, icon("close", 16))),
    node("p", { class: "fine" }, "填你所在的城市，小镇跟着那里的天气和日出日落走。城市名会发给天气服务 Open-Meteo。"),
    save,
    node("p", { class: "fine try" }, "想先看看别的天气是什么样："),
    node("div", { class: "kinds" }, node("button", { class: weather.preview === null ? "on" : "", onclick: () => tryOn(null) }, "实况"), Object.entries(SKIES).map(([kind, each]) => node("button", { class: weather.preview === kind ? "on" : "", onclick: () => tryOn(kind) }, icon(each.icon, 14), each.words))),
    node("p", { class: "fine try" }, "想看看一天、一年是怎么过的（各 24 秒，看完回到现在）："),
    node("div", { class: "kinds" }, [["day", "快进一天"], ["year", "快进一年"]].map(([kind, words]) => node("button", { class: calendar.play?.kind === kind ? "on" : "", onclick: () => playAhead(kind) }, words))),
  );
}

async function send(path, body, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-town-token": TOKEN }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `中台返回 ${response.status}`);
    complain("");
    await refresh();
    return true;
  } catch (error) {
    complain(`没办成：${error.message}`);
    if (button) button.disabled = false;
    return false;
  }
}
function dispatch(line, button) {
  const sure = MODE === "demo" || confirm(`立即运行规则「${line.name}」？\n这会真的启动 Agent，消耗你的额度。`);
  if (sure) send(`api/rules/${encodeURIComponent(line.name)}/run`, {}, button);
}
function paintCards(now) {
  const panel = $("cards");
  const count = now.cards.length;
  panel.hidden = count === 0;
  panel.classList.toggle("folded", !open.cards);
  const fold = () => ((open.cards = !open.cards), paintCards(current));
  paint("cards", [open.cards, now.cards.map((card) => [card.id, card.version, card.state])], () => {
    if (!open.cards) return [node("button", { class: "waiting", onclick: fold }, node("span", { class: "beat" }), node("b", {}, `${count} 件事等你拍板`), icon("chevron", 16))];
    return [
      node("header", { class: "head" }, node("span", { class: "badge amber" }, icon("ask", 18)), node("h2", {}, "等你拍板"), node("span", { class: "count" }, String(count)), node("button", { class: "ghost", "aria-label": "收起", onclick: fold }, icon("close", 16))),
      ...now.cards.map((card) => {
        const line = now.lines.find((each) => each.name === card.rule);
        const asker = line && now.agents.find((each) => each.id === line.agent);
        const answer = (body, button) => {
          for (const each of button.closest(".ask").querySelectorAll("button, input")) each.disabled = true;
          send(`api/cards/${card.id}/answer`, body).then((sent) => {
            if (!sent) for (const each of button.closest(".ask")?.querySelectorAll("button, input") ?? []) each.disabled = false;
          });
        };
        const words = node("input", { type: "text", maxlength: "4000", placeholder: "都不合适？直接写你的想法", "aria-label": "写你的想法" });
        const reply = node("form", { class: "reply" }, words, node("button", { class: "ghost", "aria-label": "发送" }, icon("send", 16)));
        reply.addEventListener("submit", (event) => {
          event.preventDefault();
          if (words.value.trim()) answer({ text: words.value.trim() }, words);
        });
        const asking = card.kind === "ask";
        return node("article", { class: `ask ${asking ? "" : "notice"}` },
          node("div", { class: "meta" },
            card.rule && node("span", { class: "pill" }, dotOf(hex(town.lanes.get(card.rule)?.colour ?? 0xaab2bb)), card.rule),
            node("span", {}, asking ? `${asker?.name ?? "Agent"} 问你` : "告诉你一声"),
            node("time", {}, clock(card.createdAt).slice(0, 5)),
          ),
          node("h3", {}, card.title ?? ""),
          card.text && node("p", {}, card.text),
          node("div", { class: "choices" }, (card.options ?? []).map((option, index) =>
            node("button", { class: `choice ${asking && index === card.recommend ? "best" : ""}`, onclick: (event) => answer(asking ? { choice: index } : {}, event.currentTarget) },
              asking ? node("i", {}, String(index + 1)) : node("i", {}, icon("check", 13)), node("span", {}, option), asking && index === card.recommend && node("em", {}, "推荐")),
          )),
          asking && reply,
        );
      }),
    ];
  });
}
/** Writing down a piece of work for an Agent: it goes in as an event, and a rule that takes such events does it. */
// What's being written is kept apart from what's drawn: the card can be redrawn, or shut and opened again, and lose nothing.
const draft = { text: "", files: [], line: "", sure: false, sending: false, done: "", shown: false, redraw: null };
const ATTACH = { most: 8, each: 20 * 1024 * 1024 };
const sizeOf = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
/** Takes files in. Each goes up to the town's own server at once and waits there, under its name, until the task is sent. */
function attach(list) {
  for (const file of list) {
    if (draft.files.length >= ATTACH.most) {
      complain(`一件任务最多带 ${ATTACH.most} 个附件`);
      break;
    }
    const entry = { name: file.name || "粘贴的文件", size: file.size, state: "up", id: "", why: "", picture: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" };
    draft.files.push(entry);
    if (!file.size || file.size > ATTACH.each) {
      Object.assign(entry, { state: "bad", why: file.size ? "超过 20 MB" : "是空的，或者是个文件夹" });
      continue;
    }
    fetch(`api/uploads?name=${encodeURIComponent(entry.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-town-token": TOKEN }, body: file })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `没传上去（${response.status}）`);
        Object.assign(entry, { state: "ok", id: data.id, name: data.name });
        // Taken off again while it was still going up: then it has no business waiting on the server either.
        if (!draft.files.includes(entry)) fetch(`api/uploads/${data.id}`, { method: "DELETE", headers: { "x-town-token": TOKEN } }).catch(() => {});
      })
      .catch((error) => Object.assign(entry, { state: "bad", why: error.message }))
      .finally(() => draft.redraw?.());
  }
  draft.sure = false;
  draft.redraw?.();
}
function detach(entry) {
  draft.files.splice(draft.files.indexOf(entry), 1);
  if (entry.picture) URL.revokeObjectURL(entry.picture);
  if (entry.id) fetch(`api/uploads/${entry.id}`, { method: "DELETE", headers: { "x-town-token": TOKEN } }).catch(() => {});
  draft.sure = false;
  draft.redraw?.();
}
// A file let go of anywhere on the page goes with the task, and opens the card if it was shut. Without this the
// browser would leave the town to show the file instead.
for (const kind of ["dragover", "drop"]) {
  addEventListener(kind, (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (kind !== "drop" || !event.dataTransfer.files.length) return;
    open.task = true;
    if (current) paintTask(current);
    attach(event.dataTransfer.files);
  });
}

function paintTask(state) {
  $("task").hidden = !open.task;
  const takers = TASKS ? state.lines.filter((line) => line.source === TASKS && line.types.some((type) => type.startsWith("task."))) : [];
  paint("task", [MODE, takers.map((line) => [line.name, line.agent, line.types, Boolean(line.paused), state.projects?.[line.name]])], () => {
    const shut = node("button", { class: "ghost", "aria-label": "收起", onclick: () => ((open.task = false), paintTask(current)) }, icon("close", 16));
    const head = node("header", { class: "head" }, node("span", { class: "badge" }, icon("pen", 17)), node("h2", {}, "派活"), shut);
    draft.redraw = null;
    if (!takers.length) {
      return [head, node("p", { class: "empty", style: "margin:12px 0 2px" }, TASKS ? `还没有接临时任务的规则。在 rules.json 里加一条来源是「${TASKS}」、类型以 task. 开头的规则，写明交给谁、在哪个目录，这里就能直接派活。` : "这台电脑没有来源的密钥，这里派不了活。")];
    }
    const nameOf = (id) => state.agents.find((each) => each.id === id)?.name ?? id;
    const which = node("select", { "aria-label": "交给哪条规则" }, takers.map((line) => node("option", { value: line.name, disabled: Boolean(line.paused) }, `${line.name} → ${nameOf(line.agent)}${state.projects?.[line.name] ? ` · ${state.projects[line.name]}` : ""}${line.paused ? "（暂停中）" : ""}`)));
    which.value = takers.some((line) => line.name === draft.line && !line.paused) ? draft.line : (takers.find((line) => !line.paused) ?? takers[0]).name;
    draft.line = which.value;
    const words = node("textarea", { placeholder: "写下要做的事，交给 Agent 去办。拿不准的它会回来问你。", maxlength: "4000", rows: "4", "aria-label": "要交代的事" });
    words.value = draft.text;
    const grow = () => ((words.style.height = "auto"), (words.style.height = `${Math.min(240, Math.max(96, words.scrollHeight))}px`));
    const chips = node("div", { class: "attaches" });
    const pick = node("input", { type: "file", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
    const left = node("span", { class: "remain" });
    const box = node("div", { class: "compose" }, words, chips,
      node("div", { class: "compose-bar" }, node("button", { class: "addfile", type: "button", onclick: () => pick.click() }, icon("clip", 16), "加附件"), node("span", {}, "也可以拖进来或粘贴"), left), pick);
    const hint = node("p", {});
    const back = node("button", { class: "small", type: "button" }, "取消");
    const go = node("button", { class: "go", type: "button" });
    const recent = node("div", { class: "recent" });

    const lineNow = () => takers.find((each) => each.name === which.value);
    const drawFiles = () =>
      chips.replaceChildren(...draft.files.map((each) =>
        node("div", { class: `attach ${each.state}`, title: each.why ? `${each.name}：${each.why}` : each.name },
          each.picture ? node("img", { src: each.picture, alt: "" }) : node("span", { class: "kind" }, icon("file", 15)),
          node("b", {}, each.name),
          node("span", {}, each.state === "bad" ? each.why : each.state === "up" ? "上传中…" : sizeOf(each.size)),
          node("button", { type: "button", "aria-label": `去掉 ${each.name}`, onclick: () => detach(each) }, icon("close", 13)),
        )));
    const drawFoot = () => {
      const line = lineNow();
      const going = draft.files.some((each) => each.state === "up");
      const failed = draft.files.some((each) => each.state === "bad");
      left.textContent = `${[...words.value].length} / 4000`;
      go.disabled = !words.value.trim() || !line || Boolean(line.paused) || going || failed || draft.sending;
      go.replaceChildren(icon("send", 15), draft.sending ? "正在派…" : draft.sure ? "确认派出" : "派出去");
      back.hidden = !draft.sure || draft.sending;
      hint.className = draft.done ? "good" : draft.sure || failed ? "warn" : "";
      hint.replaceChildren(
        ...(draft.done ? [icon("check", 15), draft.done]
          : failed ? ["有附件没传上去：去掉它，或者重新加。"]
          : going ? ["附件还在上传…"]
          : line?.paused ? ["这条规则暂停着，先在产线上恢复它。"]
          : draft.sure ? [`会真的启动「${nameOf(line.agent)}」，消耗你的额度。`]
          : MODE === "demo" ? ["演示模式：不会真的启动 Agent，附件也不保存。"]
          : [draft.files.length ? "附件会放进 Agent 的工作目录，它能直接读。" : "⌘ / Ctrl + 回车 派出"]),
      );
    };
    draft.redraw = () => (drawFiles(), drawFoot());
    const sendIt = async () => {
      const line = lineNow();
      const text = words.value.trim();
      if (go.disabled || !line) return void words.focus();
      if (MODE !== "demo" && !draft.sure) return void ((draft.sure = true), drawFoot());
      draft.sending = true;
      drawFoot();
      // A rule may take every kind of task: then this one is simply a new one.
      const type = line.types.find((each) => each.startsWith("task.")).replace(/\.\*$/, ".new");
      const sent = await send("api/tasks", { type, text, files: draft.files.map((each) => each.id) });
      Object.assign(draft, { sending: false, sure: false });
      if (sent) {
        for (const each of draft.files) if (each.picture) URL.revokeObjectURL(each.picture);
        Object.assign(draft, { text: "", files: [], done: `已派给「${nameOf(line.agent)}」，包裹进中台了。` });
        words.value = "";
        grow();
        setTimeout(() => ((draft.done = ""), draft.redraw?.()), 7000);
      }
      draft.redraw?.();
    };
    words.addEventListener("input", () => (Object.assign(draft, { text: words.value, sure: false, done: "" }), grow(), drawFoot()));
    words.addEventListener("keydown", (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.preventDefault(), sendIt()));
    words.addEventListener("paste", (event) => event.clipboardData?.files.length && (event.preventDefault(), attach(event.clipboardData.files)));
    which.addEventListener("change", () => ((draft.line = which.value), (draft.sure = false), drawFoot(), paintTask(current)));
    pick.addEventListener("change", () => (attach(pick.files), (pick.value = "")));
    for (const kind of ["dragenter", "dragover"]) box.addEventListener(kind, () => box.classList.add("dropping"));
    for (const kind of ["dragleave", "drop"]) box.addEventListener(kind, () => box.classList.remove("dropping"));
    go.addEventListener("click", sendIt);
    back.addEventListener("click", () => ((draft.sure = false), drawFoot()));
    draft.redraw();
    queueMicrotask(grow);
    return [head, node("label", { class: "towhom" }, node("span", {}, "交给"), which), box, node("div", { class: "sendrow" }, hint, back, go), recent];
  });
  if (open.task && !draft.shown) queueMicrotask(() => $("task").querySelector("textarea")?.focus());
  draft.shown = open.task;
  // What this line has been given lately, and how each went: the answer to "did it get there?".
  const recent = $("task").querySelector(".recent");
  if (!recent) return;
  const runs = state.runs.filter((run) => run.rule === draft.line).sort((a, b) => b.id - a.id).slice(0, 3);
  const key = JSON.stringify(runs.map((run) => [run.id, run.state, run.attempts, run.summary, run.error, run.finishedAt, run.claimedAt]));
  if (recent.dataset.key === key) return;
  recent.dataset.key = key;
  recent.replaceChildren(...(runs.length ? [node("h3", {}, "这条产线最近的活"), ...runs.map((run) => runRow(run, state))] : []));
}
/** A round in a line or two, for the lists inside the other cards. */
/**
 * A way back into the session a round was done in, where the hub kept one: the command that takes it up again in a
 * terminal, copied at a click; and the hub's own link, where it is of the one kind known here. What the hub passes on
 * is checked for its shape before it is put anywhere it could be followed or pasted.
 */
function sessionOf(run, agent) {
  if (agent?.use !== "claude" || !/^[0-9a-f][0-9a-f-]{7,63}$/i.test(run.session ?? "")) return null;
  const command = `claude --resume ${run.session}`;
  const copy = node("button", { class: "pill link", title: `复制「${command}」：在终端里粘贴，接着这一轮的会话往下聊` }, "会话");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    (navigator.clipboard?.writeText(command) ?? Promise.reject()).then(() => "命令已复制", () => command).then((words) => ((copy.textContent = words), setTimeout(() => (copy.textContent = "会话"), 2600)));
  });
  const link = /^claude:\/\/resume\?session=[0-9a-f-]{8,64}$/i.test(run.link ?? "") && node("a", { class: "pill link", href: run.link, title: "用 Claude Code 打开这一轮的会话" }, "打开");
  if (link) link.addEventListener("click", (event) => event.stopPropagation());
  return node("span", { class: "ways" }, copy, link);
}
function runRow(run, now) {
  const agent = now.agents.find((each) => each.id === run.agent);
  return node("div", { class: "row" },
    node("div", { class: "head" }, node("span", { class: "what" }, node("small", {}, `#${run.id}`), run.rule), node("span", { class: "when" }, clock(run.finishedAt ?? run.claimedAt ?? run.createdAt))),
    node("div", { class: "head" }, node("span", { class: "ways" }, stateOf(run), sessionOf(run, agent)), node("span", { class: "when" }, agent?.name ?? run.agent ?? "")),
    (run.summary || run.error) && node("div", { class: "said" }, !run.error ? run.summary : ENDED.includes(run.state) ? `卡在：${run.error}` : `上一次没跑成：${run.error}`),
  );
}
const FILTERS = [["all", "全部", () => true], ["live", "进行中", (run) => !ENDED.includes(run.state)], ["done", "做成了", (run) => run.state === "done"], ["other", "没做成 / 没事", (run) => ["nothing", "cancelled"].includes(run.state)]];
function paintFeed(now) {
  $("veil").hidden = $("feed").hidden = !open.feed;
  if (!open.feed) return;
  const shut = () => ((open.feed = false), paintFeed(current));
  const match = FILTERS.find(([id]) => id === open.filter)[2];
  const runs = now.runs.filter(match);
  const took = (run) =>
    run.state === "claimed" || run.state === "unknown" ? `已跑 ${spanOf(run.claimedAt, now.now)}`
    : kindOf(run) === "retrying" ? `第 ${run.attempts} 次 · ${clock(run.notBefore).slice(0, 5)} 再试`
    : run.state === "queued" ? "等人来领"
    : run.claimedAt ? `用时 ${spanOf(run.claimedAt, run.finishedAt)}` : "没开始";
  const line = (run) => {
    const agent = now.agents.find((each) => each.id === run.agent);
    const lane = town.lanes.get(run.rule);
    const pick = () => ((open.feed = false), (selected = null), select({ kind: "rule", id: run.rule }), paintFeed(current));
    const row = node("div", { class: "task", tabindex: "0", role: "button", onclick: pick },
      node("div", {}, stateOf(run)),
      node("div", { class: "what" },
        node("div", {}, node("small", {}, `#${run.id}`), node("b", {}, run.rule), lane && node("span", { class: "pill" }, dotOf(hex(lane.colour)), lane.project), run.manual && node("span", { class: "pill" }, "手动"), sessionOf(run, agent)),
        node("p", { title: run.error || run.summary || "" }, run.error ? (ENDED.includes(run.state) ? `卡在：${run.error}` : `上一次没跑成：${run.error}`) : run.summary || "还没有结论"),
      ),
      node("div", {}, node("span", { class: "pill" }, dotOf(hex(AGENT_TINTS[agent?.use] ?? 0x8fa6b8)), agent?.name ?? run.agent ?? "")),
      node("div", { class: "when" }, node("b", {}, clock(run.claimedAt ?? run.createdAt)), node("span", {}, took(run), run.usage?.cost ? ` · $${run.usage.cost.toFixed(3)}` : "")),
    );
    row.addEventListener("keydown", (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), pick()));
    return row;
  };
  const live = runs.filter((run) => !ENDED.includes(run.state));
  const over = runs.filter((run) => ENDED.includes(run.state));
  paint("feed", [open.filter, now.runs.map((run) => [run.id, run.state, run.attempts, run.summary, run.error]), live.length && Math.floor(Date.parse(now.now) / 5000)], () => [
    node("header", { class: "head" },
      node("span", { class: "badge" }, icon("list", 17)), node("div", { class: "title" }, node("h2", {}, "全部任务"), node("span", {}, `最近 ${now.runs.length} 轮 · 点一行，回到镇上看它的产线`)),
      node("div", { class: "tabs", role: "tablist" }, FILTERS.map(([id, name, test]) =>
        node("button", { role: "tab", "aria-selected": String(open.filter === id), class: open.filter === id ? "on" : "", onclick: () => ((open.filter = id), paintFeed(current)) }, name, node("i", {}, String(now.runs.filter(test).length))))),
      node("button", { class: "ghost", "aria-label": "关上", onclick: shut }, icon("close", 17)),
    ),
    node("div", { class: "tasks" },
      runs.length === 0 && node("div", { class: "none" }, icon("list", 26), node("p", {}, open.filter === "all" ? "还没有活。来一件事，它那台机器就会吐出一个包裹。" : "这一类现在没有。")),
      live.length > 0 && node("div", { class: "part" }, "进行中", node("i", {}, String(live.length))),
      ...live.map(line),
      over.length > 0 && node("div", { class: "part" }, "已结束", node("i", {}, String(over.length))),
      ...over.map(line),
    ),
  ]);
}
function paintDetail(state) {
  const panel = $("detail");
  if (!selected) return void (panel.hidden = true);
  const pair = (name, value) => [node("dt", {}, name), node("dd", {}, value)];
  const fine = (words) => node("p", { class: "fine" }, words);
  const runsOf = (match) => state.runs.filter(match).slice(0, 5);
  const recent = (runs) => (runs.length ? node("div", {}, runs.map((run) => runRow(run, state))) : node("div", { class: "empty" }, "最近没有轮次。"));
  const nameOf = (id) => state.agents.find((each) => each.id === id)?.name ?? id;
  const fromOf = (line) => (line.source === "schedule" ? `定时（${line.every}）` : (state.sources.find((each) => each.id === line.source)?.name ?? line.source));
  let title = "";
  let body = [];
  let key = [];
  if (selected.kind === "rule") {
    const line = state.lines.find((each) => each.name === selected.id);
    if (!line) return void (panel.hidden = true);
    const mine = runsOf((run) => run.rule === line.name);
    title = `产线 · ${line.name}`;
    key = [line, mine.map((run) => [run.id, run.state, run.attempts, run.summary])];
    body = [
      fine("一条规则就是一台机器：来了它管的事，它吐出一个包裹，顺着传送带送进 Webhook 中台。"),
      node("dl", {},
        pair("什么事归它", line.every ? `${line.every}，下一次 ${clock(line.next)}` : `${fromOf(line)} 的 ${line.types.join("、")}`),
        pair("交给", nameOf(line.agent)),
        pair("现在", line.paused ? `暂停中${line.paused.reason ? `（${line.paused.reason}）` : ""}` : `在跑 ${line.totals.running} · 排队 ${line.totals.queued}${line.totals.retrying ? `（${line.totals.retrying} 个等重试）` : ""}`),
      ),
      node("div", { class: "opts" }, node("button", { class: "primary", disabled: Boolean(line.paused), onclick: (event) => dispatch(line, event.currentTarget) }, "派一单")),
      recent(mine),
    ];
  } else if (selected.kind === "project") {
    const lines = state.lines.filter((line) => town.projects.find((project) => project.name === selected.id)?.lines.some((each) => each.name === line.name));
    title = `厂区 · ${selected.id}`;
    key = lines;
    body = [
      fine(state.projects ? "同一个项目目录下的规则在一个厂区里。" : "同一个来源的规则在一个厂区里。"),
      node("div", {}, lines.map((line) => node("div", { class: "row" }, node("div", { class: "head" }, node("span", { class: "what" }, line.name), node("span", { class: "when" }, standing(line, state)[0])), node("div", { class: "said" }, `${fromOf(line)} → ${nameOf(line.agent)}`)))),
    ];
  } else if (selected.kind === "hall") {
    const mine = runsOf((run) => ENDED.includes(run.state));
    title = "Webhook 中台";
    key = [state.totals, mine.map((run) => [run.id, run.state, run.summary])];
    body = [
      fine("这里就是中台。来的事都先上转盘排队；轮到了，包裹顺着传送带送到 Agent 面前；干完的回执再回到这里核对、记账。"),
      fine("传送带是画法上的简化：实际是每台电脑上的接单程序自己来领活，每次领活拿到一张只对这一轮有效的提货单。包裹没有加密，别人写的话也只当资料。"),
      node("dl", {}, pair("现在", `排队 ${state.totals.queued} · 在跑 ${state.totals.running} · 等你拍板 ${state.cards.length}`), ...todayOf(state).flatMap(([what, which, much]) => pair(what, much ? `${which} · ${much}` : which)), pair("查一轮的来龙去脉", node("code", {}, "agent-autoloop why <第几轮>"))),
      fine("「今天」几行和广场边告示牌上写的一样，是中台记的数。"),
      recent(mine),
    ];
  } else if (selected.kind === "agent") {
    const agent = state.agents.find((each) => each.id === selected.id);
    if (!agent) return void (panel.hidden = true);
    const mine = runsOf((run) => run.agent === agent.id);
    title = `Agent · ${agent.name}`;
    key = [agent, mine.map((run) => [run.id, run.state, run.summary])];
    body = [
      node("dl", {},
        pair("用的程序", agent.use), pair("接单程序", `${agent.worker}（${agent.online ? "在线" : "离线"}${agent.seenAt ? ` · 上次来 ${clock(agent.seenAt)}` : ""}）`),
        pair("现在", `在跑 ${agent.totals.running} · 排队 ${agent.totals.queued}`), pair("今天做成", `${agent.totals.doneToday ?? agent.totals.done ?? 0} 件（托盘上的箱子）`),
        pair("归它的产线", state.lines.filter((line) => line.agent === agent.id).map((line) => line.name).join("、") || "没有"),
      ),
      recent(mine),
    ];
  } else if (selected.kind === "post") {
    title = "邮局 · 通道";
    key = state.channels;
    body = [
      fine("邮局就是通道：桌面通知、飞书这些。它和别的一样是自己上门的：邮差到中台取卡片，送到你面前，再把你的回答带回去。"),
      state.channels.length === 0 && node("div", { class: "empty" }, "还没有接通道。卡片会留在中台门口等着，用命令行也能看、能答。"),
      node("div", {}, state.channels.map((channel) => node("div", { class: "row" }, node("div", { class: "head" }, node("span", { class: "what" }, channel.name), node("span", { class: `state ${channel.online ? "ok" : "quiet"}` }, icon(channel.online ? "check" : "dash", 14), channel.online ? "在线" : "离线")), channel.seenAt && node("div", { class: "said" }, `上次来取卡片 ${clock(channel.seenAt)}`)))),
    ];
  } else if (selected.kind === "timers") {
    title = "到点复查";
    key = state.timers;
    body = [
      fine("回执里可以约一个时间再来看一眼。到点了，它像一条新事件一样回到转盘上。"),
      state.timers.length === 0 && node("div", { class: "empty" }, "现在没有约好的复查。"),
      node("div", {}, state.timers.map((timer) => node("div", { class: "row" }, node("div", { class: "head" }, node("span", { class: "what" }, timer.rule), node("span", { class: "when" }, clock(timer.at))), node("div", { class: "said" }, timer.about ?? "")))),
    ];
  } else if (selected.kind === "lost") {
    title = "没人接的事件";
    key = state.unrouted.map((event) => event.id);
    body = [
      fine("进了门，但没有哪条规则要它。它留在这里，不派给任何 Agent。"),
      node("div", {}, state.unrouted.slice(0, 8).map((event) => node("div", { class: "row" }, node("div", { class: "head" }, node("span", { class: "what" }, event.type), node("span", { class: "when" }, clock(event.received_at ?? event.receivedAt))), node("div", { class: "said" }, `${event.source}${event.summary ? ` · ${event.summary}` : ""}`)))),
    ];
  } else {
    title = "你 · 最近拍过板的事";
    key = [state.channels, state.recentCards.slice(0, 6).map((card) => [card.id, card.state])];
    body = [
      fine("等你拍板的是卡片，不是那一轮：提问的那一轮已经结束了，这期间没有进程在跑，也不花钱。你答了，回答回到中台，Agent 接着干。"),
      node("dl", {}, pair("卡片怎么送到你面前", state.channels.length ? "邮差从邮局出发，到中台取卡片送来" : "还没接通道")),
      state.recentCards.length === 0 && node("div", { class: "empty" }, "还没有处理过的卡片。"),
      node("div", {}, state.recentCards.slice(0, 6).map((card) =>
        node("div", { class: "row" },
          node("div", { class: "head" }, node("span", { class: "what" }, card.title ?? ""), node("span", { class: "when" }, clock(card.decidedAt ?? card.closedAt ?? card.createdAt))),
          node("div", { class: "said" }, card.answer ? `你的决定：${card.answer}` : card.choice != null && card.options?.[card.choice] ? `你的决定：${card.options[card.choice]}` : (card.result ?? "")),
        ),
      )),
    ];
  }
  panel.hidden = false;
  paint("detail", [selected, key], () => [node("h2", {}, title, node("button", { class: "small", onclick: () => select(null) }, "收起")), ...body]);
}

function select(what) {
  const was = selected;
  selected = same(what, selected) ? null : what;
  if (selected?.kind === "house") open.cards = true;
  // Choosing an Agent turns the eye to it, to see what it is doing; letting it go takes the eye back.
  if (selected?.kind === "agent") watchAgent(selected.id);
  else if (was?.kind === "agent") stopChase();
  if (current) (paintTown(current), paintLines(current), paintCards(current), paintDetail(current));
}
function complain(words) {
  $("banner").hidden = !words;
  $("banner").replaceChildren(...(words ? [node("span", { class: "dot", style: "background:#dc4c43" }), words] : []));
}
function connection(ok, words) {
  $("conn").replaceChildren(node("span", { class: "dot", style: `background:${ok ? "#34a853" : "#dc4c43"}` }), node("span", {}, words));
}
function render(state) {
  const now = JSON.stringify([state.sources.map((each) => each.id), state.agents.map((each) => [each.id, each.use]), state.lines.map((line) => [line.name, line.source, line.agent, state.projects?.[line.name]])]);
  // While the day is played back, what the hub says now is only kept for afterwards; unless the town itself has
  // changed, which the day being played was not the day of.
  if (replay.on && now === shape) return void (replay.live = state);
  if (replay.on) quitReplay();
  if (now !== shape) (build(state), (shape = now));
  current = state;
  paintTown(state);
  paintLines(state);
  paintCount(state);
  paintStats(state);
  paintCards(state);
  paintTask(state);
  paintDetail(state);
  paintFeed(state);
}

// The row of buttons along the bottom: looking round, and opening what isn't always open.
function turnBy(angle) {
  const offset = camera.position.clone().sub(controls.target);
  const from = Math.atan2(offset.x, offset.z);
  const flat = Math.hypot(offset.x, offset.z);
  tween(0.5, (t) => camera.position.set(controls.target.x + Math.sin(from + angle * ease(t)) * flat, camera.position.y, controls.target.z + Math.cos(from + angle * ease(t)) * flat));
}
function zoomBy(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const to = offset.clone().multiplyScalar(THREE.MathUtils.clamp(factor, controls.minDistance / offset.length(), controls.maxDistance / offset.length()));
  tween(0.4, (t) => camera.position.copy(controls.target).add(offset.clone().lerp(to, ease(t))));
}
const DOCK = [
  ["全景", "home", () => overview()],
  ["左转", "left", () => turnBy(-Math.PI / 6)],
  ["右转", "right", () => turnBy(Math.PI / 6)],
  ["拉近", "nearer", () => zoomBy(0.75)],
  ["拉远", "farther", () => zoomBy(1.33)],
  ["名牌", "plate", () => tags.classList.toggle("bare")],
  ["昼夜", "moon", () => ((lookMode = { auto: "day", day: "night", night: "auto" }[lookMode]), paintClock(), restyle())],
  ["派活", "pen", () => ((open.task = !open.task), current && paintTask(current))],
  ["全部任务", "list", () => ((open.feed = !open.feed), current && paintFeed(current))],
  ["回放今天", "history", () => (replay.on ? closeReplay() : openReplay())],
  ["导播", "play", () => (setDirector(!director.on), (director.touched = -1e9))],
  ["收起", "close", () => setCalm(true)],
];
$("count").addEventListener("click", () => setCalm(false));
$("dock").replaceChildren(...DOCK.map(([name, drawing, act]) => node("button", { onclick: act }, icon(drawing, 22), name)));
$("veil").addEventListener("click", () => ((open.feed = false), current && paintFeed(current)));
addEventListener("keydown", (event) => event.key === "Escape" && open.feed && ((open.feed = false), current && paintFeed(current)));
addEventListener("keydown", (event) => event.key === "Escape" && replay.on && !open.feed && !chase && closeReplay());

// ------------------------------------------------------------------ every frame

const projected = new THREE.Vector3();
const where = new THREE.Vector3();
// For setting a falling leaf where it is.
const [leafHue, laid, spun, tumbled, unscaled] = [new THREE.Color(), new THREE.Matrix4(), new THREE.Quaternion(), new THREE.Euler(), new THREE.Vector3(1, 1, 1)];
let last = performance.now();
const pace = { frames: 0, since: Infinity, level: 0, slow: 0 };
// What is given up when the town is drawn too slowly, in this order. First fewer pixels, which can hardly be seen in a
// picture blurred toward its edges, for as long as it is under 40 frames a second; then, only under 26, what makes it
// look like a miniature: the grass far off, the soft shadow where things meet, the grass, the sharp shadows and glow.
// A drawing resolution set in the address is kept as it is.
const fewer = (ratio) => ({ below: 40, can: () => !new URLSearchParams(location.search).has("ratio") && renderer.getPixelRatio() > ratio, cut: () => (renderer.setPixelRatio(ratio), fit()) });
const CUTS = [
  fewer(1.25),
  fewer(1),
  { below: 26, can: () => blades.on && blades.reach.value.y > 105, cut: () => blades.reach.value.set(70, 105) },
  { below: 26, can: () => Boolean(contact?.enabled), cut: () => (contact.enabled = false) },
  { below: 26, can: () => blades.on, cut: () => (blades.on = false) },
  { below: 26, can: () => sun.shadow.mapSize.x > 2048 || Boolean(bloom?.enabled), cut: () => (sun.shadow.mapSize.set(2048, 2048), sun.shadow.map?.dispose(), (sun.shadow.map = null), bloom && (bloom.enabled = false), (LOOKS.night.bloom = 0)) },
];
/** Keeps it smooth on whatever it runs on: when frames keep coming slowly, the costliest effect goes, then the next. */
function keepPace(now) {
  if (now < pace.since) return;
  pace.frames += 1;
  if (now - pace.since < 3000) return;
  const rate = (pace.frames * 1000) / (now - pace.since);
  pace.frames = 0;
  pace.since = now;
  // What can still be given up next, and whether it is too slow for that: two counts in a row, so that a moment's
  // stutter doesn't cost anything.
  const step = CUTS.find((cut) => cut.can());
  pace.slow = step && rate < step.below && !document.hidden ? pace.slow + 1 : 0;
  if (pace.slow < 2) return;
  pace.slow = 0;
  pace.level += 1;
  step.cut();
}
function frame(now) {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  renderer.info.reset();
  keepPace(now);
  for (const mover of town ? [...town.movers] : []) {
    // A frame's time is fixed before anything in it runs, so a mover begun earlier in the same frame started "after" it:
    // not held at nought, its first step would be a little before its beginning, where a belt's curve has no point.
    let t = Math.min(1, Math.max(0, (now - mover.began) / (mover.seconds * 1000)));
    try {
      mover.step(t);
    } catch (error) {
      console.warn(error);
      window.TOWN.errors?.push(String(error?.stack ?? error).slice(0, 600));
      t = 1;
    }
    if (t >= 1) (town.movers.splice(town.movers.indexOf(mover), 1), mover.done());
  }
  direct(now);
  if (town && calendar.play) stepAhead(now);
  if (town && replay.on) stepReplay(now, elapsed);
  if (town && chase) stepChase(now, elapsed);
  controls.update(elapsed);
  camera.updateMatrixWorld();
  if (town) {
    const moving = !still.matches;
    const air = town.air;
    if (moving) wind.time.value += elapsed;
    for (const stand of town.turf) stand.mesh.visible = blades.on && camera.position.distanceTo(stand.centre) < blades.reach.value.y + stand.radius;
    if (air.streaks.visible && moving) {
      const spots = air.streaks.geometry.attributes.position;
      air.drops.forEach((drop, index) => {
        drop[1] -= elapsed * (52 + drop[3] * 18);
        if (drop[1] < 0) drop[1] += air.top;
        spots.setXYZ(index * 2, drop[0], drop[1], drop[2]);
        spots.setXYZ(index * 2 + 1, drop[0] + 0.5, drop[1] + 2.6, drop[2]);
      });
      spots.needsUpdate = true;
    }
    if (air.flakes.visible && moving) {
      const spots = air.flakes.geometry.attributes.position;
      air.bits.forEach((bit, index) => {
        bit[1] -= elapsed * (3.2 + bit[3] * 2.6);
        if (bit[1] < 0) bit[1] += air.top;
        spots.setXYZ(index, bit[0] + Math.sin(now / 900 + bit[3] * 40) * 1.6, bit[1], bit[2] + Math.cos(now / 1100 + bit[3] * 30) * 1.2);
      });
      spots.needsUpdate = true;
    }
    if (town.mist.banks.visible && moving) for (const { bank, home, beat } of town.mist.patches) bank.position.set(home.x + Math.sin(wind.time.value * 0.05 + beat) * 16, home.y, home.z + Math.cos(wind.time.value * 0.037 + beat * 1.7) * 11);
    if (air.leaves.mesh.visible && moving) {
      const { mesh, each, from } = air.leaves;
      for (let index = 0; index < mesh.count; index++) {
        const leaf = each[index];
        if (leaf.y > 0.07) ((leaf.y = Math.max(0.07, leaf.y - elapsed * leaf.pace)), (leaf.turn += elapsed * leaf.spin));
        else if ((leaf.lain += elapsed) > leaf.rest) {
          // It has lain a while where it came down: the next one lets go, from some tree or other.
          const tree = from[Math.floor(Math.random() * from.length)];
          Object.assign(leaf, { x: tree.x + (Math.random() - 0.5) * 4.6 * tree.size, z: tree.z + (Math.random() - 0.5) * 4.6 * tree.size, y: (2.6 + Math.random() * 3.6) * tree.size, pace: 0.9 + Math.random() * 0.9, spin: 1.4 + Math.random() * 2.6, turn: Math.random() * 6, beat: Math.random() * 30, lain: 0, rest: 2 + Math.random() * 8 });
          mesh.setColorAt(index, leafHue.setHex(tree.colour));
          mesh.instanceColor.needsUpdate = true;
        }
        const down = leaf.y <= 0.07;
        mesh.setMatrixAt(index, laid.compose(where.set(leaf.x + Math.sin(leaf.beat + leaf.turn * 0.6) * 0.7, leaf.y, leaf.z + Math.cos(leaf.beat * 1.3 + leaf.turn * 0.5) * 0.7), spun.setFromEuler(tumbled.set(down ? -Math.PI / 2 : leaf.turn * 0.7, leaf.turn, down ? 0 : leaf.turn * 0.4)), unscaled));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (skyNow() === "storm" && moving && now > air.nextFlash) ((air.flashUntil = now + 150), (air.nextFlash = now + 4500 + Math.random() * 9000));
    renderer.toneMappingExposure = town.exposure * (now < air.flashUntil ? 2.1 : 1);
    // The carousel never stops, and what's waiting goes round with it.
    if (moving) town.turn += elapsed * 0.3;
    if (town.hall.turntable) town.hall.turntable.rotation.y = -town.turn;
    for (const arm of moving ? (town.hall.arms ?? []) : []) {
      if (arm.busy) continue;
      arm.angle += arm.drift * elapsed;
      reach(arm, restOf(arm, where));
    }
    for (const entry of town.carousel) {
      if (entry.settling) continue;
      entry.parcel.position.copy(placeOf(entry));
      entry.parcel.rotation.y = -town.turn;
    }
    for (const belt of town.belts) if (belt.moving) belt.map.offset.y += (Math.sign(belt.moving) * elapsed * 8) / 1.3;
    for (const each of town.lamps) {
      const lit = now < (each.userData.until ?? 0);
      const colour = lit ? each.userData.flash : (each.userData.steady ?? null);
      each.material.emissive.setHex(colour ?? 0x000000);
      each.material.emissiveIntensity = lit ? 2.8 : colour === null ? 0 : 1;
      each.material.color.setHex(colour ?? 0xc9ced3);
    }
    if (town.folk) stepFolk(town.folk, moving ? Math.min(elapsed, 0.1) : 0, look().dark);
    for (const lane of town.lanes.values()) {
      const kicked = now < lane.boost;
      if (lane.spin && moving && (kicked || lane.running)) lane.spin.part.rotateOnAxis(lane.spin.axis, elapsed * (kicked ? 9 : 2.2));
      if (lane.press) lane.press.part.position.y = lane.press.home.y - (kicked ? Math.abs(Math.sin(now / 110)) * 0.5 : 0);
      // The building's own: gears that turn while a round runs (the small one faster, the other way), a dish that
      // swings round to a new heading as each event comes in, a bell that rings out as one comes in and dies away.
      if (lane.gears && moving && (kicked || lane.running)) {
        const [big, small] = lane.gears;
        const pace = elapsed * (kicked ? 2.6 : 0.8);
        big?.part.rotateOnAxis(big.axis, pace);
        small?.part.rotateOnAxis(small.axis, -pace * 1.5);
        lane.vent?.part.rotateOnAxis(lane.vent.axis, pace * 3.5);
      }
      // The watch post's hoods sweep round its light: fast while an alert's flash lasts, slowly while a round runs.
      const alerting = now < (lane.signal?.userData.until ?? 0);
      if (lane.beacon && moving && (alerting || lane.running)) lane.beacon.part.rotateOnAxis(lane.beacon.axis, elapsed * (alerting ? 7 : 1.4));
      if (lane.halo) {
        lane.halo.visible = alerting;
        if (alerting) lane.halo.material.opacity = moving ? 0.55 + 0.45 * Math.sin(now / 90) : 0.8;
      }
      if (lane.dish && Math.abs(lane.aim - lane.heading) > 0.001) {
        lane.heading += (lane.aim - lane.heading) * Math.min(1, elapsed * (moving ? 2.2 : 60));
        lane.dish.part.quaternion.copy(lane.dish.rest).multiply(twist.setFromAxisAngle(lane.dish.axis, lane.heading));
      }
      if (lane.bell) {
        const age = (now - lane.rang) / 1000;
        const swing = moving && age < 3 ? Math.sin(age * 12) * 0.5 * (1 - age / 3) ** 2 : 0;
        if (swing || lane.bell.swung) lane.bell.part.quaternion.copy(lane.bell.rest).multiply(twist.setFromAxisAngle(lane.bell.axis, swing));
        lane.bell.swung = Boolean(swing);
      }
      if (moving && (kicked || lane.running) && now > (lane.nextPuff ?? 0) && town.puffs.length < 40) {
        lane.nextPuff = now + (kicked ? 260 : 700);
        const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffMap, color: look().dark ? 0xaab4d6 : 0xffffff, transparent: true, depthWrite: false, opacity: 0.7 }));
        puff.position.copy(lane.note).setY(5.2);
        puff.scale.setScalar(1.3);
        puff.userData.flat = true;
        town.root.add(puff);
        town.puffs.push({ puff, born: now, drift: (Math.random() - 0.5) * 0.8 });
      }
    }
    for (const each of [...town.puffs]) {
      const age = (now - each.born) / 2600;
      each.puff.position.y += elapsed * 2.1;
      each.puff.position.x += elapsed * (0.6 + each.drift);
      each.puff.scale.setScalar(1.3 + age * 3.4);
      each.puff.material.opacity = 0.7 * (1 - age);
      if (age >= 1) (each.puff.removeFromParent(), each.puff.material.dispose(), town.puffs.splice(town.puffs.indexOf(each), 1));
    }
    for (const agent of town.agents.values()) {
      const jump = (now - agent.hopped) / 520;
      const twirl = (now - agent.twirled) / 820;
      const lift = (jump >= 0 && jump < 1 ? Math.sin(jump * Math.PI) * 1.4 : 0) + (!moving ? 0 : agent.busy ? Math.abs(Math.sin(now / 190)) * 0.3 : Math.sin(now / 620 + agent.at.z) * 0.07);
      agent.body.position.y = agent.baseY + lift;
      agent.body.rotation.y = agent.facing + (twirl >= 0 && twirl < 1 ? ease(twirl) * Math.PI * 2 : 0);
      if (agent.spark) {
        agent.spark.position.y = agent.sparkY + lift;
        if (moving) agent.spark.rotateZ(elapsed * (agent.busy ? 4.5 : 0.7));
        if (agent.spark.material?.emissive) (agent.spark.material.emissive.setHex(0xffe2a0), (agent.spark.material.emissiveIntensity = agent.busy ? 1.6 : look().glow * 0.6));
      }
      const beat = Math.max(0, 1 - (now - agent.beat) / 1500);
      agent.ring.material.emissiveIntensity = !agent.online ? 0 : agent.busy ? 1.5 + Math.sin(now / 240) * 0.6 : beat * 1.2 + look().glow * 0.35;
      if (agent.over) {
        const over = agent.over;
        if (moving) for (const { ring, pace } of over.rings) ring.rotation.y += elapsed * pace * (agent.busy ? 1.6 : 0.22);
        over.shone = THREE.MathUtils.damp(over.shone, agent.busy && agent.online ? 1 : 0, 3, elapsed);
        over.beam.visible = over.shone > 0.01;
        // Gentler after dark, when everything round it is dim and the same light would wash the figure out.
        over.beam.material.uniforms.opacity.value = over.shone * (0.4 + 0.06 * Math.sin(now / 330)) * (1 - look().glow * 0.5);
        over.gold.emissiveIntensity = over.shone * 0.5 + look().glow * 0.25;
        const { points, each, from, span } = over.motes;
        points.visible = over.beam.visible;
        if (points.visible) {
          points.material.opacity = over.shone * 0.9;
          const spots = points.geometry.attributes.position;
          each.forEach((mote, index) => {
            const round = mote.round + (now / 1000) * mote.turn;
            spots.setXYZ(index, Math.cos(round) * mote.far, from + (((now / 1000) * mote.pace + mote.start) % 1) * span, Math.sin(round) * mote.far);
          });
          spots.needsUpdate = true;
        }
      }
      for (const glass of agent.rose) glass.emissiveIntensity = !agent.online ? 0.04 : 0.16 + look().glow * 0.95 + (agent.busy ? 0.35 + Math.sin(now / 300) * 0.15 : 0);
    }
    const pond = town.pond;
    /** A ring spreading on the water from where something touched it. */
    const ripple = (x, z) => {
      const spare = pond.rings.reduce((oldest, each) => (each.born < oldest.born ? each : oldest));
      spare.born = now;
      spare.ring.position.set(x, 0.2, z);
    };
    if (moving && !pond.frozen) {
      const dark = look().dark ? 0.5 : 1;
      for (const each of pond.fish) {
        each.round += elapsed * each.pace * each.way * dark;
        const [x, z] = [pond.at.x + each.middle[0] + Math.cos(each.round) * each.reach[0], pond.at.z + each.middle[1] + Math.sin(each.round) * each.reach[1]];
        each.body.position.set(x, 0, z);
        each.body.rotation.y = Math.atan2(-Math.sin(each.round) * each.reach[0] * each.way, Math.cos(each.round) * each.reach[1] * each.way);
        each.tail.rotation.y = Math.sin(now / 130 + each.middle[0] * 9) * 0.55;
        // Now and then one comes up and breaks the surface.
        if (now > each.rise) ((each.rise = now + 7000 + Math.random() * 16000), ripple(x, z));
      }
      const fall = SKIES[skyNow()].fall;
      for (const each of pond.frogs) {
        if (each.to) {
          const t = Math.min(1, (now - each.began) / 620);
          each.frog.position.lerpVectors(each.from, each.to, t);
          each.frog.position.y += Math.sin(t * Math.PI) * 1.1;
          if (t >= 1) ((each.to = null), ripple(each.frog.position.x, each.frog.position.z));
        } else if (now > each.next) {
          // To a leaf near by that no other frog is on. In the rain they are livelier.
          const taken = new Set(pond.frogs.map((other) => other.leaf));
          const near = pond.leaves.map((leaf, index) => [index, leaf.distanceTo(pond.leaves[each.leaf])]).filter(([index, far]) => !taken.has(index) && far > 1.2 && far < 7).sort((a, b) => a[1] - b[1]);
          each.next = now + (fall ? 2500 : 6000) + Math.random() * (fall ? 5000 : 14000);
          if (near.length) {
            const [leaf] = near[Math.floor(Math.random() * Math.min(3, near.length))];
            ((each.from = pond.leaves[each.leaf].clone()), (each.to = pond.leaves[leaf].clone()), (each.leaf = leaf), (each.began = now));
            each.frog.rotation.y = Math.atan2(each.to.x - each.from.x, each.to.z - each.from.z);
            ripple(each.from.x, each.from.z);
          }
        }
      }
      // Rain on the water.
      if (fall && fall !== "snow" && now > pond.nextDrop) {
        pond.nextDrop = now + (fall === "drizzle" ? 260 : 110);
        const angle = Math.random() * Math.PI * 2;
        const out = Math.sqrt(Math.random());
        ripple(pond.at.x + Math.cos(angle) * out * 8.2, pond.at.z + Math.sin(angle) * out * 6.2);
      }
    }
    for (const each of pond.rings) {
      const age = (now - each.born) / 1500;
      each.ring.visible = age < 1 && !pond.frozen;
      if (!each.ring.visible) continue;
      each.ring.scale.setScalar(0.3 + age * 1.7);
      each.ring.material.opacity = 0.6 * (1 - age);
    }
    const life = town.life;
    if (life.wings.visible) {
      const [mx, mz] = town.frame.middle;
      life.birds.forEach((bird, index) => {
        bird.round += (elapsed * bird.pace * bird.way) / bird.far;
        const far = bird.far + Math.sin(now / 7000 + bird.beat) * 5;
        const heading = Math.atan2(-Math.sin(bird.round) * bird.way, Math.cos(bird.round) * 0.8 * bird.way);
        // They beat in bursts and glide between.
        const flap = 0.15 + Math.sin(now / 95 + bird.beat * 3) * 0.75 * (0.3 + 0.7 * Math.max(0, Math.sin(now / 1900 + bird.beat)));
        pose.position.set(mx + Math.cos(bird.round) * far, bird.high + Math.sin(now / 2300 + bird.beat) * 1.5, mz + Math.sin(bird.round) * far * 0.8);
        pose.scale.setScalar(1.5);
        pose.rotation.set(0, heading, 0);
        pose.updateMatrix();
        life.bodies.setMatrixAt(index, pose.matrix);
        // The far wing is the near one turned right over, so that both are lit from above.
        for (const side of [0, 1]) {
          pose.rotation.set(0, heading, side ? Math.PI - flap : flap);
          pose.updateMatrix();
          life.wings.setMatrixAt(index * 2 + side, pose.matrix);
        }
      });
      life.bodies.instanceMatrix.needsUpdate = life.wings.instanceMatrix.needsUpdate = true;
    }
    if (life.flutter.visible) {
      life.flyers.forEach((flyer, index) => {
        const t = (now / 1000) * flyer.pace + flyer.beat;
        pose.position.set(flyer.home.x + Math.cos(t) * flyer.far + Math.sin(t * 2.7) * 0.5, flyer.home.y + Math.sin(t * 3.1) * 0.35, flyer.home.z + Math.sin(t * 1.3) * flyer.far + Math.cos(t * 2.1) * 0.5);
        if (pose.position.distanceToSquared(flyer.was) > 1e-7) flyer.heading = Math.atan2(pose.position.x - flyer.was.x, pose.position.z - flyer.was.z);
        flyer.was.copy(pose.position);
        const flap = Math.abs(Math.sin(now / 55 + flyer.beat)) * 1.25;
        pose.scale.setScalar(1);
        for (const side of [0, 1]) {
          pose.rotation.set(0, flyer.heading, side ? Math.PI - flap : flap);
          pose.updateMatrix();
          life.flutter.setMatrixAt(index * 2 + side, pose.matrix);
        }
      });
      life.flutter.instanceMatrix.needsUpdate = true;
    }
    if (life.glow.visible) {
      const { position, color } = life.glow.geometry.attributes;
      life.sparks.forEach((spark, index) => {
        const t = (now / 1000) * spark.pace + spark.beat;
        position.setXYZ(index, spark.home.x + Math.sin(t * 0.7) * 1.6 + Math.sin(t * 1.9) * 0.4, spark.home.y + Math.sin(t * 1.1) * 0.5, spark.home.z + Math.cos(t * 0.6) * 1.6 + Math.cos(t * 2.3) * 0.4);
        const lit = Math.max(0, Math.sin(t * 1.7)) ** 3 * 2.4;
        color.setXYZ(index, 0.78 * lit, lit, 0.3 * lit);
      });
      position.needsUpdate = color.needsUpdate = true;
    }
    const width = holder.clientWidth;
    const height = holder.clientHeight;
    const put = (element, point, scale = 1) => {
      projected.copy(point).project(camera);
      const seen = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      element.style.display = seen ? "" : "none";
      if (seen) element.style.transform = `translate(-50%, -100%) translate(${((projected.x + 1) / 2) * width}px, ${((1 - projected.y) / 2) * height}px)${scale === 1 ? "" : ` scale(${scale.toFixed(3)})`}`;
    };
    for (const entry of town.tags) put(entry.element, entry.at);
    for (const note of [...town.notes]) {
      if (now > note.until) {
        note.element.remove();
        town.notes.splice(town.notes.indexOf(note), 1);
      } else {
        const point = note.target.isVector3 ? note.target : note.target.getWorldPosition(where).setY(where.y + 2.6);
        // A burst hangs in the town like a thing in it: from near by it is big; from the whole-town view, its least.
        put(note.element, point, note.burst ? Math.min(2.2, Math.max(1, 75 / camera.position.distanceTo(point))) : 1);
      }
    }
    // A round's plate rides with its parcel while that is on a belt; at the Agent's, only from near by.
    for (const [run, story] of stories) {
      const parcel = story.parcel?.parent ? story.parcel : null;
      const riding = ["in", "out", "back"].includes(story.phase);
      if (parcel && (riding || (story.phase === "work" && (chase?.run === run || camera.position.distanceTo(parcel.getWorldPosition(where)) < 110)))) put(story.plate, parcel.getWorldPosition(where).setY(where.y + 1.5));
      else story.plate.style.display = "none";
      if ((story.phase === "done" && now - story.ended > 9000) || (!known.runs.has(run) && now - story.born > 120_000)) (story.plate.remove(), stories.delete(run));
    }
    // What an Agent is doing, beside it: from near by, or when the eye is on it.
    for (const [id, entry] of town.agents) {
      const work = workOf(id, entry);
      const watched = chase && (chase.agent === id || (chase.run !== undefined && stories.get(chase.run)?.agent === id && ["work", "done"].includes(stories.get(chase.run).phase)));
      const wanted = Boolean(work) && (watched || (selected?.kind === "agent" && selected.id === id) || (!chase && camera.position.distanceTo(entry.at) < 62));
      if (!wanted) {
        if (entry.bubble) ((entry.bubble.wanted = false), (entry.bubble.element.style.display = "none"));
        continue;
      }
      const agent = current?.agents.find((each) => each.id === id);
      if (!agent) continue;
      const bubble = bubbleOf(entry, agent);
      if (bubble.run !== work.run) Object.assign(bubble, { run: work.run, steps: [], shown: 0, key: "" });
      bubble.wanted = true;
      paintBubble(entry, work);
      projected.set(entry.at.x, 4.6, entry.at.z).project(camera);
      const seen = projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2;
      bubble.element.style.display = seen ? "" : "none";
      if (seen) {
        const [x, y] = [((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height];
        // How wide the figure stands in the picture from here: the bubble keeps that far to one side of it.
        where.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(3.9).add(projected.set(entry.at.x, 4.6, entry.at.z)).project(camera);
        const half = Math.abs(((where.x + 1) / 2) * width - x) + 16;
        const flip = x - half < 330;
        bubble.element.classList.toggle("flip", flip);
        bubble.element.style.transform = flip ? `translate(${x + half}px, ${y}px) translate(0, -50%)` : `translate(${x - half}px, ${y}px) translate(-100%, -50%)`;
      }
    }
  }
  if (composer) composer.render();
  else renderer.render(scene, camera);
}

function fit() {
  const width = holder.clientWidth;
  const height = holder.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  composer?.setPixelRatio(renderer.getPixelRatio());
  composer?.setSize(width, height);
  if (tilt.length) (tilt[0].uniforms.dir.value.set(1 / width, 0), tilt[1].uniforms.dir.value.set(0, 1 / height));
  camera.aspect = width / height;
  // With the list out down the left side, the picture is moved over to stand clear of it.
  if (width > 1100 && !calm.on) camera.setViewOffset(width, height, -170, 0, width, height);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
new ResizeObserver(fit).observe(holder);

// A click picks what's under it; a drag turns the camera and picks nothing.
const ray = new THREE.Raycaster();
let pressed = null;
/** Points the picking ray through where the pointer is. */
function aim(event) {
  const area = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((event.clientX - area.left) / area.width) * 2 - 1, -((event.clientY - area.top) / area.height) * 2 + 1), camera);
}
/** The round whose parcel is under the pointer, if one is. */
function storyUnder(event) {
  const about = [...stories.values()].filter((story) => story.parcel?.parent);
  if (!town || !about.length) return null;
  aim(event);
  for (let part = ray.intersectObjects(about.map((story) => story.parcel), true)[0]?.object; part; part = part.parent) {
    const story = about.find((each) => each.parcel === part);
    if (story) return story;
  }
  return null;
}
function pickAt(event) {
  if (!town) return null;
  aim(event);
  let hit = ray.intersectObjects(town.picks, true)[0]?.object;
  while (hit && !hit.userData.pick) hit = hit.parent;
  return hit?.userData.pick ?? null;
}
renderer.domElement.addEventListener("pointerdown", (event) => (pressed = [event.clientX, event.clientY]));
renderer.domElement.addEventListener("pointerup", (event) => {
  if (!pressed || Math.hypot(event.clientX - pressed[0], event.clientY - pressed[1]) > 5) return;
  const story = storyUnder(event);
  if (story) return void chaseRun(story.run);
  const pick = pickAt(event);
  if (pick) select(pick);
});
renderer.domElement.addEventListener("pointermove", (event) => (renderer.domElement.style.cursor = event.buttons ? "grabbing" : pickAt(event) ? "pointer" : "grab"));

// ------------------------------------------------------------------ talking to the hub

let failures = 0;
let following = false;
async function refresh() {
  try {
    const response = await fetch("api/state", { headers: { "x-town-token": TOKEN }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `中台返回 ${response.status}`);
    failures = 0;
    render(data);
    if (!following) ((following = true), follow(data.seq));
    connection(true, MODE === "demo" ? "演示数据 · 实时" : `实时 · 连着中台 ${HUB}`);
  } catch (error) {
    failures += 1;
    connection(false, MODE === "demo" ? "演示数据断了" : `连不上中台（${error.message}）：先启动中台（agent-autoloop up）`);
  }
}

addEventListener("error", (event) => complain(`页面出错了：${event.message}`));
addEventListener("unhandledrejection", (event) => complain(`页面出错了：${event.reason?.message ?? event.reason}`));

await loadModels();
$("loading").remove();
fit();
paintClock();
setInterval(paintClock, 10_000);
askWeather();
setInterval(askWeather, 10 * 60_000);
renderer.setAnimationLoop(frame);
(async function loop() {
  await refresh();
  setTimeout(loop, failures ? 3000 : 1500);
})();
// For looking from a chosen spot, and counting, when checking the picture from outside.
window.TOWN.view = (from, at) => (camera.position.set(...from), controls.target.set(...at), controls.update());
window.TOWN.look = (mode) => ((lookMode = mode), paintClock(), restyle());
window.TOWN.sky = (kind) => ((weather.preview = kind), paintClock(), restyle());
window.TOWN.time = (value) => (value === undefined ? timeNow() : ((calendar.pretend = value === null ? null : new Date(value).getTime()), paintClock(), restyle()));
window.TOWN.lit = () => ({ ...look() });
window.TOWN.ahead = (kind) => playAhead(kind);
// The day played back: true opens it, false closes it, a time puts it there and holds it; with nothing, where it is.
window.TOWN.replay = (what) =>
  what === undefined ? { on: replay.on, playing: replay.playing, at: replay.at, from: replay.from, to: replay.to, runs: replay.runs.length, cards: replay.cards.length, spans: replay.spans.length, fast: Math.round(replay.fast), slow: Math.round(replay.slow) }
  : what === true ? openReplay()
  : what === false ? closeReplay()
  : void (replay.on && ((replay.playing = false), (replay.at = THREE.MathUtils.clamp(new Date(what).getTime(), replay.from, replay.to))));
window.TOWN.city = (name) => ((weather.city = name), (weather.live = null), askWeather().then(() => ({ ...weather.live, error: weather.error })));
window.TOWN.pace = () => ({ level: pace.level, pending, movers: town?.movers.length ?? 0, carousel: town?.carousel.length ?? 0, meshes: (() => { let count = 0; scene.traverse((part) => part.isMesh && part.visible && count++); return count; })() });
window.TOWN.frames = () => new Promise((done) => { let count = 0; const began = performance.now(); const tick = () => (++count, performance.now() - began < 2000 ? requestAnimationFrame(tick) : done(Math.round(count / 2))); requestAnimationFrame(tick); });
window.TOWN.models = () => [...fromBlender];
// Whatever went wrong while the page was open, kept so it can be read afterwards: errors here tend to come and go.
window.TOWN.errors = [];
addEventListener("error", (event) => window.TOWN.errors.length < 40 && window.TOWN.errors.push(String(event.error?.stack ?? event.message).slice(0, 600)));
addEventListener("unhandledrejection", (event) => window.TOWN.errors.length < 40 && window.TOWN.errors.push(String(event.reason?.stack ?? event.reason).slice(0, 600)));
// With "fps" in the address, a corner of the page says how fast it is drawn, how far it has cut back to keep up, and how
// many errors the page itself has met: to check it in a browser without opening the console. What a browser extension
// gets wrong never reaches the page, so it isn't counted here.
if (new URLSearchParams(location.search).has("fps")) {
  const meter = document.body.appendChild(document.createElement("div"));
  Object.assign(meter.style, { position: "fixed", left: "14px", bottom: "14px", zIndex: "60", padding: "6px 11px", borderRadius: "9px", background: "rgba(20, 24, 28, 0.74)", color: "#fff", font: "13px/1.5 ui-monospace, Menlo, monospace", pointerEvents: "none" });
  meter.textContent = "正在数帧…";
  let count = 0;
  let since = performance.now();
  const tick = (now) => {
    count++;
    if (now - since >= 1000) {
      meter.textContent = `每秒 ${Math.round((count * 1000) / (now - since))} 帧 · 清晰度 ${renderer.getPixelRatio()} · 画质降了 ${pace.level} 级 · 页面报错 ${window.TOWN.errors.length} 个`;
      [count, since] = [0, now];
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
window.TOWN.fine = (on) => (blades.on = on);
window.TOWN.director = (on) => (on === undefined ? { ...director, turning: controls.autoRotate } : setDirector(on));
window.TOWN.stories = () => [...stories.values()].map(({ run, rule, phase, agent }) => ({ run, rule, phase, agent }));
window.TOWN.chase = (what) => (what === undefined ? chase : what === null ? stopChase() : typeof what === "number" ? chaseRun(what) : watchAgent(what));
window.TOWN.peek = () => ({ town, camera, scene, renderer, wind, blades, pace, state: current, rebuild: (state) => (build(state ?? current), paintTown(state ?? current)) });
window.TOWN.drawn = () => ({ tufts: town.turf.reduce((sum, { mesh }) => sum + mesh.count, 0), stands: town.turf.length, shown: town.turf.filter(({ mesh }) => mesh.visible).length, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
window.TOWN.aim = () => {
  const toTarget = controls.target.clone().sub(camera.position).normalize();
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const plate = town.hall.tag;
  const drawn = plate.at.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  const shown = /translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(plate.element.style.transform);
  const [x, y] = [((drawn.x + 1) / 2) * holder.clientWidth, ((1 - drawn.y) / 2) * holder.clientHeight];
  return { aim: THREE.MathUtils.radToDeg(toTarget.angleTo(facing)), plate: shown ? Math.hypot(Number(shown[1]) - x, Number(shown[2]) - y) : 0 };
};
