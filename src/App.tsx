import { useCallback, useRef, useState } from "react";
import Delaunator from "delaunator";
import "./App.css";

// --- Contour extraction ---

function getAlphaMask(
  imageData: ImageData,
  threshold: number
): Uint8Array {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
  }
  return mask;
}

/** Dilate binary mask by radius pixels (Euclidean distance) */
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
      // Check if any opaque pixel is within radius
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

/**
 * Moore neighborhood contour tracing.
 * Traces the outer boundary of the largest connected opaque region,
 * returning ordered points that follow the actual shape (concave-aware).
 */
function mooreTrace(
  mask: Uint8Array,
  w: number,
  h: number
): [number, number][] {
  // Find the first opaque pixel (scan top-left to bottom-right)
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

  // Moore neighborhood: 8 directions clockwise from left
  //  5 6 7
  //  4 . 0
  //  3 2 1
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const getPixel = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? mask[y * w + x] : 0;

  const contour: [number, number][] = [];
  let cx = startX,
    cy = startY;
  // Start direction: coming from the left (direction 4), so backtrack starts at 5
  let dir = 7; // last direction we came from

  const maxIter = w * h * 2;
  let iter = 0;

  do {
    contour.push([cx, cy]);

    // Start searching from (dir + 5) % 8, which is backtrack + 1 clockwise
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

/** Subsample contour to reduce point count before simplification */
function subsampleContour(
  points: [number, number][],
  step: number
): [number, number][] {
  if (points.length <= step) return points;
  const result: [number, number][] = [];
  for (let i = 0; i < points.length; i += step) {
    result.push(points[i]);
  }
  // Ensure the last point is included
  const last = points[points.length - 1];
  if (result[result.length - 1] !== last) {
    result.push(last);
  }
  return result;
}

/** Simplify polygon using Ramer-Douglas-Peucker */
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
  px: number,
  py: number,
  lx1: number,
  ly1: number,
  lx2: number,
  ly2: number
): number {
  const dx = lx2 - lx1;
  const dy = ly2 - ly1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - lx1, py - ly1);
  const t = Math.max(0, Math.min(1, ((px - lx1) * dx + (py - ly1) * dy) / lenSq));
  return Math.hypot(px - (lx1 + t * dx), py - (ly1 + t * dy));
}

/** Compute convex hull (Graham scan) */
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

