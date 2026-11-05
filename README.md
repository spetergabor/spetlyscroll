# Spetlyscroll

Spetlyscroll is a private, browser-based studio for creating seamless social-media carousels. Photos and videos stay on the device, projects autosave in the browser, and finished slides export in posting order.

[Open the web app](https://spetergabor.github.io/spetlyscroll/) · [Download the desktop app](https://github.com/spetergabor/spetlyscroll/releases/latest)

## Features

- Home dashboard with visual previews of saved graphics and a one-click new graphic action
- Multiple browser-local projects with automatic recent-project saving
- One continuous canvas across 1–20 slides
- 4:5, square, and story aspect ratios
- Drag and resize photos or videos, then zoom and reposition the media inside its frame
- Full layer stack with drag-to-reorder, hide/show, lock, duplicate, send-back, and bring-front controls
- Display, body, and label typography
- Twelve bundled, privacy-friendly font families spanning editorial serif, modern sans, condensed, and handwritten styles
- Single-post templates for editorial, fashion, grids, scrapbook, profile, and monochrome layouts
- Dynamic full-bleed Quiet Stack layout with 2–5 edge-to-edge photos
- Fourteen seamless-carousel templates, including framed and full-bleed mosaics, overlapping stories, family grids, coastal collages, wedding editorial, garden, monochrome, and gallery styles
- Drop a library photo, video, or Finder file directly onto any highlighted template frame to replace its placeholder
- Editable backgrounds and typography
- Scoped canvas backgrounds that can cover 1, 2, 3, or every carousel slide from a chosen starting slide
- Swipe preview
- Mixed Instagram carousel export: high-resolution PNG/JPEG images plus locally encoded MP4 video slides in posting order
- 1080×1350, 1080×1080, and 1080×1920 H.264/AAC video output with crop, overlays, and typography baked in
- No account, backend, tracking, or upload
- Native offline macOS desktop app with the same browser-local privacy model

## Run locally

No build step is required. Serve the folder with any static file server:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Desktop app

The macOS desktop app wraps the same static editor in a sandboxed Electron window and works offline. To run it during development:

```bash
npm install
npm run desktop
```

To create Apple Silicon DMG and ZIP installers:

```bash
npm run desktop:build
```

The downloadable build is unsigned. On first launch, macOS may require **Control-click → Open** from Finder.

## Deploy on GitHub Pages

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to `main`; the included workflow deploys the app automatically.

The app is fully static and can be hosted directly from the repository root.

## Privacy

Spetlyscroll runs entirely in the browser. Photos and videos are read and processed locally and never sent to a server. Project metadata and media are stored separately in IndexedDB to keep editing responsive with larger libraries.
