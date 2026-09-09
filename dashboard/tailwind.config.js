/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        ink: "var(--text)",
        title: "var(--title)",
        accent: "var(--accent)",
        surface: "var(--surface)",
        line: "var(--border)",
      },
      fontFamily: {
        display: ['"Playfair Display"', "serif"],
        sans: ['"Space Grotesk"', "system-ui", "sans-serif"],
        mono: ['"Fira Code"', "monospace"],
      },
      boxShadow: {
        glow: "0 0 20px var(--glow)",
      },
    },
  },
  plugins: [],
};
