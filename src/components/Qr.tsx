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
