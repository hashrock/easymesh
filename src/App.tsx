import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerInput, WorkerOutput } from "./meshWorker";
import type { AppMode, BindTool, Bone, BoneTransform, AnimationClip, MeshData, VertexWeights } from "./types";
import { drawBones, drawWeightOverlay, drawVertexWeights, findBoneAt, findBoneTailAt } from "./bones/BoneRenderer";
import { autoBind, applyWeightPaint, setVertexWeight } from "./bones/autoBind";
import { createClip, evaluateAnimation, deformMesh } from "./bones/animation";
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

  // --- Animation state ---
  const [clip, setClip] = useState<AnimationClip | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedKfIdx, setSelectedKfIdx] = useState<number | null>(null); // index in selected bone's track
  const [timelinePopup, setTimelinePopup] = useState<{ boneId: string; time: number; x: number; y: number } | null>(null);
  const animFrameRef = useRef(0);
  const lastTimeRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRequestRef = useRef<(() => void) | null>(null);
  const workerBusyRef = useRef(false);
  const isPaintingRef = useRef(false);
  const drawRequestedRef = useRef(false);
  const [weightsRev, setWeightsRev] = useState(0);
  const [clipRev, setClipRev] = useState(0);
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
      img.onload = () => {
        setImage(img);
        const pad = autoPadding(meshDensity);
        setPadding(pad);
        processImage(img, undefined, pad);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }, [processImage, meshDensity]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);

  // --- Mesh param handlers ---
  const autoPadding = (density: number) => Math.min(30, Math.ceil(density * 0.5) + 2);

  const handleDensityChange = useCallback((val: number) => {
    setMeshDensity(val);
    const pad = autoPadding(val);
    setPadding(pad);
    if (image) processImage(image, val, pad);
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
        const parentBone = findBoneTailAt(bones, x, y);
        if (parentBone) {
          setPendingBone({ headX: parentBone.tailX, headY: parentBone.tailY, tailX: x, tailY: y, parentId: parentBone.id });
        } else {
          setPendingBone({ headX: x, headY: y, tailX: x, tailY: y, parentId: null });
        }
      } else {
        const id = genBoneId();
        const newBone: Bone = {
          id, name: `Bone ${bones.length + 1}`,
          headX: pendingBone.headX, headY: pendingBone.headY,
          tailX: x, tailY: y, parentId: pendingBone.parentId,
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
    } else if (appMode === "animate") {
      const clicked = findBoneAt(bones, x, y);
      if (clicked) setSelectedBoneId(clicked);
    }
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, meshData, vertexWeights, brushRadius, brushStrength, updateWeights]);

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
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, meshData, vertexWeights, brushRadius, brushStrength, updateWeights]);

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
    if (appMode === "animate" && e.key === " ") {
      e.preventDefault();
      setIsPlaying(p => !p);
    }
  }, [appMode, selectedBoneId]);

  // --- Auto bind ---
  const handleAutoBind = useCallback(() => {
    if (!meshData || bones.length === 0) return;
    const weights = autoBind(meshData.points, bones);
    updateWeights(weights);
  }, [meshData, bones, updateWeights]);

  // --- Animation helpers ---
  const initAnimation = useCallback(() => {
    if (bones.length === 0) return;
    setClip(createClip("Animation 1", 2.0, bones));
    setCurrentTime(0);
    setSelectedKfIdx(0);
  }, [bones]);

  /** Add a keyframe for the selected bone at a given time */
  const addKeyframeAt = useCallback((time: number, boneId: string) => {
    if (!clip) return;
    setClip(prev => {
      if (!prev) return prev;
      const track = prev.tracks[boneId] ?? [];
      const existing = track.findIndex(kf => Math.abs(kf.time - time) < 0.01);
      if (existing >= 0) {
        setSelectedKfIdx(existing);
        setCurrentTime(time);
        return prev;
      }
      // Interpolate current value
      const currentTransforms = evaluateAnimation(prev, time);
      const tf = currentTransforms[boneId] ?? { rotation: 0, translateX: 0, translateY: 0 };
      const newTrack = [...track, { time, transform: { ...tf } }].sort((a, b) => a.time - b.time);
      const idx = newTrack.findIndex(kf => Math.abs(kf.time - time) < 0.01);
      setSelectedKfIdx(idx);
      setCurrentTime(time);
      return { ...prev, tracks: { ...prev.tracks, [boneId]: newTrack } };
    });
    setClipRev(r => r + 1);
  }, [clip]);

  /** Update a transform field on the selected bone's selected keyframe */
  const updateBoneTransformInKeyframe = useCallback((boneId: string, field: keyof BoneTransform, value: number) => {
    if (!clip || selectedKfIdx == null) return;
    setClip(prev => {
      if (!prev) return prev;
      const track = prev.tracks[boneId];
      if (!track || !track[selectedKfIdx]) return prev;
      const newTrack = track.map((kf, i) => {
        if (i !== selectedKfIdx) return kf;
        return { ...kf, transform: { ...kf.transform, [field]: value } };
      });
      return { ...prev, tracks: { ...prev.tracks, [boneId]: newTrack } };
    });
    setClipRev(r => r + 1);
  }, [clip, selectedKfIdx]);

  /** Delete the selected keyframe from the selected bone's track */
  const deleteKeyframe = useCallback(() => {
    if (!clip || !selectedBoneId || selectedKfIdx == null) return;
    const track = clip.tracks[selectedBoneId];
    if (!track || track.length <= 1) return;
    const newTrack = track.filter((_, i) => i !== selectedKfIdx);
    setClip({ ...clip, tracks: { ...clip.tracks, [selectedBoneId]: newTrack } });
    setSelectedKfIdx(Math.min(selectedKfIdx, newTrack.length - 1));
    setClipRev(r => r + 1);
  }, [clip, selectedBoneId, selectedKfIdx]);

  // --- Playback loop ---
  useEffect(() => {
    if (!isPlaying || !clip) return;
    lastTimeRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      setCurrentTime(prev => {
        const next = prev + dt;
        return next > clip.duration ? 0 : next; // loop
      });
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, clip]);

  // --- Compute deformed points for animation ---
  const deformedPoints = (() => {
    if (appMode !== "animate" || !clip || !meshData || vertexWeights.length === 0) return null;
    const transforms = evaluateAnimation(clip, currentTime);
    return deformMesh(meshData.points, bones, transforms, vertexWeights);
  })();

  // --- Draw ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const displayPoints = deformedPoints ?? meshData?.points;

    if (showImage && meshData && appMode === "animate" && deformedPoints) {
      // Draw deformed textured mesh
      ctx.save();
      for (let i = 0; i < meshData.triangles.length; i += 3) {
        const a = meshData.triangles[i];
        const b = meshData.triangles[i + 1];
        const c = meshData.triangles[i + 2];
        drawTexturedTriangle(ctx, image,
          meshData.points[a], meshData.points[b], meshData.points[c],
          deformedPoints[a], deformedPoints[b], deformedPoints[c]
        );
      }
      ctx.restore();
    } else if (showImage) {
      ctx.globalAlpha = appMode === "boneBind" ? 0.3 : 0.5;
      ctx.drawImage(image, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Weight overlay
    if (appMode === "boneBind" && selectedBoneId && meshData && vertexWeights.length > 0) {
      drawWeightOverlay(ctx, meshData.points, meshData.triangles, vertexWeights, selectedBoneId);
    }

    if (meshData && showMesh && displayPoints) {
      ctx.strokeStyle = appMode === "boneBind" ? "rgba(0,204,255,0.3)" : appMode === "animate" ? "rgba(0,204,255,0.2)" : "#00ccff";
      ctx.lineWidth = 1;
      const { triangles } = meshData;
      for (let i = 0; i < triangles.length; i += 3) {
        ctx.beginPath();
        ctx.moveTo(displayPoints[triangles[i]][0], displayPoints[triangles[i]][1]);
        ctx.lineTo(displayPoints[triangles[i + 1]][0], displayPoints[triangles[i + 1]][1]);
        ctx.lineTo(displayPoints[triangles[i + 2]][0], displayPoints[triangles[i + 2]][1]);
        ctx.closePath();
        ctx.stroke();
      }
    }

    if (appMode === "boneBind" && selectedBoneId && meshData && vertexWeights.length > 0) {
      drawVertexWeights(ctx, meshData.points, vertexWeights, selectedBoneId, selectedVertices);
    } else if (meshData && showPoints && displayPoints && appMode !== "animate") {
      ctx.fillStyle = "#ff4444";
      for (const [x, y] of displayPoints) {
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
    if (appMode === "animate") {
      drawBones(ctx, bones, selectedBoneId, null, null);
    }
  }, [image, meshData, showImage, showMesh, showPoints, appMode, bones, selectedBoneId, hoveredBoneId, pendingBone, vertexWeights, selectedVertices, deformedPoints]);

  // Redraw when deps change
  const prevDeps = useRef<string>("");
  const depsKey = JSON.stringify({
    showImage, showMesh, showPoints, appMode, pendingBone,
    bonesLen: bones.length, selectedBoneId, hoveredBoneId,
    meshLen: meshData?.points.length, weightsRev,
    selVerts: [...selectedVertices].join(","),
    animTime: appMode === "animate" ? currentTime.toFixed(3) : 0,
    clipRev,
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

  // --- Animation keyframe editor panel ---
  const selectedTrack = clip && selectedBoneId ? clip.tracks[selectedBoneId] ?? [] : [];
  const currentKf = selectedKfIdx != null ? selectedTrack[selectedKfIdx] ?? null : null;
  const animEditorPanel = (() => {
    if (appMode !== "animate" || !clip) return null;
    return (
      <div className="side-panel">
        {currentKf && selectedBoneId && (
          <div className="weight-editor">
            <div className="weight-editor-title">
              {bones.find(b => b.id === selectedBoneId)?.name ?? "?"} @ {currentKf.time.toFixed(2)}s
            </div>
            {(() => {
              const tf = currentKf.transform;
              return (
                <>
                  <div className="weight-row">
                    <span className="param-label">回転</span>
                    <input type="range" min={-180} max={180} step={1}
                      value={Math.round(tf.rotation * 180 / Math.PI)}
                      onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "rotation", Number(e.target.value) * Math.PI / 180)}
                    />
                    <span className="weight-value">{Math.round(tf.rotation * 180 / Math.PI)}°</span>
                  </div>
                  <div className="weight-row">
                    <span className="param-label">移動X</span>
                    <input type="range" min={-100} max={100} step={1}
                      value={Math.round(tf.translateX)}
                      onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "translateX", Number(e.target.value))}
                    />
                    <span className="weight-value">{Math.round(tf.translateX)}</span>
                  </div>
                  <div className="weight-row">
                    <span className="param-label">移動Y</span>
                    <input type="range" min={-100} max={100} step={1}
                      value={Math.round(tf.translateY)}
                      onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "translateY", Number(e.target.value))}
                    />
                    <span className="weight-value">{Math.round(tf.translateY)}</span>
                  </div>
                </>
              );
            })()}
            <div className="anim-actions" style={{ marginTop: 8 }}>
              <button onClick={deleteKeyframe} disabled={selectedTrack.length <= 1}>このキーフレームを削除</button>
            </div>
          </div>
        )}
        {selectedBoneId && !currentKf && (
          <div className="bone-list">
            <div className="panel-empty">タイムラインでキーフレームを選択してください</div>
          </div>
        )}
        {!selectedBoneId && (
          <div className="bone-list">
            <div className="panel-empty">ボーンを選択してください</div>
          </div>
        )}
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
            <button className={appMode === "animate" ? "active" : ""} onClick={() => {
              setAppMode("animate");
              if (!clip) initAnimation();
            }} disabled={!meshData || bones.length === 0 || vertexWeights.length === 0}>
              アニメーション
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

            {appMode === "animate" && clip && (
              <>
                <button onClick={() => setIsPlaying(p => !p)}>
                  {isPlaying ? "⏸ 停止" : "▶ 再生"}
                </button>
                <span className="toolbar-hint">{currentTime.toFixed(2)}s / {clip.duration.toFixed(1)}s</span>
                <label>
                  時間長:
                  <input type="range" min={0.5} max={10} step={0.5} value={clip.duration}
                    onChange={(e) => {
                      const d = Number(e.target.value);
                      setClip(prev => prev ? { ...prev, duration: d } : prev);
                    }} />
                  <span>{clip.duration.toFixed(1)}s</span>
                </label>
              </>
            )}

            <label>
              <input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} />
              画像
            </label>
            <label>
              <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
              メッシュ線
            </label>
            <label>
              <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
              頂点
            </label>
            {processing && <span className="processing">処理中...</span>}
            <button onClick={() => { setImage(null); setMeshData(null); setBones([]); setVertexWeights([]); setSelectedVertices(new Set()); setClip(null); }}>
              リセット
            </button>
          </div>

          <div className="main-area">
            <div className="canvas-container" onDrop={handleDrop} onDragOver={handleDragOver}>
              <canvas ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                style={{ cursor: appMode === "boneCreate" ? "crosshair" : appMode === "boneBind" && bindTool === "paint" ? "cell" : appMode === "animate" ? "pointer" : "default" }}
              />
            </div>

            {/* Side panel */}
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
            {appMode === "animate" && animEditorPanel}
          </div>

          {/* Per-bone timeline */}
          {appMode === "animate" && clip && (
            <div className="timeline">
              {/* Time ruler */}
              <div className="timeline-row">
                <div className="timeline-label timeline-ruler-label">時間</div>
                <div className="timeline-track timeline-ruler"
                  onMouseDown={(e) => {
                    const track = e.currentTarget;
                    const scrub = (ev: MouseEvent) => {
                      const rect = track.getBoundingClientRect();
                      const t = ((ev.clientX - rect.left) / rect.width) * clip.duration;
                      setCurrentTime(Math.max(0, Math.min(clip.duration, t)));
                    };
                    scrub(e.nativeEvent);
                    setIsPlaying(false);
                    setTimelinePopup(null);
                    const onMove = (ev: MouseEvent) => scrub(ev);
                    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}>
                  <div className="timeline-playhead" style={{ left: `${(currentTime / clip.duration) * 100}%` }} />
                  {/* Time ticks */}
                  {Array.from({ length: Math.floor(clip.duration / 0.5) + 1 }, (_, i) => {
                    const t = i * 0.5;
                    return <div key={i} className="timeline-tick" style={{ left: `${(t / clip.duration) * 100}%` }}>
                      <span className="timeline-tick-label">{t.toFixed(1)}</span>
                    </div>;
                  })}
                </div>
              </div>
              {/* Bone rows */}
              {bones.map(bone => (
                <div key={bone.id} className={`timeline-row ${bone.id === selectedBoneId ? "selected" : ""}`}>
                  <div className="timeline-label" onClick={() => setSelectedBoneId(bone.id)}>
                    {bone.name}
                  </div>
                  <div className="timeline-track"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const t = ((e.clientX - rect.left) / rect.width) * clip.duration;
                      const clickedTime = Math.max(0, Math.min(clip.duration, t));
                      const track = clip.tracks[bone.id] ?? [];
                      const nearKf = track.findIndex(kf => Math.abs((kf.time / clip.duration) - (clickedTime / clip.duration)) < 0.02);
                      if (nearKf >= 0) {
                        setSelectedKfIdx(nearKf);
                        setCurrentTime(track[nearKf].time);
                        setSelectedBoneId(bone.id);
                        setIsPlaying(false);
                        setTimelinePopup(null);
                      } else if (bone.id === selectedBoneId) {
                        setTimelinePopup({ boneId: bone.id, time: clickedTime, x: e.clientX, y: e.clientY });
                        setIsPlaying(false);
                      } else {
                        setSelectedBoneId(bone.id);
                        setSelectedKfIdx(null);
                        setCurrentTime(clickedTime);
                        setIsPlaying(false);
                        setTimelinePopup(null);
                      }
                    }}>
                    <div className="timeline-playhead" style={{ left: `${(currentTime / clip.duration) * 100}%` }} />
                    {(clip.tracks[bone.id] ?? []).map((kf, i) => {
                      const hasData = kf.transform.rotation !== 0 || kf.transform.translateX !== 0 || kf.transform.translateY !== 0;
                      const isSelected = bone.id === selectedBoneId && i === selectedKfIdx;
                      return (
                        <div key={i}
                          className={`timeline-kf ${isSelected ? "selected" : ""} ${hasData ? "has-data" : ""}`}
                          style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedKfIdx(i);
                            setCurrentTime(kf.time);
                            setSelectedBoneId(bone.id);
                            setIsPlaying(false);
                            setTimelinePopup(null);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* Add keyframe popup */}
              {timelinePopup && (
                <div className="timeline-popup" style={{ left: timelinePopup.x, top: timelinePopup.y }}>
                  <button onClick={() => {
                    addKeyframeAt(timelinePopup.time, timelinePopup.boneId);
                    setTimelinePopup(null);
                  }}>
                    {timelinePopup.time.toFixed(2)}s にキーフレーム追加
                  </button>
                  <button onClick={() => setTimelinePopup(null)}>キャンセル</button>
                </div>
              )}
            </div>
          )}

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

/** Draw a textured triangle from source (rest pose) to destination (deformed) */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  s0: [number, number], s1: [number, number], s2: [number, number], // source UVs
  d0: [number, number], d1: [number, number], d2: [number, number], // destination positions
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0[0], d0[1]);
  ctx.lineTo(d1[0], d1[1]);
  ctx.lineTo(d2[0], d2[1]);
  ctx.closePath();
  ctx.clip();

  // Affine transform from source triangle to destination triangle
  // We solve: [d0, d1, d2] = M * [s0, s1, s2]
  const sx0 = s0[0], sy0 = s0[1];
  const sx1 = s1[0], sy1 = s1[1];
  const sx2 = s2[0], sy2 = s2[1];
  const dx0 = d0[0], dy0 = d0[1];
  const dx1 = d1[0], dy1 = d1[1];
  const dx2 = d2[0], dy2 = d2[1];

  const det = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(det) < 1e-6) { ctx.restore(); return; }
  const invDet = 1 / det;

  const a = ((dx0 * (sy1 - sy2)) + (dx1 * (sy2 - sy0)) + (dx2 * (sy0 - sy1))) * invDet;
  const b = ((dx0 * (sx2 - sx1)) + (dx1 * (sx0 - sx2)) + (dx2 * (sx1 - sx0))) * invDet;
  const c_val = ((dx0 * (sx1 * sy2 - sx2 * sy1)) + (dx1 * (sx2 * sy0 - sx0 * sy2)) + (dx2 * (sx0 * sy1 - sx1 * sy0))) * invDet;
  const d = ((dy0 * (sy1 - sy2)) + (dy1 * (sy2 - sy0)) + (dy2 * (sy0 - sy1))) * invDet;
  const e_val = ((dy0 * (sx2 - sx1)) + (dy1 * (sx0 - sx2)) + (dy2 * (sx1 - sx0))) * invDet;
  const f = ((dy0 * (sx1 * sy2 - sx2 * sy1)) + (dy1 * (sx2 * sy0 - sx0 * sy2)) + (dy2 * (sx0 * sy1 - sx1 * sy0))) * invDet;

  ctx.setTransform(a, d, b, e_val, c_val, f);
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.restore();
}

export default App;
