import { useEffect, useRef, useState } from 'react';

export function useFaceDetection(videoRef, enabled) {
  const [faceBox, setFaceBox] = useState(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!enabled || !videoRef.current) return;

    // MediaPipe Face Detectionの初期化
    const initDetector = async () => {
      if (!window.FaceDetection) {
        console.log("MediaPipe Face Detection読み込み中...");
        setTimeout(initDetector, 1000);
        return;
      }

      const faceDetection = new window.FaceDetection({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
        }
      });

      faceDetection.setOptions({
        model: 'short',
        minDetectionConfidence: 0.5
      });

      faceDetection.onResults((results) => {
        if (results.detections && results.detections.length > 0) {
          const detection = results.detections[0];
          const bb = detection.boundingBox;
          
          // 正規化された座標で額の領域を計算
          const foreheadBox = {
            x: bb.xCenter - bb.width * 0.3,
            y: bb.yCenter - bb.height * 0.45,
            w: bb.width * 0.6,
            h: bb.height * 0.2
          };
          
          setFaceBox(foreheadBox);
          console.log("👤 顔検出: 額の位置を更新", foreheadBox);
        }
      });

      detectorRef.current = faceDetection;
      console.log("✅ MediaPipe Face Detection初期化完了");

      // 定期的に検出を実行
      intervalRef.current = setInterval(async () => {
        if (videoRef.current && videoRef.current.readyState === 4) {
          await faceDetection.send({ image: videoRef.current });
        }
      }, 500); // 0.5秒ごとに検出
    };

    initDetector();

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, videoRef]);

  return faceBox;
}