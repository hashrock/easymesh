import type { Bone, BoneTransform, BoneKeyframe, AnimationClip, VertexWeights } from "../types";

const IDENTITY_TRANSFORM: BoneTransform = { rotation: 0, translateX: 0, translateY: 0 };

/** Create a new empty animation clip with per-bone tracks */
export function createClip(name: string, duration: number, bones: Bone[]): AnimationClip {
  const tracks: Record<string, BoneKeyframe[]> = {};
  for (const bone of bones) {
    tracks[bone.id] = [
      { time: 0, transform: { ...IDENTITY_TRANSFORM } },
    ];
  }
  return { name, duration, tracks };
}

/** Lerp between two transforms */
function lerpTransform(a: BoneTransform, b: BoneTransform, t: number): BoneTransform {
  return {
    rotation: a.rotation + (b.rotation - a.rotation) * t,
    translateX: a.translateX + (b.translateX - a.translateX) * t,
    translateY: a.translateY + (b.translateY - a.translateY) * t,
  };
}

/** Evaluate a single bone's track at a given time */
function evaluateTrack(track: BoneKeyframe[], time: number): BoneTransform {
  if (track.length === 0) return { ...IDENTITY_TRANSFORM };
  if (track.length === 1) return { ...track[0].transform };

  // Before first keyframe
  if (time <= track[0].time) return { ...track[0].transform };
  // After last keyframe
  if (time >= track[track.length - 1].time) return { ...track[track.length - 1].transform };

  // Find surrounding keyframes
  for (let i = 0; i < track.length - 1; i++) {
    if (track[i].time <= time && track[i + 1].time >= time) {
      const alpha = (time - track[i].time) / (track[i + 1].time - track[i].time);
      return lerpTransform(track[i].transform, track[i + 1].transform, alpha);
    }
  }
  return { ...track[track.length - 1].transform };
}

/** Evaluate animation at a given time, returning interpolated transforms per bone */
export function evaluateAnimation(
  clip: AnimationClip,
  time: number
): Record<string, BoneTransform> {
  const t = Math.max(0, Math.min(clip.duration, time));
  const result: Record<string, BoneTransform> = {};
  for (const [boneId, track] of Object.entries(clip.tracks)) {
    result[boneId] = evaluateTrack(track, t);
  }
  return result;
}

/** World-space transform: combined rotation + translation */
interface WorldTransform {
  rotation: number;
  tx: number; // world translate X
  ty: number; // world translate Y
  pivotX: number; // pivot (bone head) in world space
  pivotY: number;
}

/**
 * Compute world-space transforms by walking the bone hierarchy (parent → child).
 * Each child inherits its parent's rotation and translation.
 */
function computeWorldTransforms(
  bones: Bone[],
  localTransforms: Record<string, BoneTransform>
): Record<string, WorldTransform> {
  const boneMap = new Map<string, Bone>();
  for (const bone of bones) boneMap.set(bone.id, bone);

  const world: Record<string, WorldTransform> = {};

  // Topological order: process parents before children
  const processed = new Set<string>();
  const queue = bones.filter(b => !b.parentId);
  while (queue.length > 0) {
    const bone = queue.shift()!;
    if (processed.has(bone.id)) continue;
    processed.add(bone.id);

    const local = localTransforms[bone.id] ?? { rotation: 0, translateX: 0, translateY: 0 };

    if (!bone.parentId || !world[bone.parentId]) {
      // Root bone: local = world
      world[bone.id] = {
        rotation: local.rotation,
        tx: local.translateX,
        ty: local.translateY,
        pivotX: bone.headX,
        pivotY: bone.headY,
      };
    } else {
      // Child bone: apply parent's world transform to this bone's head to get new pivot
      const parent = world[bone.parentId];
      const parentBone = boneMap.get(bone.parentId)!;

      // Transform bone head through parent's world transform
      const cos = Math.cos(parent.rotation);
      const sin = Math.sin(parent.rotation);
      const dx = bone.headX - parentBone.headX;
      const dy = bone.headY - parentBone.headY;
      const worldPivotX = parentBone.headX + dx * cos - dy * sin + parent.tx;
      const worldPivotY = parentBone.headY + dx * sin + dy * cos + parent.ty;

      world[bone.id] = {
        rotation: parent.rotation + local.rotation,
        tx: (worldPivotX - bone.headX) + local.translateX,
        ty: (worldPivotY - bone.headY) + local.translateY,
        pivotX: worldPivotX,
        pivotY: worldPivotY,
      };
    }

    // Enqueue children
    for (const b of bones) {
      if (b.parentId === bone.id && !processed.has(b.id)) {
        queue.push(b);
      }
    }
  }

  return world;
}

/**
 * Deform mesh vertices based on bone transforms and weights.
 * Uses Linear Blend Skinning (LBS) with hierarchical transform propagation.
 */
export function deformMesh(
  restPoints: [number, number][],
  bones: Bone[],
  transforms: Record<string, BoneTransform>,
  weights: VertexWeights[]
): [number, number][] {
  const worldTf = computeWorldTransforms(bones, transforms);

  const boneMap = new Map<string, Bone>();
  for (const bone of bones) boneMap.set(bone.id, bone);

  const result: [number, number][] = new Array(restPoints.length);

  for (let i = 0; i < restPoints.length; i++) {
    const [px, py] = restPoints[i];
    const w = weights[i];
    if (!w || Object.keys(w).length === 0) {
      result[i] = [px, py];
      continue;
    }

    let outX = 0;
    let outY = 0;

    for (const [boneId, weight] of Object.entries(w)) {
      if (weight === 0) continue;
      const bone = boneMap.get(boneId);
      const wt = worldTf[boneId];
      if (!bone || !wt) {
        outX += px * weight;
        outY += py * weight;
        continue;
      }

      // Apply world transform: rotate around rest-pose bone head, then translate
      const cos = Math.cos(wt.rotation);
      const sin = Math.sin(wt.rotation);
      const dx = px - bone.headX;
      const dy = py - bone.headY;
      const rx = bone.headX + dx * cos - dy * sin + wt.tx;
      const ry = bone.headY + dx * sin + dy * cos + wt.ty;

      outX += rx * weight;
      outY += ry * weight;
    }

    result[i] = [outX, outY];
  }

  return result;
}
