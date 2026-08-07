import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, ScanLine, Square } from 'lucide-react';
import { isbnFromBarcode } from '@/lib/isbn';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type ScannerControls = { stop: () => void };
type CameraState = 'idle' | 'starting' | 'active' | 'unavailable';

export default function IsbnScannerDialog({
  open,
  onOpenChange,
  onDetected,
  continuous = false,
  scanMode = 'isbn',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (isbn: string) => void;
  continuous?: boolean;
  scanMode?: 'isbn' | 'location';
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraGenerationRef = useRef(0);
  const completedRef = useRef(false);
  const recentDetectionsRef = useRef<Map<string, number>>(new Map());
  const [status, setStatus] = useState('');
  const [photoScanning, setPhotoScanning] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [scanned, setScanned] = useState<string[]>([]);
  const liveCameraAvailable = typeof window !== 'undefined'
    && window.isSecureContext
    && Boolean(navigator.mediaDevices?.getUserMedia);

  const releaseCamera = useCallback(() => {
    try {
      controlsRef.current?.stop();
    } catch {
      // A browser may already have ended the stream while closing the dialog.
    }
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const finish = useCallback((value: string) => {
    const now = Date.now();
    const previous = recentDetectionsRef.current.get(value) || 0;
    if (now - previous < 2000) {
      setStatus(`${value} was already scanned. Keep moving through the batch.`);
      return;
    }
    recentDetectionsRef.current.set(value, now);
    if (!continuous && completedRef.current) return;
    completedRef.current = !continuous;
    if (!continuous) releaseCamera();
    setScanned(current => current.includes(value) ? current : [...current, value]);
    if (navigator.vibrate) navigator.vibrate(60);
    try {
      const AudioContextClass = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audio = new AudioContextClass();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = 880;
        gain.gain.value = 0.04;
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.08);
      }
    } catch {
      // Haptic and audible feedback are best-effort browser enhancements.
    }
    onDetected(value);
    if (continuous) setStatus(`Added ${value}. Scan the next book without closing this window.`);
    else onOpenChange(false);
  }, [continuous, onDetected, onOpenChange, releaseCamera]);

  const startCamera = useCallback(async () => {
    if (!liveCameraAvailable) {
      setCameraState('unavailable');
      setStatus(window.isSecureContext
        ? 'This browser does not provide live camera access. Use the photo fallback below.'
        : 'Live camera access requires HTTPS. Check the reverse-proxy address and settings.');
      return;
    }

    const generation = ++cameraGenerationRef.current;
    releaseCamera();
    setCameraState('starting');
    setStatus('Requesting permission for the rear camera…');
    try {
      // Request the stream directly while handling the user's button press. This
      // reliably triggers Safari and Chromium's site permission prompt.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (generation !== cameraGenerationRef.current || !videoRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;

      const { BarcodeFormat, BrowserMultiFormatReader } = await import('@zxing/browser');
      if (generation !== cameraGenerationRef.current || !videoRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const reader = new BrowserMultiFormatReader();
      reader.possibleFormats = scanMode === 'location'
        ? [BarcodeFormat.QR_CODE]
        : [BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128, BarcodeFormat.ITF, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED];
      const controls = await reader.decodeFromStream(stream, videoRef.current, result => {
        if (!result) return;
        const rawValue = result.getText();
        if (scanMode === 'location') {
          if (/^bookvault-location:[1-9]\d*$/.test(rawValue)) finish(rawValue);
          else setStatus('That QR code is not a Book Vault location label.');
          return;
        }
        const isbn = isbnFromBarcode(rawValue);
        if (isbn) finish(isbn);
        else setStatus('That barcode is not an ISBN-13. Aim at the 978 or 979 barcode.');
      });
      if (generation !== cameraGenerationRef.current) {
        controls.stop();
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      controlsRef.current = controls;
      setCameraState('active');
      setStatus(scanMode === 'location'
        ? 'Camera is live. Hold a Book Vault location QR code inside the frame.'
        : 'Camera is live. Hold the 978 or 979 barcode inside the frame.');
    } catch (error) {
      releaseCamera();
      if (generation !== cameraGenerationRef.current) return;
      setCameraState('unavailable');
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError') {
        setStatus('Camera permission was denied. Allow camera access for this Book Vault site, then try again.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('No usable rear camera was found. Try the photo fallback below.');
      } else {
        setStatus(error instanceof Error
          ? `Live camera could not start: ${error.message}. Try the photo fallback below.`
          : 'Live camera could not start. Try the photo fallback below.');
      }
    }
  }, [finish, liveCameraAvailable, releaseCamera, scanMode]);

  useEffect(() => {
    if (!open) return;
    completedRef.current = false;
    recentDetectionsRef.current.clear();
    setScanned([]);
    setPhotoScanning(false);
    setCameraState(liveCameraAvailable ? 'idle' : 'unavailable');
    setStatus(liveCameraAvailable
      ? 'Tap “Start live camera” to grant camera access and begin scanning.'
      : window.isSecureContext
      ? 'This browser does not provide live camera access. Use the photo fallback below.'
      : 'Live scanning requires HTTPS. Check the reverse-proxy address and settings.');

    return () => {
      cameraGenerationRef.current += 1;
      releaseCamera();
    };
  }, [open, liveCameraAvailable, releaseCamera]);

  async function scanPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024) {
      setStatus('Choose an image smaller than 15 MB.');
      return;
    }
    releaseCamera();
    setCameraState(liveCameraAvailable ? 'idle' : 'unavailable');
    setPhotoScanning(true);
    setStatus('Reading the barcode from the photo…');
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The browser could not open that image'));
      });
      image.src = objectUrl;
      await loaded;
      const { BarcodeFormat, BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader = new BrowserMultiFormatReader();
      reader.possibleFormats = scanMode === 'location'
        ? [BarcodeFormat.QR_CODE]
        : [BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128, BarcodeFormat.ITF, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED];
      const result = await reader.decodeFromImageElement(image);
      const rawValue = result.getText();
      if (scanMode === 'location') {
        if (!/^bookvault-location:[1-9]\d*$/.test(rawValue)) {
          throw new Error('The detected QR code is not a Book Vault location');
        }
        finish(rawValue);
      } else {
        const isbn = isbnFromBarcode(rawValue);
        if (!isbn) throw new Error('The detected barcode is not an ISBN-13');
        finish(isbn);
      }
    } catch (error) {
      setStatus(error instanceof Error
        ? `${error.message}. Retake the photo with the barcode sharp and filling most of the frame.`
        : 'No ISBN barcode was found. Retake the photo closer to the barcode.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setPhotoScanning(false);
    }
  }

  function stopCamera() {
    cameraGenerationRef.current += 1;
    releaseCamera();
    setCameraState('idle');
    setStatus('Live camera stopped. Start it again or use the photo fallback.');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ScanLine className="h-5 w-5" />{scanMode === 'location' ? 'Scan location' : 'Scan ISBN'}</DialogTitle>
          <DialogDescription>
            {scanMode === 'location'
              ? 'Scan a QR label created in Settings. The selected destination will be applied to every saved physical copy in this batch.'
              : continuous
              ? 'Scan continuously into a review queue. Duplicate scans are called out instead of silently rejected.'
              : 'Use the live rear camera to scan the red-line barcode above the ISBN. Align the full 978 or 979 barcode inside the frame; camera images stay on this device.'}
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-black">
          {liveCameraAvailable ? (
            <>
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              {cameraState === 'active' && (
                <div
                  className="pointer-events-none absolute inset-x-[7%] top-1/2 h-24 -translate-y-1/2 rounded border-2 border-white/90 shadow-[0_0_0_999px_rgba(0,0,0,0.34)]"
                  aria-hidden="true"
                >
                  <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.9)]" />
                  <span className="absolute -left-0.5 -top-0.5 h-5 w-5 border-l-4 border-t-4 border-red-500" />
                  <span className="absolute -right-0.5 -top-0.5 h-5 w-5 border-r-4 border-t-4 border-red-500" />
                  <span className="absolute -bottom-0.5 -left-0.5 h-5 w-5 border-b-4 border-l-4 border-red-500" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-5 w-5 border-b-4 border-r-4 border-red-500" />
                </div>
              )}
              {cameraState !== 'active' && (
                <div className="absolute inset-0 grid place-items-center bg-black/55 text-center text-sm text-white/80">
                  {cameraState === 'starting'
                    ? <div><Loader2 className="mx-auto mb-2 h-9 w-9 animate-spin" />Waiting for camera permission</div>
                    : <div><Camera className="mx-auto mb-2 h-9 w-9" />Live camera is off</div>}
                </div>
              )}
            </>
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-white/70">
              <div><Camera className="mx-auto mb-2 h-9 w-9" />Live camera needs HTTPS and browser permission</div>
            </div>
          )}
        </div>

        <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">{status}</p>
        {continuous && scanned.length > 0 && (
          <div className="max-h-28 overflow-y-auto rounded-md border border-border p-2 text-sm" aria-label="Scanned ISBN queue">
            {scanned.map((value, index) => <p key={value}>{index + 1}. {value}</p>)}
          </div>
        )}

        <DialogFooter className="gap-2 sm:flex-wrap sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{continuous && scanned.length ? 'Done' : 'Cancel'}</Button>
          {liveCameraAvailable && cameraState === 'active' ? (
            <Button type="button" variant="outline" onClick={stopCamera}>
              <Square className="mr-2 h-4 w-4" />Stop camera
            </Button>
          ) : (
            <Button type="button" disabled={cameraState === 'starting' || photoScanning} onClick={() => void startCamera()}>
              {cameraState === 'starting' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
              Start live camera
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={photoScanning}
            onClick={() => {
              cameraGenerationRef.current += 1;
              releaseCamera();
              fileInputRef.current?.click();
            }}
          >
            {photoScanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
            Scan a photo
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={scanPhoto}
            disabled={photoScanning}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
