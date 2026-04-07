export interface Bone {
  id: string;
  name: string;
  headX: number;
  headY: number;
  tailX: number;
  tailY: number;
  parentId: string | null;
  layerId: string | null; // null = global bone, string = local to that layer
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

/** Per-bone keyframe */
export interface BoneKeyframe {
  time: number; // seconds
  transform: BoneTransform;
}

/** Animation clip with per-bone keyframe tracks */
export interface AnimationClip {
  name: string;
  duration: number; // seconds
  tracks: Record<string, BoneKeyframe[]>; // boneId -> sorted keyframes
}

// --- Layer / Project ---

export interface Layer {
  id: string;
  name: string;
  imageSrc: string;          // data URL
  mesh: MeshData | null;
  weights: VertexWeights[];
  attachBoneId: string | null; // which bone this layer follows
  zOrder: number;
  visible: boolean;
}

export interface Project {
  bones: Bone[];             // single forest (multiple roots allowed)
  layers: Layer[];
  animation: AnimationClip | null;
}
