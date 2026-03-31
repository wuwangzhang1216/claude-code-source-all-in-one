/**
 * Bun preload plugin for running Claude Code from source.
 *
 * Handles two compile-time features that don't exist at runtime:
 * 1. bun:bundle - Feature flag system (DCE at build time)
 * 2. MACRO.* - Build-time constants inlined by the bundler
 */

import { plugin } from "bun";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shim bun:bundle's feature() to return false for all feature flags.
// In the official build, feature() is evaluated at compile time and
// dead code is eliminated. At runtime, we just disable all gates.
plugin({
  name: "bun-bundle-shim",
  setup(build) {
    build.module("bun:bundle", () => {
      return {
        exports: {
          feature: (_name: string) => false,
        },
        loader: "object",
      };
    });

    // Handle .md and .txt file imports as text (Bun bundler does this at build time)
    build.onLoad({ filter: /\.(md|txt)$/ }, async (args) => {
      const fs = require("fs");
      const text = fs.readFileSync(args.path, "utf8");
      return {
        exports: { default: text },
        loader: "object",
      };
    });

    // Redirect 'src/*' imports to root directory.
    // The source code uses `from 'src/...'` paths but our files are at root level.
    build.onResolve({ filter: /^src\// }, (args) => {
      const relativePath = args.path.replace(/^src\//, "");
      // Try .ts, .tsx, .js extensions
      const basePath = resolve(__dirname, relativePath);
      for (const ext of ["", ".ts", ".tsx", ".js"]) {
        const candidate = basePath.replace(/\.js$/, "") + ext;
        try {
          const fs = require("fs");
          if (fs.existsSync(candidate)) {
            return { path: candidate };
          }
        } catch {}
      }
      // Fallback: let Bun resolve it from root
      return { path: resolve(__dirname, relativePath) };
    });
  },
});

// MACRO.* globals are inlined at build time by Bun's bundler.
// We define them as runtime globals instead.
(globalThis as any).MACRO = {
  VERSION: "2.1.88",
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: "@anthropic-ai/claude-code",
  NATIVE_PACKAGE_URL: "@anthropic-ai/claude-code-native",
  FEEDBACK_CHANNEL: "https://github.com/anthropics/claude-code/issues",
  ISSUES_EXPLAINER: "https://github.com/anthropics/claude-code/issues",
  VERSION_CHANGELOG: "https://github.com/anthropics/claude-code/releases",
};
