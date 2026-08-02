import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /*
     * Only ever run the TypeScript sources.
     *
     * `dist/` is gitignored build output, and tsc emits the test files into it
     * alongside everything else. Vitest's default glob has no idea those are
     * copies, so it collects both — and the compiled copy is pinned to whatever
     * the schema looked like when someone last ran a build. That makes this
     * suite pass or fail on build staleness rather than on the code, which is
     * exactly how a stale `dist/pipelines-schema.test.js` came to report a
     * missing `issues.flow_name` that is present in the migrations.
     */
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
