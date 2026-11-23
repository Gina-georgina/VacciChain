import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

function getFocusableElements(root) {
  if (!root) return [];
  const selectors = 'a[href],button:not([disabled]),textarea, input, select, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selectors)).filter((el) => el.offsetParent !== null);
}

export default function QRCodeModal({ url, onClose }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const modalRef = useRef(null);
  const previousActive = useRef(null);
  const urlInputRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState('idle');
  const copyResetTimer = useRef(null);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const handleCopy = async () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(url);
      setCopyStatus('success');
    } catch (err) {
      // Fallback: select the text so the user can copy manually.
      try {
        urlInputRef.current?.focus?.();
        urlInputRef.current?.select?.();
      } catch {
        // ignore selection errors
      }
      setCopyStatus('error');
    }
    copyResetTimer.current = setTimeout(() => setCopyStatus('idle'), 4000);
  };

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, url, { width: 256, margin: 2 });
    }
  }, [url]);

  useEffect(() => {
    previousActive.current = document.activeElement;
    const nodes = getFocusableElements(modalRef.current);
    (nodes[0] || modalRef.current)?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const nodes = getFocusableElements(modalRef.current);
        if (nodes.length === 0) { e.preventDefault(); return; }
        const idx = nodes.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx === 0 || document.activeElement === modalRef.current) { nodes[nodes.length - 1].focus(); e.preventDefault(); }
        } else {
          if (idx === nodes.length - 1) { nodes[0].focus(); e.preventDefault(); }
        }
      }
    };

    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previousActive.current?.focus?.(); };
  }, [onClose]);

  const handleDownload = () => {
    const link = document.createElement('a');
    link.download = 'vaccination-qr.png';
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Vaccination QR Code and verification link"
      aria-describedby="qr-modal-description"
      onClick={(e) => e.target === overlayRef.current && onClose()}
      ref={overlayRef}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        tabIndex={-1}
        style={{
          background: '#1e293b', borderRadius: 12, padding: '1.5rem',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem',
        }}
      >
        <h3 style={{ color: '#e2e8f0', margin: 0 }}>Vaccination QR Code</h3>
        <p id="qr-modal-description" style={{ color: '#cbd5e1', margin: 0, maxWidth: 320, textAlign: 'center', fontSize: '0.9rem' }}>
          Scan this QR code to verify your vaccination record. If you cannot scan a visual code,
          use the verification link below instead — it contains the same information.
        </p>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="QR code encoding your vaccination verification link"
          style={{ borderRadius: 8 }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%', maxWidth: 320 }}>
          <label htmlFor="qr-verification-url" style={{ color: '#cbd5e1', fontSize: '0.85rem' }}>
            Verification link (selectable text alternative)
          </label>
          <input
            id="qr-verification-url"
            ref={urlInputRef}
            type="text"
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
            style={{
              width: '100%', padding: '0.5rem', borderRadius: 8, border: '1px solid #475569',
              background: '#0f172a', color: '#e2e8f0', fontSize: '0.85rem',
            }}
          />
          <button
            type="button"
            onClick={handleCopy}
            aria-describedby="qr-copy-status"
            style={{ padding: '0.5rem 1.25rem', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Copy link
          </button>
          <span
            id="qr-copy-status"
            role="status"
            aria-live="polite"
            style={{ color: copyStatus === 'error' ? '#fca5a5' : '#86efac', fontSize: '0.85rem', minHeight: '1.2em' }}
          >
            {copyStatus === 'success' && 'Link copied to clipboard.'}
            {copyStatus === 'error' && 'Could not copy automatically. The link is selected — press Ctrl+C (or Cmd+C) to copy it manually.'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleDownload}
            style={{ padding: '0.5rem 1.25rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Download PNG
          </button>
          <button
            onClick={onClose}
            style={{ padding: '0.5rem 1.25rem', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
