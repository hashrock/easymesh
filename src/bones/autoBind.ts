import type { Bone, VertexWeights } from "../types";

/** Distance from point to line segment */
function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Auto-bind: assign each vertex 100% to its nearest bone.
 * This simulates "expanding bone influence outward" – equivalent to
 * nearest-bone Voronoi assignment.
 */
export function autoBind(
  points: [number, number][],
  bones: Bone[]
): VertexWeights[] {
  // Exclude the first bone (ROOT) from auto-bind
  const bindBones = bones.filter((_, i) => i > 0);
  if (bindBones.length === 0) return points.map(() => ({}));

  return points.map(([px, py]) => {
    let minDist = Infinity;
    let nearestId = bindBones[0].id;

    for (const bone of bindBones) {
      const dist = pointToSegmentDist(px, py, bone.headX, bone.headY, bone.tailX, bone.tailY);
      if (dist < minDist) {
        minDist = dist;
        nearestId = bone.id;
      }
    }

    return { [nearestId]: 1.0 };
  });
}

/**
 * Apply weight paint brush.
 * Adds weight to activeBoneId for vertices near brushCenter, then normalizes.
 */
export function applyWeightPaint(
  points: [number, number][],
  weights: VertexWeights[],
  brushCenter: [number, number],
  brushRadius: number,
  brushStrength: number,
  activeBoneId: string
): VertexWeights[] {
  const newWeights = weights.map((w) => ({ ...w }));
  const [bx, by] = brushCenter;

  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[i];
    const dist = Math.hypot(px - bx, py - by);
    if (dist > brushRadius) continue;

    const falloff = 1 - dist / brushRadius;
    const delta = brushStrength * falloff;
    const current = newWeights[i][activeBoneId] ?? 0;
    newWeights[i][activeBoneId] = Math.min(1, current + delta);

    // Normalize
    normalizeWeights(newWeights[i]);
  }

  return newWeights;
}

/**
 * Set weights for specific vertices to specific values, then normalize.
 */
export function setVertexWeight(
  weights: VertexWeights[],
  vertexIndices: number[],
  boneId: string,
  value: number
): VertexWeights[] {
  const newWeights = weights.map((w) => ({ ...w }));

  for (const idx of vertexIndices) {
    newWeights[idx][boneId] = Math.max(0, Math.min(1, value));
    normalizeWeights(newWeights[idx]);
  }

  return newWeights;
}

function normalizeWeights(w: VertexWeights): void {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum === 0) return;
  for (const key of Object.keys(w)) {
    w[key] /= sum;
    if (w[key] < 0.001) delete w[key]; // prune tiny weights
  }
}
