/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'Noto Sans Tamil', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      colors: {
        brand: {
          50: '#eff5ff', 100: '#dbe8fe', 200: '#bfd6fe', 300: '#93bbfd', 400: '#6096fa',
          500: '#3b73f6', 600: '#1f55eb', 700: '#1b44d8', 800: '#1c39af', 900: '#1d358a',
        },
        navy: { 700: '#16294d', 800: '#0f1f3d', 900: '#0a1630' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
        pop: '0 12px 32px -8px rgba(16,24,40,.18)',
      },
    },
  },
  plugins: [],
}
