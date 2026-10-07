import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file uses its own in-memory PostgreSQL (PGlite); run sequentially
    // to keep memory low on CI runners.
    fileParallelism: false,
  },
});
