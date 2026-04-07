import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerInput, WorkerOutput } from "./meshWorker";
import "./App.css";

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
  const [processing, setProcessing] = useState(false);
  const [showImage, setShowImage] = useState(true);
  const [showMesh, setShowMesh] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(
      new URL("./meshWorker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const processImage = useCallback(
    (img: HTMLImageElement, density?: number, pad?: number, mode?: "concave" | "convex") => {
      const worker = workerRef.current;
      if (!worker) return;

      const spacing = density ?? meshDensity;
      const padRadius = pad ?? padding;
      const cMode = mode ?? contourMode;

      // Extract pixel data on main thread (needs canvas)
      const offscreen = document.createElement("canvas");
      offscreen.width = img.width;
      offscreen.height = img.height;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);

      const id = ++requestIdRef.current;
      setProcessing(true);

      const input: WorkerInput = {
        imageData: imageData.data,
        width: img.width,
        height: img.height,
        spacing,
        padding: padRadius,
        contourMode: cMode,
      };

      worker.onmessage = (e: MessageEvent<WorkerOutput | null>) => {
        // Ignore stale responses
        if (id !== requestIdRef.current) return;
        setProcessing(false);
        if (e.data) {
          setMeshData(e.data);
        }
      };

      worker.postMessage(input);
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
            {processing && <span className="processing">処理中...</span>}
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
