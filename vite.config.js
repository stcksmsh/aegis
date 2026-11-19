import { defineConfig } from "vite";

// Base path the site is served under. GitHub Pages project sites live at
// https://<owner>.github.io/<Repo>/, so the default is "/<Repo>/". Once the
// site moves to its own hostname (public/CNAME + DNS), set the repository
// variable BASE_PATH to "/" instead of editing this file — the deploy
// workflow passes it through.
export default defineConfig({
  base: process.env.BASE_PATH || "/aegis/",
});
