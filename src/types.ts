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

export type AppMode = "mesh" | "boneCreate" | "boneBind";
export type BindTool = "auto" | "paint" | "select";

export interface MeshData {
  points: [number, number][];
  triangles: number[];
  hull: [number, number][];
}
