import { readFileSync } from "node:fs";
import { capcutUuid } from "./uuid.js";

// Video-segment aux arrays (kept for the empty-timeline template test).
export const AUX_KEYS = [
  "canvases", "material_animations", "placeholder_infos", "speeds",
  "sound_channel_mappings", "material_colors", "loudnesses", "vocal_separations",
];

let BUNDLE = null;
function bundle() {
  if (!BUNDLE) BUNDLE = JSON.parse(readFileSync(new URL("./templates/capcut-templates.json", import.meta.url), "utf8"));
  return BUNDLE;
}

// id -> { key, material } across ALL material arrays of a draft.
export function auxAll(raw) {
  const idx = new Map();
  for (const [key, v] of Object.entries(raw.materials || {})) {
    if (Array.isArray(v)) for (const m of v) if (m && m.id) idx.set(m.id, { key, material: m });
  }
  return idx;
}

// Material arrays that must NOT be inherited when cloning a template segment —
// transitions/effects are applied explicitly, never carried over from the template.
const EXCLUDE_KEYS = new Set(["transitions", "video_effects", "audio_effects"]);

// Clone a template segment + its aux materials with fresh UUIDs.
// tmpl = segment object; auxById = Map<id,{key,material}>. Returns {segment, aux}.
function cloneSegmentWithAux(tmpl, auxById) {
  const seg = structuredClone(tmpl);
  seg.id = capcutUuid();
  const aux = [];
  seg.extra_material_refs = (tmpl.extra_material_refs || []).map((ref) => {
    const found = auxById.get(ref);
    if (!found) return ref;                     // unknown non-material ref: keep verbatim
    if (EXCLUDE_KEYS.has(found.key)) return null; // never inherit transitions/effects
    const cloned = structuredClone(found.material);
    cloned.id = capcutUuid();
    aux.push({ __key: found.key, ...cloned });
    return cloned.id;
  }).filter((r) => r !== null);
  return { segment: seg, aux };
}

// Video segment: prefer an existing timeline clip to clone; else the bundle.
export function cloneVideoSegment(raw, { materialId, startUs, durationUs, scale = 1, auxIndex = null }) {
  const vt = (raw.tracks || []).find((t) => t.type === "video");
  const existing = vt?.segments?.find((s) => s.clip && (s.extra_material_refs || []).length);
  const { segment, aux } = existing
    ? cloneSegmentWithAux(existing, auxIndex || auxAll(raw))
    : cloneSegmentWithAux(bundle().videoSegment, auxMap(bundle().videoAux));
  segment.material_id = materialId;
  segment.target_timerange = { start: Math.round(startUs), duration: Math.round(durationUs) };
  segment.source_timerange = { start: 0, duration: Math.round(durationUs) };
  segment.clip = segment.clip || {};
  segment.clip.scale = { x: scale, y: scale };
  segment.common_keyframes = [];
  segment.keyframe_refs = [];
  return { segment, aux };
}

// Audio segment: prefer an existing one; else the bundle.
export function cloneAudioSegment(raw, { materialId, startUs, durationUs }) {
  const at = (raw.tracks || []).find((t) => t.type === "audio");
  const existing = at?.segments?.find((s) => (s.extra_material_refs || []).length);
  const { segment, aux } = existing
    ? cloneSegmentWithAux(existing, auxAll(raw))
    : cloneSegmentWithAux(bundle().audioSegment, auxMap(bundle().audioAux));
  segment.material_id = materialId;
  segment.target_timerange = { start: Math.round(startUs), duration: Math.round(durationUs) };
  segment.source_timerange = { start: 0, duration: Math.round(durationUs) };
  return { segment, aux };
}

function auxMap(list) {
  const m = new Map();
  for (const a of list) m.set(a.material.id, { key: a.key, material: a.material });
  return m;
}

// Build a materials.videos entry (type "photo" or "video") from a pool item.
export function makeVisualMaterial({ path, name, width, height, durationUs, type = "photo" }) {
  const m = structuredClone(bundle().photoMaterial);
  m.id = capcutUuid();
  m.type = type;
  m.path = path;
  m.material_name = name || (path || "").split(/[\\/]/).pop();
  if (width) m.width = width;
  if (height) m.height = height;
  if (typeof durationUs === "number") m.duration = durationUs;
  m.has_audio = type === "video";
  m.md5 = "";
  if ("local_material_id" in m) m.local_material_id = "";
  return m;
}

// Fresh empty video/audio track skeletons (for a draft that has no tracks yet).
export function makeVideoTrack() { const t = structuredClone(bundle().videoTrack); t.id = capcutUuid(); t.segments = []; return t; }
export function makeAudioTrack() { const t = structuredClone(bundle().audioTrack); t.id = capcutUuid(); t.segments = []; return t; }

// Build a materials.audios entry from a pool audio item.
export function makeAudioMaterial({ path, name, durationUs }) {
  const m = structuredClone(bundle().audioMaterial);
  m.id = capcutUuid();
  m.path = path;
  m.material_name = name || (path || "").split(/[\\/]/).pop();
  if ('local_material_id' in m) m.local_material_id = '';
  if (typeof durationUs === "number") m.duration = durationUs;
  return m;
}
