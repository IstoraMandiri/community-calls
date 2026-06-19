// @ts-check
import { rm } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import icon from "astro-icon";
import react from "@astrojs/react";
import rehypeExternalLinks from "rehype-external-links";
import remarkWebVtt from "./src/plugins/remark-webvtt.js";

// Dev-only routes that exist purely for local iteration and must never reach
// production. Each is gated at runtime (`if (!import.meta.env.DEV) redirect`)
// AND physically stripped from dist/ by the integration below, so a stray
// `astro build` can't ship them.
const DEV_ROUTES = [
  // route base name, plus any extra top-level dirs/files it owns and the
  // vendor chunks it (and only it) pulls into _astro/.
  {
    name: "videogen",
    extraDirs: ["videogen-sample"],
    vendors: ["audiomotion-analyzer"],
  },
  // audiogen loads Strudel from a CDN (external URL), so it produces no vendor
  // chunk of its own; only its page chunk needs stripping.
  { name: "audiogen" },
];

// Strips the dev-only routes (page chunks, html, sample assets, and their
// exclusive vendor chunks) from the build output so none of it reaches prod.
/** @type {import('astro').AstroIntegration} */
const stripDevRoutes = {
  name: "strip-dev-routes",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const { readdir } = await import("node:fs/promises");
      // Top-level outputs: the route dir (directory build format), its .html
      // (file build format), and any extra dirs the route owns.
      const topLevel = DEV_ROUTES.flatMap((r) => [
        r.name,
        `${r.name}.html`,
        ...(r.extraDirs ?? []),
      ]);
      await Promise.all(
        topLevel.map((t) =>
          rm(new URL(`./${t}`, dir), { recursive: true, force: true }),
        ),
      );
      const astroDir = new URL("./_astro/", dir);
      try {
        const entries = await readdir(astroDir);
        // Strip each route's own page chunk plus the vendor chunks it alone
        // pulls in. Vendor chunks are named after the package (not the route),
        // so they must be listed explicitly per route.
        const patterns = DEV_ROUTES.flatMap((r) => [
          r.name,
          ...(r.vendors ?? []),
        ]);
        // Escape regex metacharacters and require word boundaries so a token
        // like "audiogen" matches the dev chunk "audiogen.<hash>.js" but NOT an
        // unrelated prod chunk that merely contains the substring (e.g.
        // "audioGenerator.<hash>.js").
        const escapeRe = (/** @type {string} */ s) =>
          s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const devOnly = new RegExp(
          `\\b(${patterns.map(escapeRe).join("|")})\\b`,
          "i",
        );
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

// Dev-only: serve the audiogen reference recording from assets/ (kept in the
// repo for devs + future videogen use). `apply: "serve"` means this plugin only
// runs in `astro dev`, never in the build, and the file lives outside public/
// so it is never copied into dist/ at all - it cannot reach production.
/** @type {import('vite').Plugin} */
const audiogenDevRecording = {
  name: "audiogen-dev-recording",
  apply: "serve",
  configureServer(server) {
    const file = new URL("./assets/audiogen/recording.mp3", import.meta.url);
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? "").split("?")[0] !== "/audiogen/recording.mp3")
        return next();
      if (!existsSync(file)) {
        res.statusCode = 404;
        return res.end("no recording");
      }
      const size = statSync(file).size;
      res.setHeader("content-type", "audio/mpeg");
      res.setHeader("accept-ranges", "bytes");
      // Honor Range requests so the <audio> scrubber can seek.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = Math.min(m[2] ? parseInt(m[2], 10) : size - 1, size - 1);
        if (start > end) {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${size}`);
          return res.end();
        }
        res.statusCode = 206;
        res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
        res.setHeader("content-length", end - start + 1);
        return createReadStream(file, { start, end }).pipe(res);
      }
      res.setHeader("content-length", size);
      createReadStream(file).pipe(res);
    });
  },
};

// https://astro.build/config
export default defineConfig({
  site: "https://cc.ethereumclassic.org",
  output: "static",
  prefetch: true,
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss(), audiogenDevRecording],
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
    stripDevRoutes,
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
