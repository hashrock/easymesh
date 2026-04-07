import { Tree } from "react-arborist";
import type { NodeRendererProps } from "react-arborist";
import type { Bone, Layer } from "../types";

// Tree node can be a bone or a layer
export interface TreeNode {
  id: string;
  name: string;
  type: "bone" | "layer";
  children?: TreeNode[];
  // Reference to original data
  boneId?: string;
  layerId?: string;
}

/** Build tree data from bones and layers */
export function buildTreeData(bones: Bone[], layers: Layer[]): TreeNode[] {
  const boneMap = new Map<string, TreeNode>();

  // Create bone nodes
  for (const bone of bones) {
    boneMap.set(bone.id, {
      id: `bone:${bone.id}`,
      name: bone.name,
      type: "bone",
      boneId: bone.id,
      children: [],
    });
  }

  // Build hierarchy
  const roots: TreeNode[] = [];
  for (const bone of bones) {
    const node = boneMap.get(bone.id)!;
    if (bone.parentId && boneMap.has(bone.parentId)) {
      boneMap.get(bone.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  // Attach layers to their bones
  for (const layer of layers) {
    const layerNode: TreeNode = {
      id: `layer:${layer.id}`,
      name: layer.name,
      type: "layer",
      layerId: layer.id,
    };
    if (layer.attachBoneId && boneMap.has(layer.attachBoneId)) {
      boneMap.get(layer.attachBoneId)!.children!.push(layerNode);
    } else {
      roots.push(layerNode);
    }
  }

  return roots;
}

interface BoneTreeProps {
  bones: Bone[];
  layers: Layer[];
  selectedBoneId: string | null;
  selectedLayerId: string | null;
  onSelectBone: (id: string | null) => void;
  onSelectLayer: (id: string | null) => void;
  onMoveBone: (boneId: string, newParentBoneId: string | null) => void;
  onMoveLayer: (layerId: string, newAttachBoneId: string | null) => void;
}

function Node({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const data = node.data;
  const isSelected = node.isSelected;

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`tree-item ${data.type === "bone" ? "tree-bone" : "tree-layer"} ${isSelected ? "selected" : ""}`}
      onClick={(e) => { e.stopPropagation(); node.select(); }}
    >
      {data.type === "bone" && (
        <span
          className="tree-toggle"
          onClick={(e) => { e.stopPropagation(); node.toggle(); }}
        >
          {node.children && node.children.length > 0 ? (node.isOpen ? "▼" : "▶") : "　"}
        </span>
      )}
      <span className="tree-icon">{data.type === "bone" ? "◆" : "▧"}</span>
      {data.name}
    </div>
  );
}

export default function BoneTree({
  bones, layers, selectedBoneId, selectedLayerId,
  onSelectBone, onSelectLayer, onMoveBone, onMoveLayer,
}: BoneTreeProps) {
  const treeData = buildTreeData(bones, layers);

  // Determine selected node ID
  const selectedId = selectedBoneId ? `bone:${selectedBoneId}` : selectedLayerId ? `layer:${selectedLayerId}` : undefined;

  return (
    <div className="bone-tree-container">
      <Tree<TreeNode>
        data={treeData}
        width={184}
        rowHeight={26}
        indent={16}
        openByDefault={true}
        selection={selectedId}
        onSelect={(nodes) => {
          const node = nodes[0];
          if (!node) return;
          if (node.data.type === "bone") {
            onSelectBone(node.data.boneId!);
            onSelectLayer(null);
          } else {
            onSelectLayer(node.data.layerId!);
            onSelectBone(null);
          }
        }}
        onMove={({ dragIds, parentId }) => {
          const dragId = dragIds[0];
          if (!dragId) return;

          // Parse the new parent
          let newParentBoneId: string | null = null;
          if (parentId?.startsWith("bone:")) {
            newParentBoneId = parentId.slice(5);
          }

          if (dragId.startsWith("bone:")) {
            const boneId = dragId.slice(5);
            onMoveBone(boneId, newParentBoneId);
          } else if (dragId.startsWith("layer:")) {
            const layerId = dragId.slice(6);
            onMoveLayer(layerId, newParentBoneId);
          }
        }}
      >
        {Node}
      </Tree>
    </div>
  );
}
