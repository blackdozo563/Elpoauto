import { randomBytes } from "node:crypto";

// A CapCut-style UUID (8-4-4-4-12 hex). CapCut mixes case across groups; the
// exact casing is cosmetic — what matters is a valid, unique id per material/segment.
export function capcutUuid() {
  const h = randomBytes(16).toString("hex").toUpperCase();
  const g = (a, b) => h.slice(a, b);
  return `${g(0, 8)}-${g(8, 12)}-${g(12, 16).toLowerCase()}-${g(16, 20)}-${g(20, 32)}`;
}
