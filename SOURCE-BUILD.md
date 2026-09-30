# Building Pensa from source

For Firefox Add-ons reviewers. This produces the exact files in the uploaded Firefox zip.

## Environment

- Node.js 26.3.1 and npm 11.16.0 (the versions the release was built with)
- Any OS with `npx` on the path. Built on macOS 26.

## Steps

```bash
npm ci
node scripts/release.mjs --firefox-build
```

The build is written to `.output/firefox-mv3/`. Its files match the uploaded
`pensa-<version>-firefox.zip` byte for byte. The build stamp is fixed to the version for
release builds, so a rebuild does not differ by time of day.

## What the bundler does

[WXT](https://wxt.dev) (Vite underneath) compiles the TypeScript in `src/` and bundles it.
Nothing is fetched or generated at build time except what `npm ci` installs from the lockfile.
Two values are compiled in:

- `TELEMETRY_ENDPOINT`: the only address Pensa ever sends to, set in `scripts/release.mjs`.
  Nothing is sent unless the person opts in on the install card or in Settings, and on Firefox
  only while Firefox's own data collection permission is also granted.
- `BUILD_STAMP`: the text shown at the bottom of the popup.

## Third-party code in the bundle

| Package | Why |
|---|---|
| `preact` | the popup and settings pages |
| `dexie` | IndexedDB, for the on-device history |
| `tldts` | names the shop by its registrable domain. It carries the Public Suffix List, which is most of the size of `background.js` |
| `zod` | validates every message and every stored record |

`background.js` contains one `Function("")` call. It is zod's check for whether it may compile
validators. Pensa turns that off with `z.config({ jitless: true })` in `src/shared/schema.ts`,
so the check never runs; the code is still in the library.

## Where the Firefox differences are

- `src/shared/browser.ts`: asks for Firefox's data collection permission (`browsingActivity`,
  `websiteContent`, `websiteActivity`, all optional) when the person says yes to sharing, and
  gives it back when they say no.
- `src/entrypoints/background.ts`: follows that permission if it is changed in about:addons.
- `wxt.config.ts`: the add-on id and `data_collection_permissions`.
