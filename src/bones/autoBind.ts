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
/** Get a bone and all its descendants */
function getDescendants(bones: Bone[], rootId: string): Set<string> {
  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.add(id);
    for (const b of bones) {
      if (b.parentId === id && !result.has(b.id)) queue.push(b.id);
    }
  }
  return result;
}

export function autoBind(
  points: [number, number][],
  bones: Bone[],
  attachBoneId?: string | null
): VertexWeights[] {
  // If attached to a bone, that bone gets implicit 100% weight as base.
  // Child bones of the attach bone can override via nearest-bone assignment.
  if (attachBoneId) {
    const descendants = getDescendants(bones, attachBoneId);
    // Child bones (excluding the attach bone itself) for local deformation
    const childBones = bones.filter(b => descendants.has(b.id) && b.id !== attachBoneId);

    if (childBones.length === 0) {
      // No children: all vertices follow the attach bone
      return points.map(() => ({ [attachBoneId]: 1.0 }));
    }

    // Assign each vertex to nearest child bone, or fall back to attach bone
    return points.map(([px, py]) => {
      let minDist = Infinity;
      let nearestId = attachBoneId;

      for (const bone of childBones) {
        const dist = pointToSegmentDist(px, py, bone.headX, bone.headY, bone.tailX, bone.tailY);
        if (dist < minDist) {
          minDist = dist;
          nearestId = bone.id;
        }
      }

      // Always include attach bone with some weight for parent following
      // Vertices close to a child bone: mostly child. Far from all children: mostly attach.
      const attachDist = pointToSegmentDist(px, py,
        bones.find(b => b.id === attachBoneId)!.headX, bones.find(b => b.id === attachBoneId)!.headY,
        bones.find(b => b.id === attachBoneId)!.tailX, bones.find(b => b.id === attachBoneId)!.tailY);

      if (nearestId === attachBoneId) {
        return { [attachBoneId]: 1.0 };
      }

      // Blend: if vertex is much closer to child than attach, mostly child
      const ratio = Math.min(1, minDist / (attachDist + 1));
      if (ratio > 0.8) {
        // Far from child bones, use attach bone
        return { [attachBoneId]: 1.0 };
      }
      return { [nearestId]: 1.0 };
    });
  }

  // No attach bone: use all non-ROOT bones
  const bindBones = bones.filter((_, i) => i > 0);
  if (bindBones.length === 0) return points.map(() => ({}));

  return points.map(([px, py]) => {
    let minDist = Infinity;
    let nearestId = bindBones[0].id;
    for (const bone of bindBones) {
      const dist = pointToSegmentDist(px, py, bone.headX, bone.headY, bone.tailX, bone.tailY);
      if (dist < minDist) { minDist = dist; nearestId = bone.id; }
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
