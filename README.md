# Aegis — website branch

The source of Aegis's website, <https://kostavukicevic.com/aegis/>. This is an orphan branch:
it shares no history with `master` and holds only the site.

- Plain Vite, no framework, one dev dependency. `npm install && npm run dev` to work on it,
  `npm run build` for `dist/`.
- `.github/workflows/deploy-website.yml` builds and deploys it to this repository's GitHub
  Pages on every push to `website` (Settings → Pages → Source: "GitHub Actions").
- Base path: `/aegis/` by default (`vite.config.js`). For a custom domain, set the repository
  variable `BASE_PATH` to `/`, add `public/CNAME`, and update `url` in `publication.json`.
- `publication.json` is the only file stcksmsh.github.io reads from this branch (its project
  index links here). `visibility: "unlisted"` hides Aegis from that index without taking the
  site down.
- Content comes from `master`'s README, SECURITY.md and CHANGELOG. `public/media/` holds copies
  of `master`'s `docs/images/` and the app icon (`apps/ui/src-tauri/icons/128x128.png`);
  `demo-poster.png` is the first frame of `demo.mp4`. Update them here when they change there.
- The download table fills in real installer links from the GitHub API's latest release when
  one exists; otherwise it says no release is out yet.
