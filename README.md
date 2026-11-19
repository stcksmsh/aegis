# Project website template (`website` branch, Level 3) — PILOT

Status: **proposed convention, not yet piloted with a real project.** Standardise
it only after one real project has used it end to end.

This directory is the template for a project's own, independently deployed
website. It lives on an orphan `website` branch of the *project's* repository,
not in `stcksmsh.github.io`. Create it with the bootstrap script rather than
copying by hand:

```sh
# from a checkout of stcksmsh.github.io
scripts/new-project-site.sh ~/path/to/ProjectRepo            # base path /<Repo>/
scripts/new-project-site.sh ~/path/to/ProjectRepo /           # custom domain later
```

The script fills in the placeholders (`__REPO_NAME__`, `__BASE_PATH__`,
`__SITE_URL__`), commits the branch locally, and never pushes.

## The three publication levels

| Level | What the project provides | What the root site does |
|---|---|---|
| 1. Index entry | `meta.json` on `io-page` | Lists it, links to repo/demo |
| 2. Embedded page | `io-page` with `meta.json`, `devlogs/`, optional `page/entry.tsx` | Builds `/projects/<slug>`, compiling the `page/` bundle into its own build |
| 3. Independent publication | This: a `website` branch with its own source, build and deploy, plus `publication.json` | Reads **only** `publication.json` and links out to `url` |

Levels stack: a Level 3 project normally keeps its `io-page` branch (meta.json
and devlogs). Level 3 only adds a link-out and a few metadata fields.

## `publication.json`

At the root of the `website` branch:

```json
{
  "schemaVersion": 1,
  "url": "https://stcksmsh.github.io/<Repo>/",
  "category": "software",
  "visibility": "public",
  "preview": "https://…/optional-absolute-image-url.png"
}
```

- `category`: `software` | `art` | `music` | `app`
- `visibility`: `public` (listed on `/projects` and the homepage) or `unlisted`
  (hidden from listings; its `/projects/<slug>` page still builds)
- `preview`: optional, absolute URL

## Opting in on the root site

Add `"website": true` to the project's entry in `stcksmsh.github.io`'s
`projects.manifest.json` (or a branch name string if the branch is not called
`website`). Without that flag the root site never looks at this branch.

## Deployment

`.github/workflows/deploy-website.yml` builds on every push to `website` and
deploys to this repository's GitHub Pages. One-time setup in the project
repo: **Settings → Pages → Source: GitHub Actions**.

Optionally, add a `SITE_DISPATCH_TOKEN` secret (fine-grained PAT on
`stcksmsh.github.io`, only "Actions: Read and write") so a deploy also
triggers a root-site rebuild — same token as the `io-page` `notify-site.yml`.

## Failure isolation

- This site builds and deploys on its own; it does not need the root site.
- The root site never fetches or compiles this source. If `publication.json`
  is missing, invalid or unreachable, the root build logs a warning and
  treats the project as Level 1/2. A failing project build never blocks it.

## Custom subdomain later (owner-gated)

Needs DNS changes, so only the owner does this:

1. Add `public/CNAME` containing the hostname.
2. Point DNS at GitHub Pages and set the custom domain in Settings → Pages.
3. Set the repository variable `BASE_PATH` to `/` (Settings → Secrets and
   variables → Actions → Variables).
4. Update `url` in `publication.json`.
