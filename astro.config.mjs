// @ts-check
import { rm } from "node:fs/promises";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import icon from "astro-icon";
import react from "@astrojs/react";
import rehypeExternalLinks from "rehype-external-links";
import remarkWebVtt from "./src/plugins/remark-webvtt.js";

// Strips the dev-only /videogen route and its sample assets from the build
// output so they never reach production.
/** @type {import('astro').AstroIntegration} */
const stripVideogen = {
  name: "strip-videogen",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const { readdir } = await import("node:fs/promises");
      const topLevel = ["videogen", "videogen.html", "videogen-sample"];
      await Promise.all(
        topLevel.map((t) =>
          rm(new URL(`./${t}`, dir), { recursive: true, force: true }),
        ),
      );
      const astroDir = new URL("./_astro/", dir);
      try {
        const entries = await readdir(astroDir);
        // Strip the page's own chunk plus the dev-only vendor chunks it (and
        // only it) pulls in. audiomotion-analyzer is dynamic-imported from
        // ama.ts, so its chunk is named after the package, not the page, and
        // was leaking into prod under the old `startsWith("videogen")` filter.
        const devOnly = /videogen|audiomotion-analyzer/i;
        await Promise.all(
          entries
            .filter((e) => devOnly.test(e))
            .map((e) =>
              rm(new URL(`./${e}`, astroDir), { recursive: true, force: true }),
            ),
        );
      } catch {
        // _astro/ may not exist for non-static builds
      }
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: "https://cc.ethereumclassic.org",
  output: "static",
  prefetch: true,
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    remarkPlugins: [remarkWebVtt],
    rehypePlugins: [
      [
        rehypeExternalLinks,
        { target: "_blank", rel: ["noopener", "noreferrer"] },
      ],
    ],
  },
  integrations: [
    stripVideogen,
    react(),
    icon({
      include: {
        // Brand icons
        "simple-icons": [
          "discord",
          "youtube",
          "github",
          "google",
          "microsoftoutlook",
          "yahoo",
          "apple",
          "x",
          "telegram",
        ],
        // UI icons
        lucide: [
          "calendar",
          "clock",
          "map-pin",
          "chevron-down",
          "chevron-left",
          "chevron-right",
          "chevrons-right",
          "x",
          "phone",
          "copy",
          "check",
          "bell",
          "rss",
          "archive",
          "download",
          "menu",
          "arrow-left",
          "arrow-right",
          "external-link",
          "video",
          "home",
          "calendar-plus",
          "mail",
          "bookmark",
          "newspaper",
          "globe",
          "share-2",
        ],
      },
    }),
  ],
});
