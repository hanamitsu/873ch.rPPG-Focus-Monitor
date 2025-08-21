import { useEffect, useRef, useState } from 'react';

// 額の重要なランドマーク番号（MediaPipe Face Mesh）
// 眉間から上の領域のみ（瞬き影響を避ける）
const FOREHEAD_LANDMARKS = [
  // 眉間の基準点
  9, // 眉間中央
  
  // 額中央の縦ライン（眉間から生え際まで）
  10, 151, 337, 299, 333, 298, 301,
  
  // 額の中央横幅（狭めに）
  251, 284, 332, 297, 338, // 中央
  389, 356, // 右側少し
  127, 162, // 左側少し
  
  // 眉毛の上端（これより上を使用）
  70, 63, 105, 66, 107, // 左眉上
  300, 293, 334, 296, 336 // 右眉上
];

export function useFaceMesh(videoRef, canvasRef, enabled, showMesh) {
  const [foreheadBox, setForeheadBox] = useState(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const faceMeshRef = useRef(null);
  const animationRef = useRef(null);

  useEffect(() => {
    if (!enabled || !videoRef.current || !canvasRef.current) return;

    const initFaceMesh = async () => {
      // MediaPipe Face Meshが読み込まれるまで待機
      if (!window.FaceMesh || !window.drawConnectors || !window.drawLandmarks) {
        console.log("⏳ MediaPipe Face Mesh読み込み中...");
        setTimeout(initFaceMesh, 500);
        return;
      }

      const faceMesh = new window.FaceMesh({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        }
      });

      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      faceMesh.onResults((results) => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        
        // キャンバスをクリア
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
          const landmarks = results.multiFaceLandmarks[0];
          setIsDetecting(true);
          
          // メッシュを描画（デバッグ用）
          if (showMesh) {
            // 顔のメッシュ全体を薄く描画
            ctx.globalAlpha = 0.3;
            window.drawConnectors(ctx, landmarks, window.FACEMESH_TESSELATION, 
              { color: '#C0C0C070', lineWidth: 1 });
            
            // 顔の輪郭を描画
            ctx.globalAlpha = 0.7;
            window.drawConnectors(ctx, landmarks, window.FACEMESH_FACE_OVAL, 
              { color: '#E0E0E0', lineWidth: 2 });
            
            // ランドマークポイントを描画
            ctx.globalAlpha = 0.5;
            window.drawLandmarks(ctx, landmarks, 
              { color: '#00FF00', lineWidth: 1, radius: 2 });
          }
          
          // 額の領域を計算して強調表示
          const foreheadPoints = FOREHEAD_LANDMARKS.map(i => landmarks[i]);
          
          // 額の境界ボックスを計算
          let minX = 1, maxX = 0, minY = 1, maxY = 0;
          foreheadPoints.forEach(point => {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y);
            maxY = Math.max(maxY, point.y);
          });
          
          // 眉間から上の額領域を計算
          // 眉間（9番）のポイントを基準にする
          const glabellaPoint = landmarks[9]; // 眉間
          const glabellaY = glabellaPoint.y;
          
          // 眉間から検出された最上部までの距離
          const eyebrowToTop = glabellaY - minY;
          
          // この距離を参考に少し上に延長（1.2倍）
          const extendedTop = glabellaY - (eyebrowToTop * 1.2);
          
          // 横幅を中央に絞る（額の中央部分のみ）
          const centerX = (minX + maxX) / 2;
          const originalWidth = maxX - minX;
          const narrowedWidth = originalWidth * 0.5; // 幅を50%に縮小
          
          // 最終的な領域
          minX = Math.max(0, centerX - narrowedWidth / 2);
          maxX = Math.min(1, centerX + narrowedWidth / 2);
          minY = Math.max(0, extendedTop);
          maxY = Math.min(1, glabellaY); // 眉間より下には行かない
          
          const box = {
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY
          };
          
          setForeheadBox(box);
          
          // 額の領域を緑枠で強調
          if (showMesh) {
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 3;
            ctx.strokeRect(
              box.x * canvas.width,
              box.y * canvas.height,
              box.w * canvas.width,
              box.h * canvas.height
            );
            
            // 額のランドマークを赤で強調
            ctx.fillStyle = '#FF0000';
            foreheadPoints.forEach(point => {
              ctx.beginPath();
              ctx.arc(point.x * canvas.width, point.y * canvas.height, 4, 0, 2 * Math.PI);
              ctx.fill();
            });
          }
          
        } else {
          setIsDetecting(false);
        }
        
        ctx.restore();
      });

      faceMeshRef.current = faceMesh;
      console.log("✅ MediaPipe Face Mesh初期化完了");

      // アニメーションループで検出実行
      const detect = async () => {
        if (videoRef.current && videoRef.current.readyState === 4 && faceMeshRef.current) {
          await faceMeshRef.current.send({ image: videoRef.current });
        }
        animationRef.current = requestAnimationFrame(detect);
      };
      detect();
    };

    initFaceMesh();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (faceMeshRef.current) {
        faceMeshRef.current.close();
      }
    };
  }, [enabled, videoRef, canvasRef, showMesh]);

  return { foreheadBox, isDetecting };
}