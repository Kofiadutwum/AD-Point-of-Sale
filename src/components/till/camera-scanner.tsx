'use client';
import { useEffect, useRef, useState } from 'react';

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type DetectorClass = new (opts: { formats: string[] }) => Detector;

/** Spec 11: the browser's BarcodeDetector where available, else ZXing (iPhones). Calls onCode once, then stops the camera. */
export function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let done = false;
    let stream: MediaStream | null = null;
    let controls: { stop(): void } | null = null;
    const found = (code: string) => {
      if (done) return;
      done = true;
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      onCode(code);
    };
    (async () => {
      try {
        const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
        if (Native) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          if (!video.current || done) return;
          video.current.srcObject = stream;
          await video.current.play();
          const detector = new Native({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
          while (!done) {
            const [hit] = await detector.detect(video.current).catch(() => []);
            if (hit?.rawValue) found(hit.rawValue);
            else await new Promise((r) => setTimeout(r, 250));
          }
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (!video.current || done) return;
          controls = await new BrowserMultiFormatReader().decodeFromConstraints({ video: { facingMode: 'environment' } }, video.current,
            (result) => { if (result) found(result.getText()); });
        }
      } catch {
        setError('The camera is not available. Type or scan the code instead.');
      }
    })();
    return () => {
      done = true;
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="flex flex-col gap-2 rounded border p-2">
      <video ref={video} muted playsInline className="max-h-64 w-full rounded bg-black" />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm">Close camera</button>
    </div>
  );
}
