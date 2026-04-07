import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerInput, WorkerOutput } from "./meshWorker";
import type { AppMode, BindTool, Bone, MeshData, VertexWeights } from "./types";
import { drawBones, drawWeightOverlay, drawVertexWeights, findBoneAt, findBoneTailAt } from "./bones/BoneRenderer";
import { autoBind, applyWeightPaint, setVertexWeight } from "./bones/autoBind";
import "./App.css";

let nextBoneId = 1;
function genBoneId() { return `bone_${nextBoneId++}`; }

function App() {
  // --- Image & mesh state ---
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [meshData, setMeshData] = useState<MeshData | null>(null);
  const [meshDensity, setMeshDensity] = useState(30);
  const [padding, setPadding] = useState(0);
  const [contourMode, setContourMode] = useState<"concave" | "convex">("concave");
  const [processing, setProcessing] = useState(false);
  const [showImage, setShowImage] = useState(true);
  const [showMesh, setShowMesh] = useState(true);
  const [showPoints, setShowPoints] = useState(true);

  // --- Mode state ---
  const [appMode, setAppMode] = useState<AppMode>("mesh");

  // --- Bone state ---
  const [bones, setBones] = useState<Bone[]>([]);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);
  const [pendingBone, setPendingBone] = useState<{ headX: number; headY: number; tailX: number; tailY: number; parentId: string | null } | null>(null);

  // --- Bind state ---
  const [vertexWeights, setVertexWeights] = useState<VertexWeights[]>([]);
  const [bindTool, setBindTool] = useState<BindTool>("auto");
  const [brushRadius, setBrushRadius] = useState(30);
  const [brushStrength, setBrushStrength] = useState(0.3);
  const [selectedVertices, setSelectedVertices] = useState<Set<number>>(new Set());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRequestRef = useRef<(() => void) | null>(null);
  const workerBusyRef = useRef(false);
  const isPaintingRef = useRef(false);
  const drawRequestedRef = useRef(false);
  const [weightsRev, setWeightsRev] = useState(0);
  const updateWeights = useCallback((w: VertexWeights[]) => {
    setVertexWeights(w);
    setWeightsRev(r => r + 1);
  }, []);

  // --- Worker ---
  useEffect(() => {
    const worker = new Worker(
      new URL("./meshWorker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const dispatchToWorker = useCallback(
    (img: HTMLImageElement, spacing: number, padRadius: number, cMode: "concave" | "convex") => {
      const worker = workerRef.current;
      if (!worker) return;
      const offscreen = document.createElement("canvas");
      offscreen.width = img.width;
      offscreen.height = img.height;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const id = ++requestIdRef.current;
      setProcessing(true);
      workerBusyRef.current = true;
      const input: WorkerInput = {
        imageData: imageData.data, width: img.width, height: img.height,
        spacing, padding: padRadius, contourMode: cMode,
      };
      worker.onmessage = (e: MessageEvent<WorkerOutput | null>) => {
        workerBusyRef.current = false;
        if (id !== requestIdRef.current) return;
        setProcessing(false);
        if (e.data) {
          setMeshData(e.data);
          setVertexWeights([]);
        }
        const pending = pendingRequestRef.current;
        if (pending) { pendingRequestRef.current = null; pending(); }
      };
      worker.postMessage(input);
    }, []
  );

  const processImage = useCallback(
    (img: HTMLImageElement, density?: number, pad?: number, mode?: "concave" | "convex") => {
      const spacing = density ?? meshDensity;
      const padRadius = pad ?? padding;
      const cMode = mode ?? contourMode;
      const fire = () => dispatchToWorker(img, spacing, padRadius, cMode);
      if (workerBusyRef.current) { pendingRequestRef.current = fire; return; }
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = setTimeout(() => { throttleTimerRef.current = null; fire(); }, 50);
    },
    [meshDensity, padding, contourMode, dispatchToWorker]
  );

  // --- Canvas coordinate helper ---
  const canvasCoords = useCallback((e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }, []);

  // --- Drop handlers ---
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => { setImage(img); processImage(img); };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }, [processImage]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);

  // --- Mesh param handlers ---
  const handleDensityChange = useCallback((val: number) => {
    setMeshDensity(val);
    if (image) processImage(image, val, undefined);
  }, [image, processImage]);

  const handlePaddingChange = useCallback((val: number) => {
    setPadding(val);
    if (image) processImage(image, undefined, val);
  }, [image, processImage]);

  const handleContourModeChange = useCallback((mode: "concave" | "convex") => {
    setContourMode(mode);
    if (image) processImage(image, undefined, undefined, mode);
  }, [image, processImage]);

  // --- Canvas mouse handlers ---
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = canvasCoords(e);
    if (!pos) return;
    const [x, y] = pos;

    if (appMode === "boneCreate") {
      if (!pendingBone) {
        // First click: set head. Check if near a tail for parenting
        const parentBone = findBoneTailAt(bones, x, y);
        if (parentBone) {
          setPendingBone({ headX: parentBone.tailX, headY: parentBone.tailY, tailX: x, tailY: y, parentId: parentBone.id });
        } else {
          setPendingBone({ headX: x, headY: y, tailX: x, tailY: y, parentId: null });
        }
      } else {
        // Second click: commit bone
        const id = genBoneId();
        const newBone: Bone = {
          id,
          name: `Bone ${bones.length + 1}`,
          headX: pendingBone.headX, headY: pendingBone.headY,
          tailX: x, tailY: y,
          parentId: pendingBone.parentId,
        };
        setBones(prev => [...prev, newBone]);
        setPendingBone(null);
        setSelectedBoneId(id);
      }
    } else if (appMode === "boneBind") {
      if (bindTool === "paint" && selectedBoneId && meshData) {
        isPaintingRef.current = true;
        const newWeights = applyWeightPaint(
          meshData.points, vertexWeights.length ? vertexWeights : meshData.points.map(() => ({})),
          [x, y], brushRadius, brushStrength, selectedBoneId
        );
        updateWeights(newWeights);
      } else if (bindTool === "select" && meshData) {
        // Find nearest vertex
        let minDist = Infinity;
        let nearest = -1;
        for (let i = 0; i < meshData.points.length; i++) {
          const d = Math.hypot(meshData.points[i][0] - x, meshData.points[i][1] - y);
          if (d < minDist) { minDist = d; nearest = i; }
        }
        if (nearest >= 0 && minDist < 15) {
          if (e.shiftKey) {
            setSelectedVertices(prev => {
              const next = new Set(prev);
              if (next.has(nearest)) next.delete(nearest); else next.add(nearest);
              return next;
            });
          } else {
            setSelectedVertices(new Set([nearest]));
          }
        } else {
          setSelectedVertices(new Set());
        }
      }
    }
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, meshData, vertexWeights, brushRadius, brushStrength]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = canvasCoords(e);
    if (!pos) return;
    const [x, y] = pos;

    if (appMode === "boneCreate") {
      if (pendingBone) {
        setPendingBone(prev => prev ? { ...prev, tailX: x, tailY: y } : null);
      } else {
        const hovered = findBoneAt(bones, x, y);
        setHoveredBoneId(hovered);
      }
    } else if (appMode === "boneBind" && bindTool === "paint" && isPaintingRef.current && selectedBoneId && meshData) {
      const newWeights = applyWeightPaint(
        meshData.points, vertexWeights.length ? vertexWeights : meshData.points.map(() => ({})),
        [x, y], brushRadius, brushStrength, selectedBoneId
      );
      updateWeights(newWeights);
    }
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, meshData, vertexWeights, brushRadius, brushStrength]);

  const handleCanvasMouseUp = useCallback(() => {
    isPaintingRef.current = false;
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (appMode === "boneCreate") {
      if (e.key === "Escape") {
        setPendingBone(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedBoneId) {
        setBones(prev => prev.filter(b => b.id !== selectedBoneId));
        setSelectedBoneId(null);
      }
    }
  }, [appMode, selectedBoneId]);

  // --- Auto bind ---
  const handleAutoBind = useCallback(() => {
    if (!meshData || bones.length === 0) return;
    const weights = autoBind(meshData.points, bones);
    updateWeights(weights);
  }, [meshData, bones, updateWeights]);

  // --- Draw ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (showImage) {
      ctx.globalAlpha = appMode === "boneBind" ? 0.3 : 0.5;
      ctx.drawImage(image, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Weight overlay (under mesh wireframe)
    if (appMode === "boneBind" && selectedBoneId && meshData && vertexWeights.length > 0) {
      drawWeightOverlay(ctx, meshData.points, meshData.triangles, vertexWeights, selectedBoneId);
    }

    if (meshData && showMesh) {
      ctx.strokeStyle = appMode === "boneBind" ? "rgba(0,204,255,0.3)" : "#00ccff";
      ctx.lineWidth = 1;
      const { points, triangles } = meshData;
      for (let i = 0; i < triangles.length; i += 3) {
        ctx.beginPath();
        ctx.moveTo(points[triangles[i]][0], points[triangles[i]][1]);
        ctx.lineTo(points[triangles[i + 1]][0], points[triangles[i + 1]][1]);
        ctx.lineTo(points[triangles[i + 2]][0], points[triangles[i + 2]][1]);
        ctx.closePath();
        ctx.stroke();
      }
    }

    if (appMode === "boneBind" && selectedBoneId && meshData && vertexWeights.length > 0) {
      drawVertexWeights(ctx, meshData.points, vertexWeights, selectedBoneId, selectedVertices);
    } else if (meshData && showPoints) {
      ctx.fillStyle = "#ff4444";
      for (const [x, y] of meshData.points) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Hull outline
    if (meshData && appMode === "mesh") {
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const hull = meshData.hull;
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.stroke();
    }

    // Bones
    if (appMode === "boneCreate" || appMode === "boneBind") {
      drawBones(ctx, bones, selectedBoneId, hoveredBoneId, pendingBone);
    }
  }, [image, meshData, showImage, showMesh, showPoints, appMode, bones, selectedBoneId, hoveredBoneId, pendingBone, vertexWeights, selectedVertices]);

  // Redraw when deps change
  const prevDeps = useRef<string>("");
  const depsKey = JSON.stringify({
    showImage, showMesh, showPoints, appMode, pendingBone,
    bonesLen: bones.length, selectedBoneId, hoveredBoneId,
    meshLen: meshData?.points.length, weightsRev,
    selVerts: [...selectedVertices].join(","),
  });
  if (depsKey !== prevDeps.current) {
    prevDeps.current = depsKey;
    if (!drawRequestedRef.current) {
      drawRequestedRef.current = true;
      requestAnimationFrame(() => { drawRequestedRef.current = false; draw(); });
    }
  }

  // --- Weight editor for selected vertices ---
  const weightEditorRows = (() => {
    if (appMode !== "boneBind" || bindTool !== "select" || selectedVertices.size === 0 || bones.length === 0) return null;
    // Show average weight per bone for selected vertices
    const avg: Record<string, number> = {};
    for (const bone of bones) avg[bone.id] = 0;
    for (const vi of selectedVertices) {
      const w = vertexWeights[vi] ?? {};
      for (const bone of bones) avg[bone.id] += (w[bone.id] ?? 0);
    }
    for (const bone of bones) avg[bone.id] /= selectedVertices.size;

    return (
      <div className="weight-editor">
        <div className="weight-editor-title">選択頂点のウェイト ({selectedVertices.size}個)</div>
        {bones.map(bone => (
          <div key={bone.id} className="weight-row">
            <span className={bone.id === selectedBoneId ? "weight-bone-name active" : "weight-bone-name"}
              onClick={() => setSelectedBoneId(bone.id)}>
              {bone.name}
            </span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={avg[bone.id]}
              onChange={(e) => {
                const val = Number(e.target.value);
                const indices = [...selectedVertices];
                const newWeights = setVertexWeight(
                  vertexWeights.length ? vertexWeights : (meshData?.points ?? []).map(() => ({})),
                  indices, bone.id, val
                );
                updateWeights(newWeights);
              }}
            />
            <span className="weight-value">{avg[bone.id].toFixed(2)}</span>
          </div>
        ))}
      </div>
    );
  })();

  return (
    <div className="app" onKeyDown={handleKeyDown} tabIndex={0}>
      <header>
        <h1>EasyMesh</h1>
      </header>

      {!image ? (
        <div className="dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
          <div className="dropzone-content">
            <span className="dropzone-icon">+</span>
            <p>PNG画像をここにドロップ</p>
          </div>
        </div>
      ) : (
        <div className="workspace">
          {/* Mode tabs */}
          <div className="mode-tabs">
            <button className={appMode === "mesh" ? "active" : ""} onClick={() => setAppMode("mesh")}>
              メッシュ
            </button>
            <button className={appMode === "boneCreate" ? "active" : ""} onClick={() => setAppMode("boneCreate")}
              disabled={!meshData}>
              ボーン作成
            </button>
            <button className={appMode === "boneBind" ? "active" : ""} onClick={() => setAppMode("boneBind")}
              disabled={!meshData || bones.length === 0}>
              ボーンバインド
            </button>
          </div>

          {/* Toolbar per mode */}
          <div className="toolbar">
            {appMode === "mesh" && (
              <>
                <label>
                  密度:
                  <input type="range" min={10} max={80} value={meshDensity}
                    onChange={(e) => handleDensityChange(Number(e.target.value))} />
                  <span>{meshDensity}px</span>
                </label>
                <label>
                  パディング:
                  <input type="range" min={0} max={30} value={padding}
                    onChange={(e) => handlePaddingChange(Number(e.target.value))} />
                  <span>{padding}px</span>
                </label>
                <select value={contourMode}
                  onChange={(e) => handleContourModeChange(e.target.value as "concave" | "convex")}>
                  <option value="concave">輪郭追従</option>
                  <option value="convex">凸包</option>
                </select>
              </>
            )}

            {appMode === "boneCreate" && (
              <>
                <span className="toolbar-hint">クリックでボーン配置 / 既存ボーンの先端クリックで子ボーン追加</span>
                <button onClick={() => { setBones([]); setSelectedBoneId(null); setVertexWeights([]); }}>
                  全ボーン削除
                </button>
              </>
            )}

            {appMode === "boneBind" && (
              <>
                <div className="bind-tools">
                  <button className={bindTool === "auto" ? "active" : ""} onClick={() => setBindTool("auto")}>自動</button>
                  <button className={bindTool === "paint" ? "active" : ""} onClick={() => setBindTool("paint")}>ペイント</button>
                  <button className={bindTool === "select" ? "active" : ""} onClick={() => setBindTool("select")}>選択</button>
                </div>
                {bindTool === "auto" && (
                  <button className="auto-bind-btn" onClick={handleAutoBind}>自動バインド実行</button>
                )}
                {bindTool === "paint" && (
                  <>
                    <label>
                      半径:
                      <input type="range" min={5} max={100} value={brushRadius}
                        onChange={(e) => setBrushRadius(Number(e.target.value))} />
                      <span>{brushRadius}px</span>
                    </label>
                    <label>
                      強度:
                      <input type="range" min={0.01} max={1} step={0.01} value={brushStrength}
                        onChange={(e) => setBrushStrength(Number(e.target.value))} />
                      <span>{brushStrength.toFixed(2)}</span>
                    </label>
                  </>
                )}
                <select value={selectedBoneId ?? ""} onChange={(e) => setSelectedBoneId(e.target.value || null)}>
                  <option value="">ボーン選択...</option>
                  {bones.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </>
            )}

            <label>
              <input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} />
              画像
            </label>
            <label>
              <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
              メッシュ
            </label>
            {processing && <span className="processing">処理中...</span>}
            <button onClick={() => { setImage(null); setMeshData(null); setBones([]); setVertexWeights([]); setSelectedVertices(new Set()); }}>
              リセット
            </button>
          </div>

          <div className="main-area">
            <div className="canvas-container" onDrop={handleDrop} onDragOver={handleDragOver}>
              <canvas ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                style={{ cursor: appMode === "boneCreate" ? "crosshair" : appMode === "boneBind" && bindTool === "paint" ? "cell" : "default" }}
              />
            </div>

            {/* Side panel for bone list & weight editor */}
            {(appMode === "boneCreate" || appMode === "boneBind") && (
              <div className="side-panel">
                <div className="bone-list">
                  <div className="panel-title">ボーン一覧</div>
                  {bones.length === 0 && <div className="panel-empty">ボーンなし</div>}
                  {bones.map(bone => (
                    <div key={bone.id}
                      className={`bone-item ${bone.id === selectedBoneId ? "selected" : ""}`}
                      onClick={() => setSelectedBoneId(bone.id)}>
                      {bone.name}
                      {bone.parentId && <span className="bone-parent"> ← {bones.find(b => b.id === bone.parentId)?.name}</span>}
                    </div>
                  ))}
                </div>
                {weightEditorRows}
              </div>
            )}
          </div>

          {meshData && (
            <div className="stats">
              頂点: {meshData.points.length} / 三角形: {meshData.triangles.length / 3}
              {bones.length > 0 && ` / ボーン: ${bones.length}`}
              {vertexWeights.length > 0 && " / バインド済み"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
