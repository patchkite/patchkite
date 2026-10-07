import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is served by the Patchkite server at /web/.
export default defineConfig({
  base: "/web/",
  plugins: [react()],
  server: { port: 5173 },
});
