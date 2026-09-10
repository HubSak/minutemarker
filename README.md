# MinuteMarker

A visual countdown timer. The coloured disk empties as the time runs out, so you can
see how long is left without reading a number.

Everything is one HTML file. No build step, no dependencies, no server, no accounts.
Nothing leaves your device — settings and presets live in your browser's local storage.

## What it does

- One disk, or several running in sequence
- Split a disk into coloured slices that empty one at a time
- Eight alarm sounds, plus optional chimes between timers and as each slice empties
- Save named presets, and copy them as text to move to another device
- Works fully offline once installed
- The alarm still sounds with the screen off

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire app |
| `manifest.webmanifest` | Name, icons and colours for home-screen install |
| `sw.js` | Service worker, for offline use |
| `icons/` | App icons |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |
| `test/` | Test suite (not part of the app) |

## Putting it online

See `SETUP.md` for the full walkthrough. The short version: upload these files to a
GitHub repository, turn on Pages in the repository settings, and open the URL it gives
you on your phone.

## Updating it

Replace `index.html` and commit. The service worker serves the cached copy first and
fetches the new one in the background, so **the update appears on the second launch
after you deploy**, not the first. To see a change immediately, open the app twice.

## Running the tests

```
cd test
npm install jsdom
node test-minutemarker.js
```

377 checks covering the run loop, the duration picker, audio, presets and offline state.
They drive the real page in jsdom with a fake clock, so timing is deterministic.

jsdom has no layout engine, so the tests cannot exercise real scroll-snapping. The feel
of the duration picker has to be checked on an actual phone.

## Notes

The alarm works with the screen off because the whole timer is rendered into a single
silent WAV file at startup, with the chimes baked in at their exact time offsets, and
played through an `<audio>` element. Browsers freeze JavaScript timers in the background
but keep audio playing, so this is the only approach that reliably fires on time. Timers
longer than two hours fall back to live chimes, which need the screen on.
