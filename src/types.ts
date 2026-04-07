export interface Bone {
  id: string;
  name: string;
  headX: number;
  headY: number;
  tailX: number;
  tailY: number;
  parentId: string | null;
}

// Per-vertex weight map: boneId -> weight (0..1), sum should be 1.0
export type VertexWeights = Record<string, number>;

export type AppMode = "mesh" | "boneCreate" | "boneBind" | "animate";
export type BindTool = "auto" | "paint" | "select";

export interface MeshData {
  points: [number, number][];
  triangles: number[];
  hull: [number, number][];
}

// --- Animation types ---

/** Per-bone transform at a point in time */
export interface BoneTransform {
  rotation: number;   // radians, relative to rest pose
  translateX: number; // pixel offset
  translateY: number;
}

/** A keyframe stores transforms for all bones at a specific time */
export interface Keyframe {
  time: number; // seconds
  transforms: Record<string, BoneTransform>; // boneId -> transform
}

export interface AnimationClip {
  name: string;
  duration: number; // seconds
  keyframes: Keyframe[];
}
