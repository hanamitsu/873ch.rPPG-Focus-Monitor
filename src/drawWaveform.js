export function drawWaveform(canvas, segment) {
  if (!canvas || !segment || segment.length === 0) return;
  
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.clearRect(0, 0, width, height);
  
  // Find min and max for scaling
  let min = segment[0];
  let max = segment[0];
  for (const val of segment) {
    if (val < min) min = val;
    if (val > max) max = val;
  }
  
  const range = max - min || 1;
  
  // Draw waveform
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  for (let i = 0; i < segment.length; i++) {
    const x = (i / (segment.length - 1)) * width;
    const y = height - ((segment[i] - min) / range) * height;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  
  ctx.stroke();
}