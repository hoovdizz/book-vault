import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, ScanLine } from 'lucide-react';
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
  const completedRef = useRef(false);
  const recentDetectionsRef = useRef<Map<string, number>>(new Map());
  const [status, setStatus] = useState('');
  const [photoScanning, setPhotoScanning] = useState(false);
  const [scanned, setScanned] = useState<string[]>([]);
  const liveCameraAvailable = typeof window !== 'undefined'
    && window.isSecureContext
    && Boolean(navigator.mediaDevices?.getUserMedia);

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
    if (!continuous) controlsRef.current?.stop();
    setScanned(current => current.includes(value) ? current : [...current, value]);
    if (navigator.vibrate) navigator.vibrate(60);
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
  }, [continuous, onDetected, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    completedRef.current = false;
    recentDetectionsRef.current.clear();
    setScanned([]);
    setPhotoScanning(false);
    if (!liveCameraAvailable) {
      setStatus('Live scanning requires HTTPS. Use the photo button below on this connection.');
      return;
    }

    let disposed = false;
    setStatus('Starting the rear camera…');
    void (async () => {
      try {
        const { BarcodeFormat, BrowserMultiFormatOneDReader, BrowserMultiFormatReader } = await import('@zxing/browser');
        if (disposed || !videoRef.current) return;
        const reader = scanMode === 'location' ? new BrowserMultiFormatReader() : new BrowserMultiFormatOneDReader();
        reader.possibleFormats = [scanMode === 'location' ? BarcodeFormat.QR_CODE : BarcodeFormat.EAN_13];
        const controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          videoRef.current,
          result => {
            if (!result) return;
            const rawValue = result.getText();
            if (scanMode === 'location') {
              if (/^bookvault-location:[1-9]\d*$/.test(rawValue)) finish(rawValue);
              else setStatus('That QR code is not a Book Vault location label.');
            } else {
              const isbn = isbnFromBarcode(rawValue);
              if (isbn) finish(isbn);
              else setStatus('That barcode is not an ISBN-13. Aim at the 978 or 979 barcode.');
            }
          },
        );
        if (disposed) controls.stop();
        else {
          controlsRef.current = controls;
          setStatus(scanMode === 'location'
            ? 'Hold a Book Vault location QR code inside the frame.'
            : 'Hold the 978 or 979 barcode inside the frame.');
        }
      } catch (error) {
        if (!disposed) {
          setStatus(error instanceof Error
            ? `Live camera unavailable: ${error.message}. You can still take a barcode photo.`
            : 'Live camera unavailable. You can still take a barcode photo.');
        }
      }
    })();

    return () => {
      disposed = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [finish, open, liveCameraAvailable, scanMode]);

  async function scanPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024) {
      setStatus('Choose an image smaller than 15 MB.');
      return;
    }
    setPhotoScanning(true);
    setStatus('Reading the barcode from the photo…');
    const objectUrl = URL.createObjectURL(file);
    try {
      const { BarcodeFormat, BrowserMultiFormatOneDReader, BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader = scanMode === 'location' ? new BrowserMultiFormatReader() : new BrowserMultiFormatOneDReader();
      reader.possibleFormats = [scanMode === 'location' ? BarcodeFormat.QR_CODE : BarcodeFormat.EAN_13];
      const result = await reader.decodeFromImageUrl(objectUrl);
      const rawValue = result.getText();
      if (scanMode === 'location') {
        if (!/^bookvault-location:[1-9]\d*$/.test(rawValue)) throw new Error('The detected QR code is not a Book Vault location');
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
              : 'Aim at the barcode above the ISBN. Images stay on this device and are never uploaded.'}
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-black">
          {liveCameraAvailable ? (
            <>
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              <div className="pointer-events-none absolute inset-x-[8%] top-1/2 h-20 -translate-y-1/2 rounded border-2 border-primary shadow-[0_0_0_999px_rgba(0,0,0,0.28)]" />
            </>
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-white/70">
              <div><Camera className="mx-auto mb-2 h-9 w-9" />Live camera needs HTTPS</div>
            </div>
          )}
        </div>

        <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">{status}</p>
        {continuous && scanned.length > 0 && (
          <div className="max-h-28 overflow-y-auto rounded-md border border-border p-2 text-sm" aria-label="Scanned ISBN queue">
            {scanned.map((value, index) => <p key={value}>{index + 1}. {value}</p>)}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{continuous && scanned.length ? 'Done' : 'Cancel'}</Button>
          <Button type="button" disabled={photoScanning} onClick={() => fileInputRef.current?.click()}>
            {photoScanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
            Take or choose barcode photo
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
