import type { Bone, VertexWeights } from "../types";

const BONE_COLOR = "rgba(255, 255, 255, 0.7)";
const BONE_SELECTED_COLOR = "rgba(0, 200, 255, 0.9)";
const BONE_HOVER_COLOR = "rgba(255, 200, 0, 0.8)";
const JOINT_RADIUS = 5;

export function drawBones(
  ctx: CanvasRenderingContext2D,
  bones: Bone[],
  selectedBoneId: string | null,
  hoveredBoneId: string | null,
  pendingBone: { headX: number; headY: number; tailX: number; tailY: number } | null
): void {
  for (const bone of bones) {
    const isSelected = bone.id === selectedBoneId;
    const isHovered = bone.id === hoveredBoneId;
    drawSingleBone(ctx, bone.headX, bone.headY, bone.tailX, bone.tailY,
      isSelected ? BONE_SELECTED_COLOR : isHovered ? BONE_HOVER_COLOR : BONE_COLOR,
      isSelected
    );
  }

  if (pendingBone) {
    drawSingleBone(
      ctx, pendingBone.headX, pendingBone.headY, pendingBone.tailX, pendingBone.tailY,
      "rgba(255, 255, 0, 0.5)", false, true
    );
  }
}

function drawSingleBone(
  ctx: CanvasRenderingContext2D,
  hx: number, hy: number, tx: number, ty: number,
  color: string, bold: boolean, dashed: boolean = false
): void {
  const dx = tx - hx;
  const dy = ty - hy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const nx = -dy / len;
  const ny = dx / len;
  const w = Math.min(len * 0.15, 8);

  // Diamond shape
  const midX = (hx + tx) / 2;
  const midY = (hy + ty) / 2;

  ctx.save();
  if (dashed) ctx.setLineDash([4, 4]);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = bold ? 2 : 1;

  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(midX + nx * w, midY + ny * w);
  ctx.lineTo(tx, ty);
  ctx.lineTo(midX - nx * w, midY - ny * w);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Joints
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(hx, hy, JOINT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tx, ty, JOINT_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Find bone near a point (returns bone id or null) */
export function findBoneAt(
  bones: Bone[], x: number, y: number, threshold: number = 10
): string | null {
  for (const bone of bones) {
    // Check near head
    if (Math.hypot(x - bone.headX, y - bone.headY) < threshold) return bone.id;
    // Check near tail
    if (Math.hypot(x - bone.tailX, y - bone.tailY) < threshold) return bone.id;
    // Check near line segment
    const dist = pointToSegmentDist(x, y, bone.headX, bone.headY, bone.tailX, bone.tailY);
    if (dist < threshold) return bone.id;
  }
  return null;
}

/** Find bone tail near a point (for parenting) */
export function findBoneTailAt(
  bones: Bone[], x: number, y: number, threshold: number = 12
): Bone | null {
  for (const bone of bones) {
    if (Math.hypot(x - bone.tailX, y - bone.tailY) < threshold) return bone;
  }
  return null;
}

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

// --- Weight visualization ---

function weightToColor(w: number): string {
  // Blue (0) -> Green (0.5) -> Red (1)
  const r = w < 0.5 ? 0 : Math.round(255 * (w - 0.5) * 2);
  const g = w < 0.5 ? Math.round(255 * w * 2) : Math.round(255 * (1 - w) * 2);
  const b = w < 0.5 ? Math.round(255 * (1 - w * 2)) : 0;
  return `rgba(${r},${g},${b},0.6)`;
}

export function drawWeightOverlay(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  triangles: number[],
  weights: VertexWeights[],
  activeBoneId: string
): void {
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];

    const wa = weights[a]?.[activeBoneId] ?? 0;
    const wb = weights[b]?.[activeBoneId] ?? 0;
    const wc = weights[c]?.[activeBoneId] ?? 0;
    const avgW = (wa + wb + wc) / 3;

    ctx.fillStyle = weightToColor(avgW);
    ctx.beginPath();
    ctx.moveTo(points[a][0], points[a][1]);
    ctx.lineTo(points[b][0], points[b][1]);
    ctx.lineTo(points[c][0], points[c][1]);
    ctx.closePath();
    ctx.fill();
  }
}

export function drawVertexWeights(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  weights: VertexWeights[],
  activeBoneId: string,
  selectedVertices: Set<number>
): void {
  for (let i = 0; i < points.length; i++) {
    const w = weights[i]?.[activeBoneId] ?? 0;
    const [x, y] = points[i];
    const isSelected = selectedVertices.has(i);

    ctx.fillStyle = weightToColor(w);
    ctx.strokeStyle = isSelected ? "#fff" : "transparent";
    ctx.lineWidth = isSelected ? 2 : 0;
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    if (isSelected) ctx.stroke();
  }
}
