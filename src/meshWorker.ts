import Delaunator from "delaunator";

export interface WorkerInput {
  imageData: Uint8ClampedArray;
  width: number;
  height: number;
  spacing: number;
  padding: number;
  contourMode: "concave" | "convex";
}

export interface WorkerOutput {
  points: [number, number][];
  triangles: number[];
  hull: [number, number][];
}

// --- Algorithm functions ---

function getAlphaMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
  }
  return mask;
}

function dilateMask(
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number
): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(w * h);
  const r = Math.ceil(radius);
  const r2 = radius * radius;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 1) {
        out[y * w + x] = 1;
        continue;
      }
      let found = false;
      for (let dy = -r; dy <= r && !found; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r && !found; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (dx * dx + dy * dy <= r2 && mask[ny * w + nx] === 1) {
            found = true;
          }
        }
      }
      if (found) out[y * w + x] = 1;
    }
  }
  return out;
}

function mooreTrace(
  mask: Uint8Array,
  w: number,
  h: number
): [number, number][] {
  let startX = -1,
    startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX === -1) return [];

  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const getPixel = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? mask[y * w + x] : 0;

  const contour: [number, number][] = [];
  let cx = startX,
    cy = startY;
  let dir = 7;
  const maxIter = w * h * 2;
  let iter = 0;

  do {
    contour.push([cx, cy]);
    const startDir = (dir + 5) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (getPixel(nx, ny) === 1) {
        dir = d;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (++iter > maxIter) break;
  } while (cx !== startX || cy !== startY);

  return contour;
}

function subsampleContour(
  points: [number, number][],
  step: number
): [number, number][] {
  if (points.length <= step) return points;
  const result: [number, number][] = [];
  for (let i = 0; i < points.length; i += step) {
    result.push(points[i]);
  }
  const last = points[points.length - 1];
  if (result[result.length - 1] !== last) {
    result.push(last);
  }
  return result;
}

function rdpSimplify(
  points: [number, number][],
  epsilon: number
): [number, number][] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const [sx, sy] = points[0];
  const [ex, ey] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i][0], points[i][1], sx, sy, ex, ey);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function pointLineDistance(
  px: number, py: number,
  lx1: number, ly1: number,
  lx2: number, ly2: number
): number {
  const dx = lx2 - lx1;
  const dy = ly2 - ly1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - lx1, py - ly1);
  const t = Math.max(0, Math.min(1, ((px - lx1) * dx + (py - ly1) * dy) / lenSq));
  return Math.hypot(px - (lx1 + t * dx), py - (ly1 + t * dy));
}

function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function isTriangleInMask(
  p1: [number, number], p2: [number, number], p3: [number, number],
  mask: Uint8Array, w: number, h: number
): boolean {
  const cx = (p1[0] + p2[0] + p3[0]) / 3;
  const cy = (p1[1] + p2[1] + p3[1]) / 3;
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return false;
  if (mask[iy * w + ix] === 0) return false;
  const midpoints: [number, number][] = [
    [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
    [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2],
    [(p3[0] + p1[0]) / 2, (p3[1] + p1[1]) / 2],
  ];
  for (const [mx, my] of midpoints) {
    const mix = Math.round(mx);
    const miy = Math.round(my);
    if (mix < 0 || mix >= w || miy < 0 || miy >= h) return false;
    if (mask[miy * w + mix] === 0) return false;
  }
  return true;
}

function samplePolygonEdges(
  polygon: [number, number][],
  spacing: number
): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.round(dist / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
    }
  }
  return result;
}

function generateInteriorPoints(
  polygon: [number, number][],
  mask: Uint8Array,
  w: number, h: number,
  spacing: number
): [number, number][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const interior: [number, number][] = [];
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix] === 1) {
        interior.push([x, y]);
      }
    }
  }
  return interior;
}

// --- Worker message handler ---

function processMesh(input: WorkerInput): WorkerOutput | null {
  const { imageData, width, height, spacing, padding, contourMode } = input;

  const baseMask = getAlphaMask(imageData, width, height, 10);
  const mask = padding > 0 ? dilateMask(baseMask, width, height, padding) : baseMask;

  const rawContour = mooreTrace(mask, width, height);
  if (rawContour.length < 3) return null;

  let simplified: [number, number][];
  if (contourMode === "convex") {
    const hull = convexHull(rawContour);
    simplified = rdpSimplify(hull, spacing * 0.3);
  } else {
    const subsampled = subsampleContour(rawContour, Math.max(1, Math.floor(spacing * 0.3)));
    simplified = rdpSimplify(subsampled, spacing * 0.5);
  }

  const edgePoints = samplePolygonEdges(simplified, spacing);
  const interiorPoints = generateInteriorPoints(simplified, mask, width, height, spacing);
  const allPoints: [number, number][] = [...edgePoints, ...interiorPoints];

  if (allPoints.length < 3) return null;

  const coords = new Float64Array(allPoints.length * 2);
  for (let i = 0; i < allPoints.length; i++) {
    coords[i * 2] = allPoints[i][0];
    coords[i * 2 + 1] = allPoints[i][1];
  }
  const delaunay = new Delaunator(coords);

  const rawTriangles = Array.from(delaunay.triangles);
  const filteredTriangles: number[] = [];
  for (let i = 0; i < rawTriangles.length; i += 3) {
    const a = rawTriangles[i];
    const b = rawTriangles[i + 1];
    const c = rawTriangles[i + 2];
    if (isTriangleInMask(allPoints[a], allPoints[b], allPoints[c], mask, width, height)) {
      filteredTriangles.push(a, b, c);
    }
  }

  return {
    points: allPoints,
    triangles: filteredTriangles,
    hull: simplified,
  };
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const result = processMesh(e.data);
  self.postMessage(result);
};
