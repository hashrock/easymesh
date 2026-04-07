import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerInput, WorkerOutput } from "./meshWorker";
import type { AppMode, BindTool, Bone, BoneTransform, AnimationClip, Layer } from "./types";
import { drawBones, drawWeightOverlay, drawVertexWeights, findBoneAt, findBoneTailAt } from "./bones/BoneRenderer";
import { autoBind, applyWeightPaint, setVertexWeight } from "./bones/autoBind";
import { createClip, evaluateAnimation, deformMesh } from "./bones/animation";
import BoneTree from "./components/BoneTree";
import sampleLayer2 from "./assets/layer2.png";
import sampleLayer3 from "./assets/layer3.png";
import "./App.css";

let nextBoneId = 1;
function genBoneId() { return `bone_${nextBoneId++}`; }
let nextLayerId = 1;
function genLayerId() { return `layer_${nextLayerId++}`; }

const autoPadding = (density: number) => Math.min(30, Math.ceil(density * 0.5) + 2);

function App() {
  // --- Layers ---
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [meshDensity, setMeshDensity] = useState(30);
  const [contourMode, setContourMode] = useState<"concave" | "convex">("concave");
  const [processing, setProcessing] = useState(false);
  const [showImage, setShowImage] = useState(true);
  const [showMesh, setShowMesh] = useState(false);
  const [showPoints, setShowPoints] = useState(false);

  // --- Mode state ---
  const [appMode, setAppMode] = useState<AppMode>("mesh");

  // --- Bone state ---
  const [bones, setBones] = useState<Bone[]>([]);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);
  const [pendingBone, setPendingBone] = useState<{ headX: number; headY: number; tailX: number; tailY: number; parentId: string | null } | null>(null);

  // --- Bind state ---
  const [bindTool, setBindTool] = useState<BindTool>("paint");
  const [brushRadius, setBrushRadius] = useState(30);
  const [brushStrength, setBrushStrength] = useState(0.3);
  const [selectedVertices, setSelectedVertices] = useState<Set<number>>(new Set());

  // --- Animation state ---
  const [clip, setClip] = useState<AnimationClip | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedKfIdx, setSelectedKfIdx] = useState<number | null>(null);
  const [addKfMarker, setAddKfMarker] = useState<{ boneId: string; time: number; pct: number } | null>(null);
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
  const [rev, setRev] = useState(0); // generic redraw trigger
  const bumpRev = useCallback(() => setRev(r => r + 1), []);

  // Image element cache (keyed by layer id)
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const getImage = useCallback((layer: Layer): HTMLImageElement | null => {
    let img = imageCache.current.get(layer.id);
    if (img) return img.complete ? img : null;
    img = new Image();
    img.onload = () => bumpRev();
    img.src = layer.imageSrc;
    imageCache.current.set(layer.id, img);
    return null;
  }, [bumpRev]);

  // Derived: selected layer
  const selectedLayer = layers.find(l => l.id === selectedLayerId) ?? null;

  // --- Worker ---
  useEffect(() => {
    const worker = new Worker(new URL("./meshWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // --- Load sample layers on first mount ---
  const sampleLoaded = useRef(false);
  useEffect(() => {
    if (sampleLoaded.current || layers.length > 0) return;
    sampleLoaded.current = true;
    const samples = [
      { src: sampleLayer2, name: "レイヤー 2" },
      { src: sampleLayer3, name: "レイヤー 3" },
    ];
    // Load all images first, then process sequentially
    let loaded = 0;
    const images: { id: string; img: HTMLImageElement; idx: number }[] = [];
    for (let si = 0; si < samples.length; si++) {
      const sample = samples[si];
      const img = new Image();
      img.onload = () => {
        const id = genLayerId();
        imageCache.current.set(id, img);
        setLayers(prev => [...prev, {
          id, name: sample.name, imageSrc: sample.src,
          mesh: null, weights: [], attachBoneId: null,
          zOrder: si, visible: true,
        }]);
        if (si === 0) setSelectedLayerId(id);
        images.push({ id, img, idx: si });
        loaded++;
        if (loaded === samples.length) processSampleQueue(images);
      };
      img.src = sample.src;
    }

    function processSampleQueue(queue: { id: string; img: HTMLImageElement; idx: number }[]) {
      let i = 0;
      function processNext() {
        if (i >= queue.length) return;
        const { id, img } = queue[i];
        const worker = workerRef.current;
        if (!worker) return;
        const spacing = meshDensity;
        const pad = autoPadding(spacing);
        const offscreen = document.createElement("canvas");
        offscreen.width = img.width; offscreen.height = img.height;
        const ctx = offscreen.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        worker.onmessage = (ev: MessageEvent<WorkerOutput | null>) => {
          if (ev.data) {
            setLayers(prev => prev.map(l => l.id === id ? { ...l, mesh: ev.data! } : l));
            bumpRev();
          }
          i++;
          processNext();
        };
        worker.postMessage({
          imageData: imageData.data, width: img.width, height: img.height,
          spacing, padding: pad, contourMode,
        } as WorkerInput);
      }
      processNext();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generateMeshForLayer = useCallback((layerId: string, img: HTMLImageElement, density?: number) => {
    const worker = workerRef.current;
    if (!worker) return;
    const spacing = density ?? meshDensity;
    const pad = autoPadding(spacing);
    const offscreen = document.createElement("canvas");
    offscreen.width = img.width; offscreen.height = img.height;
    const ctx = offscreen.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const id = ++requestIdRef.current;
    setProcessing(true);
    workerBusyRef.current = true;
    const input: WorkerInput = {
      imageData: imageData.data, width: img.width, height: img.height,
      spacing, padding: pad, contourMode,
    };
    worker.onmessage = (e: MessageEvent<WorkerOutput | null>) => {
      workerBusyRef.current = false;
      if (id !== requestIdRef.current) return;
      setProcessing(false);
      if (e.data) {
        setLayers(prev => prev.map(l => l.id === layerId ? { ...l, mesh: e.data!, weights: [] } : l));
        bumpRev();
      }
      const pending = pendingRequestRef.current;
      if (pending) { pendingRequestRef.current = null; pending(); }
    };
    worker.postMessage(input);
  }, [meshDensity, contourMode, bumpRev]);

  const processSelectedLayer = useCallback((density?: number) => {
    if (!selectedLayer) return;
    const img = getImage(selectedLayer);
    if (!img || !img.complete) return;
    const fire = () => generateMeshForLayer(selectedLayer.id, img, density);
    if (workerBusyRef.current) { pendingRequestRef.current = fire; return; }
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    throttleTimerRef.current = setTimeout(() => { throttleTimerRef.current = null; fire(); }, 50);
  }, [selectedLayer, getImage, generateMeshForLayer]);

  // --- Canvas coordinate helper ---
  const canvasCoords = useCallback((e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height];
  }, []);

  // --- Drop handler: add layers ---
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const id = genLayerId();
          imageCache.current.set(id, img);
          const newLayer: Layer = {
            id, name: file.name.replace(/\.\w+$/, ""),
            imageSrc: src, mesh: null, weights: [],
            attachBoneId: null, zOrder: layers.length, visible: true,
          };
          setLayers(prev => [...prev, newLayer]);
          setSelectedLayerId(id);
          // Auto-generate mesh
          const worker = workerRef.current;
          if (!worker) return;
          const spacing = meshDensity;
          const pad = autoPadding(spacing);
          const offscreen = document.createElement("canvas");
          offscreen.width = img.width; offscreen.height = img.height;
          const ctx = offscreen.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          const reqId = ++requestIdRef.current;
          setProcessing(true);
          workerBusyRef.current = true;
          worker.onmessage = (ev: MessageEvent<WorkerOutput | null>) => {
            workerBusyRef.current = false;
            if (reqId !== requestIdRef.current) return;
            setProcessing(false);
            if (ev.data) {
              setLayers(prev => prev.map(l => l.id === id ? { ...l, mesh: ev.data! } : l));
              bumpRev();
            }
          };
          worker.postMessage({
            imageData: imageData.data, width: img.width, height: img.height,
            spacing, padding: pad, contourMode,
          } as WorkerInput);
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    }
  }, [layers.length, meshDensity, contourMode, bumpRev]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);

  // --- Mesh param handlers ---
  const handleDensityChange = useCallback((val: number) => {
    setMeshDensity(val);
    processSelectedLayer(val);
  }, [processSelectedLayer]);

  const handleContourModeChange = useCallback((mode: "concave" | "convex") => {
    setContourMode(mode);
    // regenerate will happen via processSelectedLayer dependency change
  }, []);

  // --- Layer helpers ---
  const updateSelectedLayer = useCallback((updater: (l: Layer) => Layer) => {
    if (!selectedLayerId) return;
    setLayers(prev => prev.map(l => l.id === selectedLayerId ? updater(l) : l));
    bumpRev();
  }, [selectedLayerId, bumpRev]);

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
        const isFirst = bones.length === 0;
        const newBone: Bone = {
          id, name: isFirst ? "ROOT" : `Bone ${bones.length + 1}`,
          headX: pendingBone.headX, headY: pendingBone.headY,
          tailX: x, tailY: y, parentId: pendingBone.parentId,
        };
        setBones(prev => [...prev, newBone]);
        setPendingBone(null);
        setSelectedBoneId(id);
      }
    } else if (appMode === "boneBind" && selectedLayer?.mesh) {
      const mesh = selectedLayer.mesh;
      const weights = selectedLayer.weights;
      if (bindTool === "paint" && selectedBoneId) {
        isPaintingRef.current = true;
        const newWeights = applyWeightPaint(
          mesh.points, weights.length ? weights : mesh.points.map(() => ({})),
          [x, y], brushRadius, brushStrength, selectedBoneId
        );
        updateSelectedLayer(l => ({ ...l, weights: newWeights }));
      } else if (bindTool === "select") {
        let minDist = Infinity; let nearest = -1;
        for (let i = 0; i < mesh.points.length; i++) {
          const d = Math.hypot(mesh.points[i][0] - x, mesh.points[i][1] - y);
          if (d < minDist) { minDist = d; nearest = i; }
        }
        if (nearest >= 0 && minDist < 15) {
          if (e.shiftKey) {
            setSelectedVertices(prev => { const n = new Set(prev); if (n.has(nearest)) n.delete(nearest); else n.add(nearest); return n; });
          } else { setSelectedVertices(new Set([nearest])); }
        } else { setSelectedVertices(new Set()); }
      }
    } else if (appMode === "animate") {
      const clicked = findBoneAt(bones, x, y);
      if (clicked) setSelectedBoneId(clicked);
    }
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, selectedLayer, brushRadius, brushStrength, updateSelectedLayer]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = canvasCoords(e);
    if (!pos) return;
    const [x, y] = pos;
    if (appMode === "boneCreate") {
      if (pendingBone) { setPendingBone(prev => prev ? { ...prev, tailX: x, tailY: y } : null); }
      else { setHoveredBoneId(findBoneAt(bones, x, y)); }
    } else if (appMode === "boneBind" && bindTool === "paint" && isPaintingRef.current && selectedBoneId && selectedLayer?.mesh) {
      const mesh = selectedLayer.mesh;
      const weights = selectedLayer.weights;
      const newWeights = applyWeightPaint(
        mesh.points, weights.length ? weights : mesh.points.map(() => ({})),
        [x, y], brushRadius, brushStrength, selectedBoneId
      );
      updateSelectedLayer(l => ({ ...l, weights: newWeights }));
    }
  }, [appMode, pendingBone, bones, canvasCoords, bindTool, selectedBoneId, selectedLayer, brushRadius, brushStrength, updateSelectedLayer]);

  const handleCanvasMouseUp = useCallback(() => { isPaintingRef.current = false; }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (appMode === "boneCreate") {
      if (e.key === "Escape") setPendingBone(null);
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedBoneId) {
        setBones(prev => prev.filter(b => b.id !== selectedBoneId));
        setSelectedBoneId(null);
      }
    }
    if (appMode === "animate" && e.key === " ") { e.preventDefault(); setIsPlaying(p => !p); }
  }, [appMode, selectedBoneId]);

  // --- Animation helpers ---
  const initAnimation = useCallback(() => {
    if (bones.length === 0) return;
    setClip(createClip("Animation 1", 2.0, bones));
    setCurrentTime(0); setSelectedKfIdx(0);
  }, [bones]);

  const addKeyframeAt = useCallback((time: number, boneId: string) => {
    if (!clip) return;
    setClip(prev => {
      if (!prev) return prev;
      const track = prev.tracks[boneId] ?? [];
      const existing = track.findIndex(kf => Math.abs(kf.time - time) < 0.01);
      if (existing >= 0) { setSelectedKfIdx(existing); setCurrentTime(time); return prev; }
      const tf = evaluateAnimation(prev, time)[boneId] ?? { rotation: 0, translateX: 0, translateY: 0 };
      const newTrack = [...track, { time, transform: { ...tf } }].sort((a, b) => a.time - b.time);
      setSelectedKfIdx(newTrack.findIndex(kf => Math.abs(kf.time - time) < 0.01));
      setCurrentTime(time);
      return { ...prev, tracks: { ...prev.tracks, [boneId]: newTrack } };
    });
    bumpRev();
  }, [clip, bumpRev]);

  const updateBoneTransformInKeyframe = useCallback((boneId: string, field: keyof BoneTransform, value: number) => {
    if (!clip || selectedKfIdx == null) return;
    setClip(prev => {
      if (!prev) return prev;
      const track = prev.tracks[boneId];
      if (!track?.[selectedKfIdx]) return prev;
      const newTrack = track.map((kf, i) => i !== selectedKfIdx ? kf : { ...kf, transform: { ...kf.transform, [field]: value } });
      return { ...prev, tracks: { ...prev.tracks, [boneId]: newTrack } };
    });
    bumpRev();
  }, [clip, selectedKfIdx, bumpRev]);

  const deleteKeyframe = useCallback(() => {
    if (!clip || !selectedBoneId || selectedKfIdx == null) return;
    const track = clip.tracks[selectedBoneId];
    if (!track || track.length <= 1) return;
    const newTrack = track.filter((_, i) => i !== selectedKfIdx);
    setClip({ ...clip, tracks: { ...clip.tracks, [selectedBoneId]: newTrack } });
    setSelectedKfIdx(Math.min(selectedKfIdx, newTrack.length - 1));
    bumpRev();
  }, [clip, selectedBoneId, selectedKfIdx, bumpRev]);

  // --- Playback ---
  useEffect(() => {
    if (!isPlaying || !clip) return;
    lastTimeRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      setCurrentTime(prev => { const next = prev + dt; return next > clip.duration ? 0 : next; });
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, clip]);

  // --- Draw ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || layers.length === 0) return;
    // Determine canvas size from largest layer image
    let maxW = 0, maxH = 0;
    for (const layer of layers) {
      const img = getImage(layer);
      if (img?.complete) { maxW = Math.max(maxW, img.width); maxH = Math.max(maxH, img.height); }
    }
    if (maxW === 0) return;
    canvas.width = maxW; canvas.height = maxH;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, maxW, maxH);

    const transforms = clip ? evaluateAnimation(clip, currentTime) : null;
    const sortedLayers = [...layers].sort((a, b) => a.zOrder - b.zOrder);

    for (const layer of sortedLayers) {
      if (!layer.visible) continue;
      const img = getImage(layer);
      if (!img?.complete) continue;

      const mesh = layer.mesh;
      const isAnimating = appMode === "animate" && transforms && mesh && layer.weights.length > 0;
      const deformed = isAnimating ? deformMesh(mesh!.points, bones, transforms, layer.weights) : null;

      if (showImage && deformed && mesh) {
        ctx.save();
        for (let i = 0; i < mesh.triangles.length; i += 3) {
          const a = mesh.triangles[i], b = mesh.triangles[i + 1], c = mesh.triangles[i + 2];
          drawTexturedTriangle(ctx, img,
            mesh.points[a], mesh.points[b], mesh.points[c],
            deformed[a], deformed[b], deformed[c]
          );
        }
        ctx.restore();
      } else if (showImage) {
        ctx.globalAlpha = appMode === "boneBind" ? 0.3 : (layer.id === selectedLayerId ? 0.6 : 0.3);
        ctx.drawImage(img, 0, 0);
        ctx.globalAlpha = 1;
      }

      if (!mesh) continue; // remaining drawing needs mesh

      const displayPoints = deformed ?? mesh.points;

      if (appMode === "boneBind" && layer.id === selectedLayerId && selectedBoneId && layer.weights.length > 0) {
        drawWeightOverlay(ctx, mesh.points, mesh.triangles, layer.weights, selectedBoneId);
      }

      if (showMesh && displayPoints) {
        ctx.strokeStyle = layer.id === selectedLayerId ? "#00ccff" : "rgba(0,204,255,0.15)";
        ctx.lineWidth = 1;
        for (let i = 0; i < mesh.triangles.length; i += 3) {
          ctx.beginPath();
          ctx.moveTo(displayPoints[mesh.triangles[i]][0], displayPoints[mesh.triangles[i]][1]);
          ctx.lineTo(displayPoints[mesh.triangles[i + 1]][0], displayPoints[mesh.triangles[i + 1]][1]);
          ctx.lineTo(displayPoints[mesh.triangles[i + 2]][0], displayPoints[mesh.triangles[i + 2]][1]);
          ctx.closePath(); ctx.stroke();
        }
      }

      if (appMode === "boneBind" && layer.id === selectedLayerId && selectedBoneId && layer.weights.length > 0) {
        drawVertexWeights(ctx, mesh.points, layer.weights, selectedBoneId, selectedVertices);
      } else if (showPoints && displayPoints && layer.id === selectedLayerId && appMode !== "animate") {
        ctx.fillStyle = "#ff4444";
        for (const [x, y] of displayPoints) { ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
      }

      if (layer.id === selectedLayerId && appMode === "mesh") {
        ctx.strokeStyle = "#ffcc00"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mesh.hull[0][0], mesh.hull[0][1]);
        for (let i = 1; i < mesh.hull.length; i++) ctx.lineTo(mesh.hull[i][0], mesh.hull[i][1]);
        ctx.closePath(); ctx.stroke();
      }
    }

    // Bones
    if (appMode === "boneCreate" || appMode === "boneBind") {
      drawBones(ctx, bones, selectedBoneId, hoveredBoneId, pendingBone);
    }
    if (appMode === "animate") { drawBones(ctx, bones, selectedBoneId, null, null); }
  }, [layers, selectedLayerId, showImage, showMesh, showPoints, appMode, bones, selectedBoneId, hoveredBoneId, pendingBone, selectedVertices, clip, currentTime, getImage]);

  // Redraw
  const prevDeps = useRef<string>("");
  const depsKey = JSON.stringify({
    showImage, showMesh, showPoints, appMode, pendingBone, rev,
    bonesLen: bones.length, selectedBoneId, hoveredBoneId, selectedLayerId,
    layersLen: layers.length, selVerts: [...selectedVertices].join(","),
    animTime: appMode === "animate" ? currentTime.toFixed(3) : 0,
  });
  if (depsKey !== prevDeps.current) {
    prevDeps.current = depsKey;
    if (!drawRequestedRef.current) {
      drawRequestedRef.current = true;
      requestAnimationFrame(() => { drawRequestedRef.current = false; draw(); });
    }
  }

  // --- Bone/Layer tree DnD handlers ---
  const handleMoveBone = useCallback((boneId: string, newParentBoneId: string | null) => {
    // Prevent circular reference
    if (boneId === newParentBoneId) return;
    setBones(prev => prev.map(b => b.id === boneId ? { ...b, parentId: newParentBoneId } : b));
  }, []);

  const handleMoveLayer = useCallback((layerId: string, newAttachBoneId: string | null) => {
    setLayers(prev => prev.map(l => l.id === layerId ? { ...l, attachBoneId: newAttachBoneId } : l));
    bumpRev();
  }, [bumpRev]);

  // --- Weight editor ---
  const weightEditorRows = (() => {
    if (appMode !== "boneBind" || bindTool !== "select" || selectedVertices.size === 0 || bones.length === 0 || !selectedLayer) return null;
    const weights = selectedLayer.weights;
    const avg: Record<string, number> = {};
    for (const bone of bones) avg[bone.id] = 0;
    for (const vi of selectedVertices) {
      const w = weights[vi] ?? {};
      for (const bone of bones) avg[bone.id] += (w[bone.id] ?? 0);
    }
    for (const bone of bones) avg[bone.id] /= selectedVertices.size;
    return (
      <div className="weight-editor">
        <div className="weight-editor-title">選択頂点のウェイト ({selectedVertices.size}個)</div>
        {bones.map(bone => (
          <div key={bone.id} className="weight-row">
            <span className={bone.id === selectedBoneId ? "weight-bone-name active" : "weight-bone-name"}
              onClick={() => setSelectedBoneId(bone.id)}>{bone.name}</span>
            <input type="range" min={0} max={1} step={0.01} value={avg[bone.id]}
              onChange={(e) => {
                const val = Number(e.target.value);
                const indices = [...selectedVertices];
                const mesh = selectedLayer.mesh;
                const newWeights = setVertexWeight(
                  weights.length ? weights : (mesh?.points ?? []).map(() => ({})),
                  indices, bone.id, val
                );
                updateSelectedLayer(l => ({ ...l, weights: newWeights }));
              }} />
            <span className="weight-value">{avg[bone.id].toFixed(2)}</span>
          </div>
        ))}
      </div>
    );
  })();

  // --- Animation editor panel ---
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
              return (<>
                <div className="weight-row">
                  <span className="param-label">回転</span>
                  <input type="range" min={-180} max={180} step={1}
                    value={Math.round(tf.rotation * 180 / Math.PI)}
                    onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "rotation", Number(e.target.value) * Math.PI / 180)} />
                  <span className="weight-value">{Math.round(tf.rotation * 180 / Math.PI)}°</span>
                </div>
                <div className="weight-row">
                  <span className="param-label">移動X</span>
                  <input type="range" min={-100} max={100} step={1} value={Math.round(tf.translateX)}
                    onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "translateX", Number(e.target.value))} />
                  <span className="weight-value">{Math.round(tf.translateX)}</span>
                </div>
                <div className="weight-row">
                  <span className="param-label">移動Y</span>
                  <input type="range" min={-100} max={100} step={1} value={Math.round(tf.translateY)}
                    onChange={(e) => updateBoneTransformInKeyframe(selectedBoneId, "translateY", Number(e.target.value))} />
                  <span className="weight-value">{Math.round(tf.translateY)}</span>
                </div>
              </>);
            })()}
            <div className="anim-actions" style={{ marginTop: 8 }}>
              <button onClick={deleteKeyframe} disabled={selectedTrack.length <= 1}>このキーフレームを削除</button>
            </div>
          </div>
        )}
        {selectedBoneId && !currentKf && (
          <div className="bone-list"><div className="anim-actions">
            <button onClick={() => addKeyframeAt(currentTime, selectedBoneId)}>{currentTime.toFixed(2)}s にキーフレーム追加</button>
          </div></div>
        )}
        {!selectedBoneId && (
          <div className="bone-list"><div className="panel-empty">ボーンを選択してください</div></div>
        )}
      </div>
    );
  })();

  const hasAnyMesh = layers.some(l => l.mesh);
  const hasAnyWeights = layers.some(l => l.weights.length > 0);

  return (
    <div className="app" onKeyDown={handleKeyDown} tabIndex={0}>
      <header><h1>EasyMesh</h1></header>

      {layers.length === 0 ? (
        <div className="dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
          <div className="dropzone-content">
            <span className="dropzone-icon">+</span>
            <p>PNG画像をここにドロップ（複数可）</p>
          </div>
        </div>
      ) : (
        <div className="workspace">
          <div className="mode-tabs">
            <button className={appMode === "mesh" ? "active" : ""} onClick={() => setAppMode("mesh")}>メッシュ</button>
            <button className={appMode === "boneCreate" ? "active" : ""} onClick={() => setAppMode("boneCreate")} disabled={!hasAnyMesh}>ボーン作成</button>
            <button className={appMode === "boneBind" ? "active" : ""} onClick={() => {
              setAppMode("boneBind");
              // Auto-bind all layers that have mesh but no weights
              if (bones.length > 1) {
                setLayers(prev => prev.map(l => {
                  if (l.mesh && l.weights.length === 0) {
                    return { ...l, weights: autoBind(l.mesh.points, bones, l.attachBoneId) };
                  }
                  return l;
                }));
                bumpRev();
              }
            }} disabled={!hasAnyMesh || bones.length === 0}>ボーンバインド</button>
            <button className={appMode === "animate" ? "active" : ""} onClick={() => {
              setAppMode("animate");
              if (!clip) initAnimation();
            }} disabled={!hasAnyMesh || bones.length === 0 || !hasAnyWeights}>アニメーション</button>
          </div>

          <div className="toolbar">
            {appMode === "mesh" && (<>
              <label>密度:
                <input type="range" min={10} max={80} value={meshDensity} onChange={(e) => handleDensityChange(Number(e.target.value))} />
                <span>{meshDensity}px</span>
              </label>
              <select value={contourMode} onChange={(e) => handleContourModeChange(e.target.value as "concave" | "convex")}>
                <option value="concave">輪郭追従</option><option value="convex">凸包</option>
              </select>
            </>)}
            {appMode === "boneCreate" && (<>
              <span className="toolbar-hint">
                {selectedLayerId ? `ローカルボーン追加中 (${selectedLayer?.name})` : "グローバルボーン追加中"}
                {" — レイヤ未選択でグローバル、選択中はローカル"}
              </span>
              <button onClick={() => { setBones([]); setSelectedBoneId(null); setLayers(prev => prev.map(l => ({ ...l, weights: [] }))); }}>全ボーン削除</button>
            </>)}
            {appMode === "boneBind" && (<>
              <div className="bind-tools">
                <button className={bindTool === "paint" ? "active" : ""} onClick={() => setBindTool("paint")}>ペイント</button>
                <button className={bindTool === "select" ? "active" : ""} onClick={() => setBindTool("select")}>選択</button>
              </div>
              {bindTool === "paint" && (<>
                <label>半径:<input type="range" min={5} max={100} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.target.value))} /><span>{brushRadius}px</span></label>
                <label>強度:<input type="range" min={0.01} max={1} step={0.01} value={brushStrength} onChange={(e) => setBrushStrength(Number(e.target.value))} /><span>{brushStrength.toFixed(2)}</span></label>
              </>)}
              <select value={selectedBoneId ?? ""} onChange={(e) => setSelectedBoneId(e.target.value || null)}>
                <option value="">ボーン選択...</option>
                {bones.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </>)}
            {appMode === "animate" && clip && (<>
              <button onClick={() => setIsPlaying(p => !p)}>{isPlaying ? "⏸ 停止" : "▶ 再生"}</button>
              <span className="toolbar-hint">{currentTime.toFixed(2)}s / {clip.duration.toFixed(1)}s</span>
              <label>時間長:<input type="range" min={0.5} max={10} step={0.5} value={clip.duration}
                onChange={(e) => setClip(prev => prev ? { ...prev, duration: Number(e.target.value) } : prev)} /><span>{clip.duration.toFixed(1)}s</span></label>
              <button onClick={() => {
                setClip(prev => {
                  if (!prev) return prev;
                  const newTracks = { ...prev.tracks };
                  for (const [boneId, track] of Object.entries(newTracks)) {
                    const first = track.find(kf => kf.time === 0);
                    if (!first) continue;
                    const existing = track.findIndex(kf => Math.abs(kf.time - prev.duration) < 0.01);
                    const copied = { time: prev.duration, transform: { ...first.transform } };
                    if (existing >= 0) newTracks[boneId] = track.map((kf, i) => i === existing ? copied : kf);
                    else newTracks[boneId] = [...track, copied].sort((a, b) => a.time - b.time);
                  }
                  return { ...prev, tracks: newTracks };
                }); bumpRev();
              }}>ループ用コピー</button>
            </>)}
            <label><input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} />画像</label>
            <label><input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />メッシュ線</label>
            <label><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />頂点</label>
            {processing && <span className="processing">処理中...</span>}
            <button onClick={() => { setLayers([]); setBones([]); setSelectedLayerId(null); setSelectedVertices(new Set()); setClip(null); imageCache.current.clear(); }}>リセット</button>
          </div>

          <div className="main-area">
            {/* Layer panel (left) */}
            <div className="layer-panel">
              <div className="panel-title">レイヤ</div>
              {layers.slice().sort((a, b) => b.zOrder - a.zOrder).map(layer => (
                <div key={layer.id} className={`layer-item ${layer.id === selectedLayerId ? "selected" : ""}`}
                  onClick={() => setSelectedLayerId(layer.id)}>
                  <span className="layer-vis" onClick={(e) => { e.stopPropagation(); setLayers(prev => prev.map(l => l.id === layer.id ? { ...l, visible: !l.visible } : l)); bumpRev(); }}>
                    {layer.visible ? "👁" : "－"}
                  </span>
                  <span className="layer-name">{layer.name}</span>
                  {(appMode === "boneCreate" || appMode === "boneBind") && (
                    <select className="layer-attach" value={layer.attachBoneId ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { const v = e.target.value || null; setLayers(prev => prev.map(l => l.id === layer.id ? { ...l, attachBoneId: v } : l)); }}>
                      <option value="">なし</option>
                      {bones.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  )}
                </div>
              ))}
              <div className="layer-drop" onDrop={handleDrop} onDragOver={handleDragOver}>+ 画像追加</div>
            </div>

            <div className="canvas-container" onDrop={handleDrop} onDragOver={handleDragOver}>
              <canvas ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                style={{ cursor: appMode === "boneCreate" ? "crosshair" : appMode === "boneBind" && bindTool === "paint" ? "cell" : appMode === "animate" ? "pointer" : "default" }} />
            </div>

            {(appMode === "boneCreate" || appMode === "boneBind") && (
              <div className="side-panel">
                <div className="bone-list">
                  <div className="panel-title">ツリー</div>
                  <BoneTree
                    bones={bones}
                    layers={layers}
                    selectedBoneId={selectedBoneId}
                    selectedLayerId={selectedLayerId}
                    onSelectBone={setSelectedBoneId}
                    onSelectLayer={setSelectedLayerId}
                    onMoveBone={handleMoveBone}
                    onMoveLayer={handleMoveLayer}
                  />
                </div>
                {weightEditorRows}
              </div>
            )}
            {appMode === "animate" && animEditorPanel}
          </div>

          {/* Timeline */}
          {appMode === "animate" && clip && (
            <div className="timeline">
              <div className="timeline-row">
                <div className="timeline-label timeline-ruler-label">時間</div>
                <div className="timeline-track timeline-ruler"
                  onMouseDown={(e) => {
                    const track = e.currentTarget;
                    const scrub = (ev: MouseEvent) => {
                      const rect = track.getBoundingClientRect();
                      setCurrentTime(Math.max(0, Math.min(clip.duration, ((ev.clientX - rect.left) / rect.width) * clip.duration)));
                    };
                    scrub(e.nativeEvent); setIsPlaying(false); setAddKfMarker(null);
                    const onMove = (ev: MouseEvent) => scrub(ev);
                    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
                  }}>
                  <div className="timeline-playhead" style={{ left: `${(currentTime / clip.duration) * 100}%` }} />
                  {Array.from({ length: Math.floor(clip.duration / 0.5) + 1 }, (_, i) => {
                    const t = i * 0.5;
                    return <div key={i} className="timeline-tick" style={{ left: `${(t / clip.duration) * 100}%` }}><span className="timeline-tick-label">{t.toFixed(1)}</span></div>;
                  })}
                </div>
              </div>
              {bones.map(bone => (
                <div key={bone.id} className={`timeline-row ${bone.id === selectedBoneId ? "selected" : ""}`}>
                  <div className="timeline-label" onClick={() => setSelectedBoneId(bone.id)}>{bone.name}</div>
                  <div className="timeline-track"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const clickedTime = Math.max(0, Math.min(clip.duration, ((e.clientX - rect.left) / rect.width) * clip.duration));
                      const pct = (clickedTime / clip.duration) * 100;
                      const track = clip.tracks[bone.id] ?? [];
                      const nearKf = track.findIndex(kf => Math.abs((kf.time / clip.duration) - (clickedTime / clip.duration)) < 0.02);
                      if (nearKf >= 0) {
                        setSelectedKfIdx(nearKf); setCurrentTime(track[nearKf].time); setSelectedBoneId(bone.id); setIsPlaying(false); setAddKfMarker(null);
                      } else {
                        setSelectedBoneId(bone.id); setSelectedKfIdx(null); setCurrentTime(clickedTime); setIsPlaying(false);
                        setAddKfMarker({ boneId: bone.id, time: clickedTime, pct });
                      }
                    }}>
                    <div className="timeline-playhead" style={{ left: `${(currentTime / clip.duration) * 100}%` }} />
                    {(clip.tracks[bone.id] ?? []).map((kf, i) => {
                      const hasData = kf.transform.rotation !== 0 || kf.transform.translateX !== 0 || kf.transform.translateY !== 0;
                      const isSelected = bone.id === selectedBoneId && i === selectedKfIdx;
                      return (<div key={i} className={`timeline-kf ${isSelected ? "selected" : ""} ${hasData ? "has-data" : ""}`}
                        style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const isDuplicate = e.metaKey || e.ctrlKey;
                          const trackEl = e.currentTarget.parentElement!;
                          const boneId = bone.id; const startX = e.clientX; let didDrag = false;
                          setSelectedKfIdx(i); setSelectedBoneId(boneId); setIsPlaying(false); setAddKfMarker(null);
                          const onMove = (ev: MouseEvent) => {
                            if (Math.abs(ev.clientX - startX) > 3) didDrag = true;
                            if (!didDrag) return;
                            const rect = trackEl.getBoundingClientRect();
                            const newTime = Math.max(0, Math.min(clip.duration, ((ev.clientX - rect.left) / rect.width) * clip.duration));
                            setCurrentTime(newTime);
                            setClip(prev => { if (!prev) return prev; const t = prev.tracks[boneId]; if (!t) return prev; return { ...prev, tracks: { ...prev.tracks, [boneId]: t.map((k, j) => j === i ? { ...k, time: newTime } : k) } }; });
                            bumpRev();
                          };
                          const onUp = (ev: MouseEvent) => {
                            window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
                            if (!didDrag) { setCurrentTime(kf.time); return; }
                            setClip(prev => {
                              if (!prev) return prev; const t = prev.tracks[boneId]; if (!t) return prev;
                              const rect = trackEl.getBoundingClientRect();
                              const finalTime = Math.max(0, Math.min(prev.duration, ((ev.clientX - rect.left) / rect.width) * prev.duration));
                              if (isDuplicate) {
                                const copy = { time: finalTime, transform: { ...kf.transform } };
                                const nt = [...t.map((k, j) => j === i ? { ...k, time: kf.time } : k), copy].sort((a, b) => a.time - b.time);
                                setSelectedKfIdx(nt.findIndex(k => Math.abs(k.time - finalTime) < 0.001));
                                return { ...prev, tracks: { ...prev.tracks, [boneId]: nt } };
                              }
                              const sorted = [...t].sort((a, b) => a.time - b.time);
                              setSelectedKfIdx(sorted.findIndex(k => Math.abs(k.time - finalTime) < 0.001) ?? 0);
                              return { ...prev, tracks: { ...prev.tracks, [boneId]: sorted } };
                            }); bumpRev();
                          };
                          window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
                        }} />);
                    })}
                    {addKfMarker && addKfMarker.boneId === bone.id && (
                      <div className="timeline-add-btn" style={{ left: `${addKfMarker.pct}%` }}
                        onClick={(e) => { e.stopPropagation(); addKeyframeAt(addKfMarker.time, addKfMarker.boneId); setAddKfMarker(null); }}>+</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {layers.length > 0 && (
            <div className="stats">
              レイヤ: {layers.length}
              {selectedLayer?.mesh && ` / 頂点: ${selectedLayer.mesh.points.length} / 三角形: ${selectedLayer.mesh.triangles.length / 3}`}
              {bones.length > 0 && ` / ボーン: ${bones.length}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  s0: [number, number], s1: [number, number], s2: [number, number],
  d0: [number, number], d1: [number, number], d2: [number, number],
) {
  ctx.save(); ctx.beginPath();
  ctx.moveTo(d0[0], d0[1]); ctx.lineTo(d1[0], d1[1]); ctx.lineTo(d2[0], d2[1]);
  ctx.closePath(); ctx.clip();
  const [sx0, sy0] = s0, [sx1, sy1] = s1, [sx2, sy2] = s2;
  const [dx0, dy0] = d0, [dx1, dy1] = d1, [dx2, dy2] = d2;
  const det = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(det) < 1e-6) { ctx.restore(); return; }
  const inv = 1 / det;
  const a = ((dx0 * (sy1 - sy2)) + (dx1 * (sy2 - sy0)) + (dx2 * (sy0 - sy1))) * inv;
  const b = ((dx0 * (sx2 - sx1)) + (dx1 * (sx0 - sx2)) + (dx2 * (sx1 - sx0))) * inv;
  const c = ((dx0 * (sx1 * sy2 - sx2 * sy1)) + (dx1 * (sx2 * sy0 - sx0 * sy2)) + (dx2 * (sx0 * sy1 - sx1 * sy0))) * inv;
  const d = ((dy0 * (sy1 - sy2)) + (dy1 * (sy2 - sy0)) + (dy2 * (sy0 - sy1))) * inv;
  const e = ((dy0 * (sx2 - sx1)) + (dy1 * (sx0 - sx2)) + (dy2 * (sx1 - sx0))) * inv;
  const f = ((dy0 * (sx1 * sy2 - sx2 * sy1)) + (dy1 * (sx2 * sy0 - sx0 * sy2)) + (dy2 * (sx0 * sy1 - sx1 * sy0))) * inv;
  ctx.setTransform(a, d, b, e, c, f); ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.restore();
}

export default App;
