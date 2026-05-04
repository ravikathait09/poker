import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        felt: { DEFAULT: "#0d4d2e", light: "#126b40" },
        clay: "#c4975c",
      },
    },
  },
  plugins: [],
} satisfies Config;
