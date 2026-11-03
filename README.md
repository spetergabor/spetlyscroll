# SEAM

SEAM is a private, browser-based studio for creating seamless social-media carousels. Photos stay on the device, projects autosave in the browser, and finished slides export in posting order.

## Features

- Home dashboard with visual previews of saved graphics and a one-click new graphic action
- Multiple browser-local projects with automatic recent-project saving
- One continuous canvas across 1–10 slides
- 4:5, square, and story aspect ratios
- Drag and resize photos, then zoom and reposition the image inside its frame
- Full layer stack with drag-to-reorder, hide/show, lock, duplicate, send-back, and bring-front controls
- Display, body, and label typography
- Twelve bundled, privacy-friendly font families spanning editorial serif, modern sans, condensed, and handwritten styles
- Single-post templates for editorial, fashion, grids, scrapbook, profile, and monochrome layouts
- Dynamic full-bleed Quiet Stack layout with 2–5 edge-to-edge photos
- Fourteen seamless-carousel templates, including framed and full-bleed mosaics, overlapping stories, family grids, coastal collages, wedding editorial, garden, monochrome, and gallery styles
- Drop a library photo or a Finder image directly onto any highlighted template frame to replace its placeholder
- Editable backgrounds and typography
- Scoped canvas backgrounds that can cover 1, 2, 3, or every carousel slide from a chosen starting slide
- Swipe preview
- High-resolution PNG or JPEG export
- No account, backend, tracking, or upload

## Run locally

No build step is required. Serve the folder with any static file server:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Deploy on GitHub Pages

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to `main`; the included workflow deploys the app automatically.

The app is fully static and can be hosted directly from the repository root.

## Privacy

SEAM runs entirely in the browser. Images are read as local data and never sent to a server. Project autosave uses `localStorage`; very large projects may exceed the browser's storage limit but still remain usable in the active session.
