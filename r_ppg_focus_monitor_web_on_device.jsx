import React, { useEffect, useRef, useState } from "react";

// rPPG Focus Monitor — On-device webcam heart rate & HRV (RMSSD) estimation
// Robust to camera permission issues (NotAllowedError) with environment checks & demo mode
// - getUserMedia with secure-context guard, clear guidance when blocked
// - ROI: FaceDetector API if available, else centered ROI fallback
// - Signal: RGB mean over ROI -> bandpass (0.7–3.0 Hz) with 2nd‑order IIR HP+LP
// - HR: Goertzel spectral peak; SNR as quality metric
// - HRV: Peak detection -> IBIs -> RMSSD (parasympathetic proxy)
// - UI: HR, RMSSD, Focus score, Sympa/Parasympa bars, waveform, environment checks
// - Demo mode & Self-tests included
// - All client-side. Not a medical device.

export default function HeartFocusApp() {
  const videoRef = useRef(null as HTMLVideoElement | null);
  const procCanvasRef = useRef(null as HTMLCanvasElement | null); // hidden processing canvas
  const waveCanvasRef = useRef(null as HTMLCanvasElement | null); // waveform canvas

  const [running, setRunning] = useState(false);
  const [demo, setDemo] = useState(false);
  const [status, setStatus] = useState("準備完了");
  const [lastError, setLastError] = useState<string | null>(null);

  const [hrBpm, setHrBpm] = useState<number | null>(null);
  const [rmssd, setRmssd] = useState<number | null>(null);
  const [focusScore, setFocusScore] = useState<number | null>(null);
  const [snr, setSnr] = useState<number | null>(null);

  const [roiMode, setRoiMode] = useState<"auto" | "center">("auto");
  const [mirror, setMirror] = useState(true);

  // Baselines (optional user-calibration)
  const [baselineHR, setBaselineHR] = useState<number | null>(null);
  const [baselineRMSSD, setBaselineRMSSD] = useState<number | null>(null);

  // Environment checks
  const [env, setEnv] = useState({
    secure: false,
    hasMediaDevices: false,
    faceDetector: false,
    permissionsQuery: false,
  });

  // Self-test results
  const [testResults, setTestResults] = useState<{name:string; pass:boolean; detail:string}[]>([]);

  // Internal state (buffers, filters, detector)
  const stRef = useRef({
    stream: null as MediaStream | null,
    faceDetector: null as any,
    lastTs: 0,
    fpsEMA: 30,
    // buffers
    t: [] as number[],
    gRaw: [] as number[],
    bvp: [] as number[],
    maxBufSec: 60,
    // filters (configured per-frame based on fps)
    hp: makeBiquadHP(30, 0.7),
    lp: makeBiquadLP(30, 3.0),
    // peak & IBI
    lastPeakT: -1,
    ibis: [] as number[],
    // ROI (normalized)
    roi: { x: 0.35, y: 0.2, w: 0.3, h: 0.3 },
    roiLockUntil: 0,
    frameCount: 0,
  });

  // ===== Environment probe =====
  useEffect(() => {
    const secure = (window.isSecureContext === true) || /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
    const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const faceDetector = typeof (window as any).FaceDetector !== "undefined";
    const permissionsQuery = !!(navigator as any).permissions?.query;
    setEnv({ secure, hasMediaDevices, faceDetector, permissionsQuery });
  }, []);

  async function checkCameraPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
    try {
      // @ts-ignore
      if (navigator.permissions && navigator.permissions.query) {
        // @ts-ignore
        const res = await navigator.permissions.query({ name: "camera" as any });
        return (res.state as any) || "unknown";
      }
    } catch { /* no-op */ }
    return "unknown";
  }

  // ===== Controls =====
  async function startCamera() {
    setLastError(null);
    if (!env.secure) {
      setStatus("警告: 非セキュア環境です（https または localhost で実行してください）");
      setLastError("InsecureContext");
      return;
    }
    if (!env.hasMediaDevices) {
      setStatus("このブラウザはメディアデバイスに未対応です");
      setLastError("NoMediaDevices");
      return;
    }

    const perm = await checkCameraPermission();
    if (perm === "denied") {
      setStatus("カメラが拒否されています。ブラウザ/OSの設定で許可してください");
      setLastError("PermissionDenied");
      return;
    }

    try {
      setStatus("カメラ起動中…");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: "user"
        },
        audio: false,
      });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      stRef.current.stream = stream;

      // FaceDetector init
      if (roiMode === "auto" && env.faceDetector) {
        try {
          // @ts-ignore
          stRef.current.faceDetector = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
          setStatus("顔検出: 有効 (FaceDetector)");
        } catch {
          setStatus("顔検出: 初期化失敗 → 中央ROI");
          setRoiMode("center");
        }
      } else if (roiMode === "auto") {
        setStatus("顔検出: 非対応 → 中央ROI");
        setRoiMode("center");
      } else {
        setStatus("中央ROIモード");
      }

      stRef.current.lastTs = performance.now();
      setDemo(false);
      setRunning(true);
      requestAnimationFrame(loop);
    } catch (e: any) {
      console.error(e);
      setRunning(false);
      const name = e?.name || "UnknownError";
      setLastError(name);
      if (name === "NotAllowedError") {
        setStatus("権限が拒否されました。https/localhostで再実行し、ブラウザのカメラ許可を与えてください");
      } else if (name === "NotFoundError") {
        setStatus("カメラが見つかりません。接続やOSのプライバシー設定を確認してください");
      } else if (name === "NotReadableError") {
        setStatus("別アプリがカメラを使用中の可能性があります（Zoom等を終了）");
      } else if (name === "OverconstrainedError") {
        setStatus("カメラ制約が厳しすぎます。解像度/フレームレート設定を下げて再試行してください");
      } else {
        setStatus("カメラ起動に失敗しました: " + name);
      }
    }
  }

  function startDemo() {
    stop();
    setDemo(true);
    setStatus("デモモード: 擬似信号で推定中（カメラ不要）");
    stRef.current.lastTs = performance.now();
    setRunning(true);
    requestAnimationFrame(loop);
  }

  function stop() {
    const st = stRef.current;
    if (st.stream) {
      st.stream.getTracks().forEach((tr: MediaStreamTrack) => tr.stop());
      st.stream = null;
    }
    setRunning(false);
  }

  function calibrateBaseline() {
    if (hrBpm && rmssd) {
      setBaselineHR(hrBpm);
      setBaselineRMSSD(rmssd);
    }
  }

  // ===== Main loop =====
  const loop = () => {
    const st = stRef.current;
    if (!running) return;

    const now = performance.now();
    const dt = (now - st.lastTs) / 1000;
    st.lastTs = now;

    // fps EMA
    const instFps = 1 / Math.max(dt, 1 / 120);
    st.fpsEMA = st.fpsEMA * 0.9 + instFps * 0.1;
    const fs = Math.max(10, Math.min(90, Math.round(st.fpsEMA)));
    st.hp = makeBiquadHP(fs, 0.7);
    st.lp = makeBiquadLP(fs, 3.0);

    // Sample input (camera or demo)
    if (demo) {
      // Synthetic rPPG-like signal: HR ~72 bpm (1.2Hz) + RSA 0.25Hz + noise
      const tSec = now / 1000;
      const base = 128;
      const sig = 8 * Math.sin(2 * Math.PI * 1.2 * tSec) + 3 * Math.sin(2 * Math.PI * 0.25 * tSec) + (Math.random() - 0.5) * 2.0;
      const gMean = base + sig;
      pushSample(tSec, gMean, fs);
    } else {
      const v = videoRef.current;
      const c = procCanvasRef.current!;
      if (!v || !v.videoWidth || !c) {
        requestAnimationFrame(loop);
        return;
      }
      // Update ROI occasionally via FaceDetector
      st.frameCount++;
      if (st.faceDetector && roiMode === "auto" && now > st.roiLockUntil && st.frameCount % 10 === 0) {
        detectFace(v, st.faceDetector).then((roiNorm) => {
          if (roiNorm) {
            const { x, y, w, h } = roiNorm;
            const rx = x + w * 0.2;
            const ry = y + h * 0.18;
            const rw = w * 0.6;
            const rh = h * 0.30;
            st.roi = { x: clamp(rx, 0, 1 - rw), y: clamp(ry, 0, 1 - rh), w: rw, h: rh };
            st.roiLockUntil = now + 1500;
          }
        }).catch(()=>{});
      }

      const vw = v.videoWidth, vh = v.videoHeight;
      const roi = st.roi;
      const rx = roiMode === "center" ? 0.35 : roi.x;
      const ry = roiMode === "center" ? 0.2 : roi.y;
      const rw = roiMode === "center" ? 0.3 : roi.w;
      const rh = roiMode === "center" ? 0.3 : roi.h;

      c.width = Math.max(160, Math.floor(vw * rw));
      c.height = Math.max(120, Math.floor(vh * rh));
      const cx = c.getContext("2d", { willReadFrequently: true })!;

      // Draw ROI crop with optional mirroring
      cx.save();
      if (mirror) { cx.translate(c.width, 0); cx.scale(-1, 1); }
      cx.drawImage(
        v,
        vw * rx, vh * ry, vw * rw, vh * rh,
        0, 0, c.width, c.height
      );
      cx.restore();

      const img = cx.getImageData(0, 0, c.width, c.height).data;
      let gSum = 0; // (we can add R/B if using CHROM/POS later)
      const step = Math.max(1, Math.floor((c.width * c.height) / 5000));
      for (let i = 0; i < img.length; i += 4 * step) {
        gSum += img[i + 1];
      }
      const n = Math.floor(img.length / (4 * step));
      const gMean = gSum / n;
      const tSec = now / 1000;
      pushSample(tSec, gMean, fs);
    }

    // Draw waveform (recent segment)
    const { segment } = getLatestSegment(st.bvp, st.t, 12);
    drawWaveform(waveCanvasRef.current, segment);

    requestAnimationFrame(loop);
  };

  function pushSample(tSec: number, gMean: number, fs: number) {
    const st = stRef.current;
    st.t.push(tSec);
    st.gRaw.push(gMean);

    // Detrend ~1s moving average
    const win = Math.max(5, Math.floor(1.0 * fs));
    const detr = gMean - movingAverageTail(st.gRaw, win);
    const y1 = st.hp.step(detr);
    const y2 = st.lp.step(y1);
    st.bvp.push(y2);

    trimBuffers(st);

    // HR via Goertzel on last 12s
    const { segment, fsUsed } = getLatestSegment(st.bvp, st.t, 12);
    if (segment.length > fsUsed * 4) {
      const band: [number, number] = [0.7, 3.0];
      const spec = goertzelSpectrum(segment, fsUsed, band, 120);
      const k = argmax(spec.powers);
      const fPeak = spec.freqs[k];
      const hr = fPeak * 60;
      const med = median(spec.powers);
      const q = med > 0 ? spec.powers[k] / med : null;
      setHrBpm(isFinite(hr) ? Math.round(hr) : null);
      setSnr(q ? Math.round(q * 10) / 10 : null);
    }

    // Peak→IBI→RMSSD
    const newIBI = detectPeakAndIBI(st, fs);
    if (newIBI) {
      st.ibis.push(newIBI);
      if (st.ibis.length > 20) st.ibis.shift();
      const rm = computeRMSSD(st.ibis);
      if (isFinite(rm)) setRmssd(Math.round(rm));
      // Focus score (trial): HR↑ & RMSSD↓ ⇒ score↑ (vs baseline)
      const hrBase = baselineHR ?? 70;
      const rmBase = baselineRMSSD ?? 40;
      const hrZ = hrBpm ? (hrBpm - hrBase) / Math.max(5, 0.1 * hrBase) : 0;
      const rmZ = rm ? (rmBase - rm) / Math.max(10, 0.25 * rmBase) : 0;
      const score = Math.max(0, Math.min(100, Math.round(50 + 20 * hrZ + 30 * rmZ)));
      setFocusScore(score);
    }
  }

  // ===== Self tests =====
  function runSelfTests() {
    const results: {name:string; pass:boolean; detail:string}[] = [];

    // HR spectral test at ~72 bpm
    const fs = 30, dur = 12;
    const N = fs * dur;
    const x: number[] = [];
    for (let n = 0; n < N; n++) {
      const t = n / fs;
      x.push(8 * Math.sin(2 * Math.PI * 1.2 * t) + (Math.random() - 0.5) * 1.5);
    }
    const spec = goertzelSpectrum(x, fs, [0.7, 3.0], 120);
    const f = spec.freqs[argmax(spec.powers)];
    const hr = f * 60;
    const passHR = Math.abs(hr - 72) <= 3;
    results.push({ name: "HR推定(72bpm)", pass: passHR, detail: `got ${hr.toFixed(1)} bpm` });

    // RMSSD test with known IBIs
    const ibis = [1.0, 1.0, 1.0, 1.04, 0.96];
    const rm = computeRMSSD(ibis);
    // manual RMSSD ≈ sqrt(mean([0,0,40,-40]^2)) ≈ sqrt(mean([0,0,1600,1600])) = sqrt(800) ≈ 28.3ms
    const passRM = Math.abs(rm - 28.3) <= 5;
    results.push({ name: "RMSSD推定", pass: passRM, detail: `got ${rm.toFixed(1)} ms` });

    setTestResults(results);
  }

  // Cleanup
  useEffect(() => () => stop(), []);

  return (
    <div className="w-full min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-4">
          <h1 className="text-3xl font-bold tracking-tight">rPPG Focus Monitor</h1>
          <p className="text-sm text-slate-600">PCカメラ（またはデモ信号）でオンデバイス心拍・HRV（RMSSD）推定 → 集中度/自律神経の可視化（研究用途・参考値）</p>
        </header>

        {!env.secure && (
          <Callout type="warn" title="非セキュア環境">
            https または localhost で実行してください（ブラウザ仕様で getUserMedia がブロックされます）。
          </Callout>
        )}

        {lastError && (
          <Callout type="error" title={`エラー: ${lastError}`}>
            {status} — 設定例：
            <ul className="list-disc ml-6 mt-1">
              <li>このページを https で提供 / または localhost で開く</li>
              <li>ブラウザのサイト設定で「カメラ: 許可」</li>
              <li>他アプリ（Zoom/Meet等）がカメラ占有→終了</li>
              <li>macOS: システム設定 → プライバシーとセキュリティ → カメラ → ブラウザにチェック</li>
            </ul>
          </Callout>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Video & Controls */}
          <section className="bg-white rounded-2xl shadow p-4">
            <div className="relative">
              <video ref={videoRef} playsInline muted className={`w-full rounded-xl bg-black ${mirror ? "scale-x-[-1]" : ""}`} />
              <RoiOverlay videoRef={videoRef} roi={stRef.current.roi} roiMode={roiMode} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!running || demo ? (
                <button onClick={startCamera} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 shadow">カメラ開始</button>
              ) : (
                <button onClick={stop} className="px-4 py-2 rounded-xl bg-rose-600 text-white hover:bg-rose-700 shadow">停止</button>
              )}
              <button onClick={startDemo} className="px-3 py-2 rounded-xl border">デモモード</button>
              <label className="inline-flex items-center gap-2 text-sm ml-2">
                <input type="checkbox" checked={mirror} onChange={(e)=>setMirror(e.target.checked)} /> ミラー
              </label>
              <label className="inline-flex items-center gap-2 text-sm ml-2">
                <input type="checkbox" checked={roiMode==="auto"} onChange={(e)=>setRoiMode(e.target.checked?"auto":"center")} /> 自動ROI
              </label>
              <button onClick={calibrateBaseline} className="px-3 py-1.5 rounded-lg border text-sm">この状態をベースラインに設定</button>
              <span className="text-xs text-slate-600">{status} / 推定FPS: {Math.round(stRef.current.fpsEMA)}</span>
            </div>
            <canvas ref={procCanvasRef} className="hidden" />
          </section>

          {/* Right: Metrics & Tools */}
          <section className="bg-white rounded-2xl shadow p-4">
            <div className="grid grid-cols-2 gap-3">
              <MetricCard label="心拍数 (bpm)" value={hrBpm?.toString() ?? "—"} note="12秒窓推定" />
              <MetricCard label="RMSSD (ms)" value={rmssd?.toString() ?? "—"} note="ピーク検出ベース" />
              <MetricCard label="集中度" value={focusScore?.toString() ?? "—"} note="ベースライン相対 0–100" />
              <MetricCard label="信号品質 (SNR)" value={snr ? snr.toString() : "—"} note="> 1.5 推奨" />
            </div>
            <div className="mt-4">
              <SympaParasympaBars rmssd={rmssd} baselineRMSSD={baselineRMSSD ?? 40} />
            </div>
            <div className="mt-4">
              <h3 className="text-sm font-semibold mb-1">波形（直近12s）</h3>
              <canvas ref={waveCanvasRef} className="w-full h-28 bg-slate-100 rounded-xl" />
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-slate-700">環境チェック</summary>
              <ul className="text-sm text-slate-600 list-disc ml-5 mt-2 space-y-1">
                <li>セキュアコンテキスト: {env.secure ? "OK" : "NG (https/localhostにしてください)"}</li>
                <li>MediaDevices: {env.hasMediaDevices ? "OK" : "NG"}</li>
                <li>FaceDetector API: {env.faceDetector ? "あり" : "なし (中央ROI)"}</li>
                <li>Permissions API: {env.permissionsQuery ? "あり" : "なし"}</li>
              </ul>
            </details>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-slate-700">自己テスト（アルゴリズム妥当性）</summary>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={runSelfTests} className="px-3 py-1.5 rounded-lg border text-sm">自己テストを実行</button>
              </div>
              <ul className="text-sm mt-2 space-y-1">
                {testResults.map((r,i)=> (
                  <li key={i} className={r.pass?"text-emerald-700":"text-rose-700"}>
                    {r.pass?"PASS":"FAIL"} — {r.name} : {r.detail}
                  </li>
                ))}
              </ul>
            </details>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-slate-700">注意事項 / おすすめ環境</summary>
              <ul className="text-sm text-slate-600 list-disc ml-5 mt-2 space-y-1">
                <li>均一で十分な照明（白色系）。画面フリッカーや逆光は避けてください。</li>
                <li>顔を中央・正面に保ち、なるべく静止。メガネや強い反射は避ける。</li>
                <li>RMSSD/集中度は1分以上の連続計測で安定。</li>
                <li>本アプリは医療機器ではありません。診断目的には使用しないでください。</li>
              </ul>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricCard({label, value, note}:{label:string; value:string; note?:string}){
  return (
    <div className="p-3 rounded-xl border border-slate-200">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {note && <div className="text-xs text-slate-400">{note}</div>}
    </div>
  );
}

function SympaParasympaBars({ rmssd, baselineRMSSD }:{ rmssd: number | null, baselineRMSSD: number }){
  const rm = rmssd ?? baselineRMSSD;
  const p = clamp01(rm / (baselineRMSSD * 1.6));
  const paras = Math.round(p * 100);
  const sympa = 100 - paras;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <div className="text-xs text-slate-500 mb-1">副交感（推定）</div>
        <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${paras}%` }} />
        </div>
        <div className="text-xs text-slate-500 mt-1">{paras}%</div>
      </div>
      <div>
        <div className="text-xs text-slate-500 mb-1">交感（推定）</div>
        <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-full bg-rose-500" style={{ width: `${sympa}%` }} />
        </div>
        <div className="text-xs text-slate-500 mt-1">{sympa}%</div>
      </div>
    </div>
  );
}

function RoiOverlay({ videoRef, roi, roiMode }:{ videoRef: React.RefObject<HTMLVideoElement>, roi:{x:number;y:number;w:number;h:number}, roiMode:"auto"|"center" }){
  const [box, setBox] = useState({ left:0, top:0, width:0, height:0 });
  useEffect(()=>{
    const int = setInterval(()=>{
      const v = videoRef.current;
      if (!v) return;
      const rect = v.getBoundingClientRect();
      setBox({
        left: rect.left + rect.width * (roiMode==="center"?0.35:roi.x),
        top: rect.top + rect.height * (roiMode==="center"?0.2:roi.y),
        width: rect.width * (roiMode==="center"?0.3:roi.w),
        height: rect.height * (roiMode==="center"?0.3:roi.h),
      });
    }, 100);
    return ()=>clearInterval(int);
  }, [videoRef, roi, roiMode]);
  return (
    <div style={{ position: 'absolute', pointerEvents: 'none', left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="w-full h-full rounded-xl border-2 border-emerald-400/80" />
    </div>
  );
}

// ===== Processing helpers =====
function movingAverageTail(arr: number[], win: number) {
  if (arr.length === 0) return 0;
  const n = Math.min(win, arr.length);
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function getLatestSegment(sig: number[], t: number[], windowSec: number) {
  if (sig.length === 0 || t.length === 0) return { segment: [], fsUsed: 30 };
  const tmax = t[t.length - 1];
  let i0 = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] < tmax - windowSec) { i0 = i + 1; break; }
  }
  const segment = sig.slice(i0);
  const dt = (t[t.length - 1] - t[i0]) / Math.max(1, (t.length - 1 - i0));
  const fsUsed = dt > 0 ? Math.min(90, Math.max(10, 1 / dt)) : 30;
  return { segment, fsUsed };
}

function goertzelSpectrum(x: number[], fs: number, band: [number, number], bins = 120) {
  const [f0, f1] = band;
  const freqs: number[] = [];
  const powers: number[] = [];
  for (let i = 0; i < bins; i++) {
    const f = f0 + (f1 - f0) * (i / (bins - 1));
    const w = 2 * Math.PI * f / fs;
    let s_prev = 0, s_prev2 = 0;
    const coeff = 2 * Math.cos(w);
    for (let n = 0; n < x.length; n++) {
      const s = x[n] + coeff * s_prev - s_prev2;
      s_prev2 = s_prev;
      s_prev = s;
    }
    const real = s_prev - s_prev2 * Math.cos(w);
    const imag = s_prev2 * Math.sin(w);
    const power = real * real + imag * imag;
    freqs.push(f);
    powers.push(power);
  }
  return { freqs, powers };
}

function argmax(a: number[]) { let m = 0; for (let i=1;i<a.length;i++) if (a[i] > a[m]) m=i; return m; }
function median(a: number[]) { const b=[...a].sort((x,y)=>x-y); const n=b.length; return n? (n%2? b[(n-1)/2] : 0.5*(b[n/2-1]+b[n/2])):0; }
function clamp(v:number,min:number,max:number){ return Math.max(min, Math.min(max,v)); }
function clamp01(v:number){ return clamp(v, 0, 1); }

// Peak detection with refractory period & adaptive threshold
function detectPeakAndIBI(st: any, fs: number): number | null {
  const N = st.bvp.length;
  if (N < 5) return null;
  const t = st.t;
  const y = st.bvp;
  const winS = Math.min(5, st.maxBufSec);
  let i0 = N - Math.floor(winS * fs);
  if (i0 < 0) i0 = 0;
  const seg = y.slice(i0);
  const mean = seg.reduce((s:number,v:number)=>s+v,0)/seg.length;
  const sd = Math.sqrt(seg.reduce((s:number,v:number)=>s+(v-mean)*(v-mean),0)/Math.max(1,seg.length-1));
  const thr = mean + 0.6 * sd;

  const i = N - 2; // previous sample as candidate peak
  if (y[i] > thr && y[i] > y[i-1] && y[i] > y[i+1]) {
    const tPeak = t[i];
    if (st.lastPeakT < 0 || (tPeak - st.lastPeakT) > 0.33) { // > 180 bpm refractory
      let ibi: number | null = null;
      if (st.lastPeakT > 0) ibi = tPeak - st.lastPeakT;
      st.lastPeakT = tPeak;
      return ibi; // seconds
    }
  }
  return null;
}

// RMSSD (ms)
function computeRMSSD(ibisSec: number[]): number {
  if (ibisSec.length < 3) return NaN;
  const rrMs = ibisSec.map(s=>s*1000);
  const diffs: number[] = [];
  for (let i=1;i<rrMs.length;i++) diffs.push(rrMs[i]-rrMs[i-1]);
  const sq = diffs.map(d=>d*d);
  const mean = sq.reduce((s,v)=>s+v,0)/sq.length;
  return Math.sqrt(mean);
}

// Trim buffers by time window
function trimBuffers(st: any) {
  const { t, gRaw, bvp, maxBufSec } = st;
  if (t.length === 0) return;
  const tmax = t[t.length - 1];
  const cutoff = tmax - maxBufSec;
  while (t.length && t[0] < cutoff) { t.shift(); gRaw.shift(); bvp.shift(); }
  while (st.ibis.length > 0 && (t.length > 1) ) {
    const span = t[t.length - 1] - t[0];
    if (span <= maxBufSec) break;
    st.ibis.shift();
  }
}

// Face detection helper
async function detectFace(video: HTMLVideoElement, faceDetector: any): Promise<{x:number;y:number;w:number;h:number}|null> {
  try {
    const faces = await faceDetector.detect(video);
    if (faces && faces.length > 0) {
      const b = faces[0].boundingBox as DOMRect;
      const w = video.videoWidth;
      const h = video.videoHeight;
      return { x: b.x / w, y: b.y / h, w: b.width / w, h: b.height / h };
    }
  } catch {}
  return null;
}

// IIR biquads (RBJ cookbook)
function makeBiquadLP(fs: number, fc: number) {
  const Q = Math.SQRT1_2; return biquad(fs, fc, Q, 'lp');
}
function makeBiquadHP(fs: number, fc: number) {
  const Q = Math.SQRT1_2; return biquad(fs, fc, Q, 'hp');
}
function biquad(fs:number, fc:number, Q:number, type:'lp'|'hp'){
  const w0 = 2*Math.PI*fc/fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0/(2*Q);
  let b0=0,b1=0,b2=0,a0=1,a1=0,a2=0;
  if (type==='lp'){
    b0 = (1 - cosw0)/2; b1 = 1 - cosw0; b2 = (1 - cosw0)/2;
    a0 = 1 + alpha; a1 = -2*cosw0; a2 = 1 - alpha;
  } else {
    b0 = (1 + cosw0)/2; b1 = -(1 + cosw0); b2 = (1 + cosw0)/2;
    a0 = 1 + alpha; a1 = -2*cosw0; a2 = 1 - alpha;
  }
  const bz0=b0/a0, bz1=b1/a0, bz2=b2/a0, az1=a1/a0, az2=a2/a0;
  let x1=0,x2=0,y1=0,y2=0;
  return { step(x:number){ const y = bz0*x + bz1*x1 + bz2*x2 - az1*y1 - az2*y2; x2=x1; x1=x; y2=y1; y1=y; return y; } };
}

function Callout({ type, title, children }:{ type:"warn"|"error"|"info"; title:string; children:any }){
  const color = type==="error"?"border-rose-300 bg-rose-50":"warn"===type?"border-amber-300 bg-amber-50":"border-sky-300 bg-sky-50";
  return (
    <div className={`border ${color} rounded-xl p-3 mb-3`}>
      <div className="font-semibold mb-1">{title}</div>
      <div className="text-sm text-slate-700">{children}</div>
    </div>
  );
}
