// Local development only (the நாடார் உணவகம் demo shop): simple drawn pictures of South Indian dishes on a banana
// leaf, made in the browser (no photos are downloaded). Each dish → a 320 px picture and a 160 px thumbnail.
export type Dish = 'parotta' | 'dosa' | 'roast' | 'chapati' | 'chicken' | 'kothu' | 'idli' | 'poori' | 'pongal' | 'biryani' | 'kuska'

type Ctx2D = CanvasRenderingContext2D
const TAU = Math.PI * 2

function leaf(g: Ctx2D, s: number) {
  g.fillStyle = '#fbf3e4'; g.fillRect(0, 0, s, s)
  g.save(); g.translate(s / 2, s / 2); g.rotate(-0.35)
  g.fillStyle = '#2f7d32'; g.beginPath(); g.ellipse(0, 0, s * 0.62, s * 0.36, 0, 0, TAU); g.fill()
  g.strokeStyle = '#4f9c4f'; g.lineWidth = s * 0.012
  g.beginPath(); g.moveTo(-s * 0.6, 0); g.lineTo(s * 0.6, 0); g.stroke()
  g.lineWidth = s * 0.005
  for (let i = -5; i <= 5; i++) { g.beginPath(); g.moveTo(i * s * 0.1, 0); g.lineTo(i * s * 0.1 + s * 0.08, -s * 0.3); g.moveTo(i * s * 0.1, 0); g.lineTo(i * s * 0.1 + s * 0.08, s * 0.3); g.stroke() }
  g.restore()
}
function bowl(g: Ctx2D, x: number, y: number, r: number, fill: string, dots?: string) {
  g.fillStyle = '#d9d2c3'; g.beginPath(); g.arc(x, y, r * 1.12, 0, TAU); g.fill()
  g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill()
  if (dots) { g.fillStyle = dots; for (let i = 0; i < 7; i++) { const a = i * 0.9, d = r * 0.55 * ((i % 3) / 3 + 0.3); g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.09, 0, TAU); g.fill() } }
}
function round(g: Ctx2D, x: number, y: number, r: number, fill: string, edge: string) {
  g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill()
  g.strokeStyle = edge; g.lineWidth = r * 0.07; g.stroke()
}
function speckle(g: Ctx2D, x: number, y: number, r: number, color: string, n: number, seed: number) {
  g.fillStyle = color
  for (let i = 0; i < n; i++) { const a = (i * 2.399 + seed) % TAU, d = r * Math.sqrt((i + 0.5) / n); g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.045, 0, TAU); g.fill() }
}
function rice(g: Ctx2D, x: number, y: number, r: number, base: string, grains: string[]) {
  g.fillStyle = base; g.beginPath(); g.ellipse(x, y, r, r * 0.8, 0, 0, TAU); g.fill()
  for (let i = 0; i < 140; i++) {
    const a = i * 2.399, d = r * 0.95 * Math.sqrt((i + 0.5) / 140)
    g.fillStyle = grains[i % grains.length]
    g.save(); g.translate(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8); g.rotate(a)
    g.beginPath(); g.ellipse(0, 0, r * 0.06, r * 0.022, 0, 0, TAU); g.fill(); g.restore()
  }
}

