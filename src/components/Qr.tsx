import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

/** Renders a QR code for `value` as an <img> (works in print and can be downloaded). */
export function QrImage({ value, size = 160, className, dark = '#0f1f3d' }: { value: string; size?: number; className?: string; dark?: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M', color: { dark, light: '#ffffff' } })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(''))
    return () => { alive = false }
  }, [value, size, dark])
  return src
    ? <img src={src} width={size} height={size} alt={`QR code for ${value}`} className={className} />
    : <div style={{ width: size, height: size }} className={className} />
}

/**
 * QR code drawn as SVG straight away (no async image), so it is always there when the print dialog opens.
 * Crisp at any size: used on price stickers.
 */
export function QrSvg({ value, size, className, level = 'M' }: { value: string; size: string | number; className?: string; level?: 'L' | 'M' | 'Q' | 'H' }) {
  let n = 0, path = ''
  try {
    const m = QRCode.create(value || ' ', { errorCorrectionLevel: level }).modules
    n = m.size
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(x, y)) path += `M${x + 1} ${y + 1}h1v1h-1z`
  } catch { /* too long for a QR code */ }
  const box = n + 2 // one module of quiet zone
  return (
    <svg viewBox={`0 0 ${box} ${box}`} width={size} height={size} className={className} shapeRendering="crispEdges" role="img" aria-label={`QR code ${value}`}>
      <rect width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