/** Check if a triangle's centroid falls inside the opaque mask */
function isTriangleInMask(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  mask: Uint8Array,
  w: number,
  h: number
): boolean {
  // Check centroid
  const cx = (p1[0] + p2[0] + p3[0]) / 3;
  const cy = (p1[1] + p2[1] + p3[1]) / 3;
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return false;
  if (mask[iy * w + ix] === 0) return false;

  // Also check midpoints of edges to catch thin triangles spanning gaps
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

/** Sample points along polygon edges */
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

/** Generate interior grid points inside a polygon */
function generateInteriorPoints(
  polygon: [number, number][],
  mask: Uint8Array,
  w: number,
  h: number,
  spacing: number
): [number, number][] {
  // Find bounding box
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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

// --- React App ---

interface MeshData {
  points: [number, number][];
  triangles: number[];
  hull: [number, number][];
}

function App() {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [meshData, setMeshData] = useState<MeshData | null>(null);
  const [meshDensity, setMeshDensity] = useState(30);
  const [padding, setPadding] = useState(0);
  const [contourMode, setContourMode] = useState<"concave" | "convex">("concave");
  const [showImage, setShowImage] = useState(true);
  const [showMesh, setShowMesh] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const processImage = useCallback(
    (img: HTMLImageElement, density?: number, pad?: number, mode?: "concave" | "convex") => {
      const spacing = density ?? meshDensity;
      const padRadius = pad ?? padding;
      const cMode = mode ?? contourMode;

      // Extract alpha mask
      const offscreen = document.createElement("canvas");
      offscreen.width = img.width;
      offscreen.height = img.height;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const baseMask = getAlphaMask(imageData, 10);

      // Dilate mask if padding > 0
      const mask = padRadius > 0 ? dilateMask(baseMask, img.width, img.height, padRadius) : baseMask;

      // Trace contour using Moore neighborhood
      const rawContour = mooreTrace(mask, img.width, img.height);
      if (rawContour.length < 3) return;

      let simplified: [number, number][];
      if (cMode === "convex") {
        // Convex hull mode
        const hull = convexHull(rawContour);
        simplified = rdpSimplify(hull, spacing * 0.3);
      } else {
        // Concave mode: subsample then simplify
        const subsampled = subsampleContour(rawContour, Math.max(1, Math.floor(spacing * 0.3)));
        simplified = rdpSimplify(subsampled, spacing * 0.5);
      }

      // Sample edge points along the outline + interior points
      const edgePoints = samplePolygonEdges(simplified, spacing);
      const interiorPoints = generateInteriorPoints(
        simplified,
        mask,
        img.width,
        img.height,
        spacing
      );

      const allPoints: [number, number][] = [...edgePoints, ...interiorPoints];

      // Delaunay triangulation
      if (allPoints.length < 3) return;
      const coords = new Float64Array(allPoints.length * 2);
      for (let i = 0; i < allPoints.length; i++) {
        coords[i * 2] = allPoints[i][0];
        coords[i * 2 + 1] = allPoints[i][1];
      }
      const delaunay = new Delaunator(coords);

      // Filter out triangles whose centroid/midpoints fall in transparent area
      const rawTriangles = Array.from(delaunay.triangles);
      const filteredTriangles: number[] = [];
      for (let i = 0; i < rawTriangles.length; i += 3) {
        const a = rawTriangles[i];
        const b = rawTriangles[i + 1];
        const c = rawTriangles[i + 2];
        if (isTriangleInMask(allPoints[a], allPoints[b], allPoints[c], mask, img.width, img.height)) {
          filteredTriangles.push(a, b, c);
        }
      }

      setMeshData({
        points: allPoints,
        triangles: filteredTriangles,
        hull: simplified,
      });
    },
    [meshDensity, padding, contourMode]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith("image/")) return;

      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          setImage(img);
          processImage(img);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    },
    [processImage]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDensityChange = useCallback(
    (val: number) => {
      setMeshDensity(val);
      if (image) processImage(image, val, undefined);
    },
    [image, processImage]
  );

  const handlePaddingChange = useCallback(
    (val: number) => {
      setPadding(val);
      if (image) processImage(image, undefined, val);
    },
    [image, processImage]
  );

  const handleModeChange = useCallback(
    (mode: "concave" | "convex") => {
      setContourMode(mode);
      if (image) processImage(image, undefined, undefined, mode);
    },
    [image, processImage]
  );

  // Draw on canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;

    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (showImage) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(image, 0, 0);
      ctx.globalAlpha = 1;
    }

    if (meshData && showMesh) {
      ctx.strokeStyle = "#00ccff";
      ctx.lineWidth = 1;
      const { points, triangles } = meshData;
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i];
        const b = triangles[i + 1];
        const c = triangles[i + 2];
        ctx.beginPath();
        ctx.moveTo(points[a][0], points[a][1]);
        ctx.lineTo(points[b][0], points[b][1]);
        ctx.lineTo(points[c][0], points[c][1]);
        ctx.closePath();
        ctx.stroke();
      }
    }

    if (meshData && showPoints) {
      ctx.fillStyle = "#ff4444";
      for (const [x, y] of meshData.points) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw hull outline
    if (meshData) {
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const hull = meshData.hull;
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) {
        ctx.lineTo(hull[i][0], hull[i][1]);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }, [image, meshData, showImage, showMesh, showPoints]);

  // Redraw when state changes
  const prevDeps = useRef<string>("");
  const depsKey = `${showImage}-${showMesh}-${showPoints}-${meshData?.points.length}`;
  if (depsKey !== prevDeps.current) {
    prevDeps.current = depsKey;
    requestAnimationFrame(draw);
  }

  return (
    <div className="app">
      <header>
        <h1>EasyMesh</h1>
        <p>PNG画像をドロップしてメッシュ生成</p>
      </header>

      {!image ? (
        <div
          className="dropzone"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div className="dropzone-content">
            <span className="dropzone-icon">+</span>
            <p>PNG画像をここにドロップ</p>
          </div>
        </div>
      ) : (
        <div className="workspace">
          <div className="toolbar">
            <label>
              メッシュ密度:
              <input
                type="range"
                min={10}
                max={80}
                value={meshDensity}
                onChange={(e) => handleDensityChange(Number(e.target.value))}
              />
              <span>{meshDensity}px</span>
            </label>
            <label>
              パディング:
              <input
                type="range"
                min={0}
                max={30}
                value={padding}
                onChange={(e) => handlePaddingChange(Number(e.target.value))}
              />
              <span>{padding}px</span>
            </label>
            <select
              value={contourMode}
              onChange={(e) => handleModeChange(e.target.value as "concave" | "convex")}
            >
              <option value="concave">輪郭追従</option>
              <option value="convex">凸包</option>
            </select>
            <label>
              <input
                type="checkbox"
                checked={showImage}
                onChange={(e) => setShowImage(e.target.checked)}
              />
              画像
            </label>
            <label>
              <input
                type="checkbox"
                checked={showMesh}
                onChange={(e) => setShowMesh(e.target.checked)}
              />
              メッシュ
            </label>
            <label>
              <input
                type="checkbox"
                checked={showPoints}
                onChange={(e) => setShowPoints(e.target.checked)}
              />
              頂点
            </label>
            <button
              onClick={() => {
                setImage(null);
                setMeshData(null);
              }}
            >
              リセット
            </button>
          </div>
          <div
            className="canvas-container"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            <canvas ref={canvasRef} />
          </div>
          {meshData && (
            <div className="stats">
              頂点数: {meshData.points.length} / 三角形数:{" "}
              {meshData.triangles.length / 3}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
