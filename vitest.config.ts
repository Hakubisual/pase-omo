import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Resolve a dependency to its own directory. Vitest's module runner cannot load
 * the Bun-installed `zod` through its exports map (`z` arrives undefined), so it
 * is pinned to the package directory instead.
 */
const require_ = createRequire(import.meta.url);
const packageDir = (id: string): string => {
  const manifest = require_.resolve(`${id}/package.json`);
  return manifest.slice(0, -"/package.json".length).replace(/\\/g, "/");
};

/**
 * Client code imports React Native and the host-provided plugin client modules,
 * neither of which is loadable outside the Paseo app. Alias them globally rather
 * than per-file: a bare-specifier `vi.mock` does not intercept imports made from
 * a different directory's module graph.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: here("./test/stubs/react-native.ts") },
      { find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: here("./test/stubs/plugin-react-native.ts") },
      { find: /^@getpaseo\/plugin\/client\/ui$/, replacement: here("./test/stubs/plugin-react-native.ts") },
      { find: /^@getpaseo\/plugin\/client$/, replacement: here("./test/stubs/plugin-client.ts") },
      { find: /^zod$/, replacement: packageDir("zod") },
    ],
  },
  test: { include: ["client/**/*.test.ts?(x)", "server/**/*.test.ts", "shared/**/*.test.ts", "test/**/*.test.ts?(x)"] },
});
