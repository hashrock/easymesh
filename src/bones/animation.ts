import type { Bone, BoneTransform, Keyframe, AnimationClip, VertexWeights } from "../types";

const IDENTITY_TRANSFORM: BoneTransform = { rotation: 0, translateX: 0, translateY: 0 };

/** Create a default keyframe with identity transforms for all bones */
export function createKeyframe(time: number, bones: Bone[]): Keyframe {
  const transforms: Record<string, BoneTransform> = {};
  for (const bone of bones) {
    transforms[bone.id] = { ...IDENTITY_TRANSFORM };
  }
  return { time, transforms };
}

/** Create a new empty animation clip */
export function createClip(name: string, duration: number, bones: Bone[]): AnimationClip {
  return {
    name,
    duration,
    keyframes: [createKeyframe(0, bones)],
  };
}

/** Lerp between two transforms */
function lerpTransform(a: BoneTransform, b: BoneTransform, t: number): BoneTransform {
  return {
    rotation: a.rotation + (b.rotation - a.rotation) * t,
    translateX: a.translateX + (b.translateX - a.translateX) * t,
    translateY: a.translateY + (b.translateY - a.translateY) * t,
  };
}

/** Evaluate animation at a given time, returning interpolated transforms per bone */
export function evaluateAnimation(
  clip: AnimationClip,
  time: number
): Record<string, BoneTransform> {
  const kfs = clip.keyframes;
  if (kfs.length === 0) return {};
  if (kfs.length === 1) return { ...kfs[0].transforms };

  // Clamp and find surrounding keyframes
  const t = Math.max(0, Math.min(clip.duration, time));

  // Find the two keyframes surrounding t
  let prev = kfs[0];
  let next = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].time <= t && kfs[i + 1].time >= t) {
      prev = kfs[i];
      next = kfs[i + 1];
      break;
    }
  }

  if (prev.time === next.time) return { ...prev.transforms };

  const alpha = (t - prev.time) / (next.time - prev.time);
  const result: Record<string, BoneTransform> = {};

  const allBoneIds = new Set([...Object.keys(prev.transforms), ...Object.keys(next.transforms)]);
  for (const id of allBoneIds) {
    const a = prev.transforms[id] ?? IDENTITY_TRANSFORM;
    const b = next.transforms[id] ?? IDENTITY_TRANSFORM;
    result[id] = lerpTransform(a, b, alpha);
  }

  return result;
}

/**
 * Deform mesh vertices based on bone transforms and weights.
 * Uses Linear Blend Skinning (LBS).
 */
export function deformMesh(
  restPoints: [number, number][],
  bones: Bone[],
  transforms: Record<string, BoneTransform>,
  weights: VertexWeights[]
): [number, number][] {
  // Build bone origin map (head position as pivot)
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
      const tf = transforms[boneId];
      if (!bone || !tf) {
        outX += px * weight;
        outY += py * weight;
        continue;
      }

      // Pivot is bone head
      const cx = bone.headX;
      const cy = bone.headY;

      // Rotate around pivot, then translate
      const cos = Math.cos(tf.rotation);
      const sin = Math.sin(tf.rotation);
      const dx = px - cx;
      const dy = py - cy;
      const rx = cx + dx * cos - dy * sin + tf.translateX;
      const ry = cy + dx * sin + dy * cos + tf.translateY;

      outX += rx * weight;
      outY += ry * weight;
    }

    result[i] = [outX, outY];
  }

  return result;
}