function draw(g: Ctx2D, s: number, dish: Dish) {
  leaf(g, s)
  const c = s / 2
  switch (dish) {
    case 'parotta':
      for (const [dx, dy] of [[-0.1, 0.03], [0.08, -0.04]] as const) {
        const x = c + dx * s, y = c + dy * s
        round(g, x, y, s * 0.24, '#e7b45c', '#b97d2b')
        g.strokeStyle = '#c98d3a'; g.lineWidth = s * 0.008
        for (let k = 1; k <= 5; k++) { g.beginPath(); g.arc(x, y, s * 0.045 * k, k, k + 4.6); g.stroke() }
      }
      bowl(g, c + s * 0.3, c + s * 0.24, s * 0.08, '#b5532a', '#7a2f12')
      break
    case 'dosa': case 'roast': {
      const long = dish === 'roast'
      g.save(); g.translate(c, c); g.rotate(-0.35)
      g.fillStyle = long ? '#c9822f' : '#e2a650'
      g.beginPath(); g.moveTo(-s * (long ? 0.44 : 0.36), -s * 0.06); g.lineTo(s * (long ? 0.44 : 0.36), -s * 0.1); g.lineTo(s * (long ? 0.44 : 0.36), s * 0.1); g.lineTo(-s * (long ? 0.44 : 0.36), s * 0.06); g.closePath(); g.fill()
      g.strokeStyle = long ? '#8f5418' : '#b77a2c'; g.lineWidth = s * 0.008
      for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * s * 0.1, -s * 0.07); g.lineTo(i * s * 0.1 + s * 0.02, s * 0.07); g.stroke() }
      g.restore()
      bowl(g, c - s * 0.24, c + s * 0.25, s * 0.075, '#f2efe4', '#3f8f3a')
      bowl(g, c + s * 0.05, c + s * 0.3, s * 0.075, '#c6532d', '#7e2c10')
      break
    }
    case 'chapati':
      round(g, c - s * 0.09, c - s * 0.02, s * 0.22, '#e9c88d', '#c19a55')
      round(g, c + s * 0.06, c + s * 0.02, s * 0.22, '#e3bd7d', '#b98f49')
      speckle(g, c + s * 0.06, c + s * 0.02, s * 0.2, '#a3712e', 18, 1)
      bowl(g, c + s * 0.3, c + s * 0.24, s * 0.085, '#d58a3b', '#8a4c16')
      break
    case 'chicken':
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9, d = s * 0.12 * ((i % 3) / 2 + 0.2)
        g.fillStyle = i % 2 ? '#9c3a17' : '#b9481c'
        g.beginPath(); g.ellipse(c + Math.cos(a) * d, c + Math.sin(a) * d, s * 0.09, s * 0.065, a, 0, TAU); g.fill()
      }
      g.fillStyle = '#f4f1e8'; g.beginPath(); g.ellipse(c + s * 0.27, c - s * 0.2, s * 0.06, s * 0.03, 0.5, 0, TAU); g.fill()
      g.fillStyle = '#5aa04a'; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(c - s * 0.05 + i * s * 0.035, c - s * 0.13 + (i % 2) * s * 0.03, s * 0.012, 0, TAU); g.fill() }
      break
    case 'kothu':
      for (let i = 0; i < 70; i++) {
        const a = i * 2.399, d = s * 0.26 * Math.sqrt((i + 0.5) / 70)
        g.fillStyle = ['#e2aa55', '#c98c3a', '#f2d48f', '#a5481d', '#5aa04a'][i % 5]
        g.save(); g.translate(c + Math.cos(a) * d, c + Math.sin(a) * d * 0.8); g.rotate(a); g.fillRect(-s * 0.025, -s * 0.012, s * 0.05, s * 0.024); g.restore()
      }
      bowl(g, c + s * 0.32, c + s * 0.22, s * 0.07, '#e9e6da', '#8b5aa6')
      break
    case 'idli':
      for (const [dx, dy] of [[-0.16, -0.06], [0.04, -0.12], [0.02, 0.08]] as const) {
        g.fillStyle = '#d8d2c4'; g.beginPath(); g.ellipse(c + dx * s, c + dy * s + s * 0.01, s * 0.12, s * 0.09, 0, 0, TAU); g.fill()
        g.fillStyle = '#fbfaf5'; g.beginPath(); g.ellipse(c + dx * s, c + dy * s, s * 0.12, s * 0.09, 0, 0, TAU); g.fill()
      }
      bowl(g, c + s * 0.24, c + s * 0.22, s * 0.075, '#f2efe4', '#3f8f3a')
      bowl(g, c - s * 0.16, c + s * 0.26, s * 0.075, '#c6532d', '#7e2c10')
      break
    case 'poori':
      for (const [dx, dy] of [[-0.1, -0.06], [0.1, -0.02]] as const) {
        const g2 = g.createRadialGradient(c + dx * s - s * 0.05, c + dy * s - s * 0.05, s * 0.02, c + dx * s, c + dy * s, s * 0.19)
        g2.addColorStop(0, '#f6cf7a'); g2.addColorStop(1, '#c98c34')
        g.fillStyle = g2; g.beginPath(); g.arc(c + dx * s, c + dy * s, s * 0.17, 0, TAU); g.fill()
      }
      bowl(g, c, c + s * 0.26, s * 0.1, '#f1c84a', '#e07d1d')
      break
    case 'pongal':
      g.fillStyle = '#f3e3a6'; g.beginPath(); g.ellipse(c, c, s * 0.24, s * 0.19, 0, 0, TAU); g.fill()
      speckle(g, c, c, s * 0.22, '#2b2b2b', 22, 2)
      g.fillStyle = 'rgba(240,190,60,0.55)'; g.beginPath(); g.ellipse(c - s * 0.05, c - s * 0.05, s * 0.07, s * 0.04, 0.4, 0, TAU); g.fill()
      g.fillStyle = '#c9893b'; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(c + s * 0.1 - i * s * 0.04, c - s * 0.1 + (i % 2) * s * 0.03, s * 0.016, 0, TAU); g.fill() }
      bowl(g, c + s * 0.3, c + s * 0.22, s * 0.075, '#c47a2f', '#6e3d10')
      break
    case 'biryani': case 'kuska':
      rice(g, c, c, s * 0.28, dish === 'biryani' ? '#f0c55a' : '#f2d27c', dish === 'biryani' ? ['#fff6dc', '#f2a93b', '#fbe7a6', '#e47b22'] : ['#fff6dc', '#f6d27e', '#fbe7a6'])
      if (dish === 'biryani') { g.fillStyle = '#a2401a'; g.beginPath(); g.ellipse(c + s * 0.04, c - s * 0.03, s * 0.1, s * 0.07, 0.6, 0, TAU); g.fill(); g.fillStyle = '#b9541f'; g.beginPath(); g.ellipse(c - s * 0.09, c + s * 0.06, s * 0.07, s * 0.05, -0.3, 0, TAU); g.fill() }
      g.fillStyle = '#5aa04a'; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(c - s * 0.12 + i * s * 0.05, c - s * 0.14 + (i % 2) * s * 0.04, s * 0.013, 0, TAU); g.fill() }
      bowl(g, c + s * 0.3, c + s * 0.24, s * 0.075, '#f4f1e6', '#7a5aa0')
      break
  }
}

/** A dish's picture and thumbnail as data URLs; null outside a browser. */
export function dishImage(dish: Dish): { imageUrl: string; thumbUrl: string } | null {
  if (typeof document === 'undefined') return null
  const make = (s: number) => {
    const cv = document.createElement('canvas'); cv.width = s; cv.height = s
    const g = cv.getContext('2d')
    if (!g) return null
    draw(g, s, dish)
    const webp = cv.toDataURL('image/webp', 0.82)
    return webp.startsWith('data:image/webp') ? webp : cv.toDataURL('image/jpeg', 0.85)
  }
  const imageUrl = make(320), thumbUrl = make(160)
  return imageUrl && thumbUrl ? { imageUrl, thumbUrl } : null
}
