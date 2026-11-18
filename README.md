# RiftAtlas Full Log Keeper

A Chrome extension that keeps **every** game-log line from
[play.riftatlas.com](https://play.riftatlas.com), and records your match to video with one click.

RiftAtlas only keeps a rolling window of recent log entries, so exported logs come back
truncated (a Bo3 export that starts mid-Game 2). This extension saves each line the moment it
appears on screen, so nothing is lost when the game's own log scrolls it away.

- **Automatic** — no start button. Open RiftAtlas and it is already capturing.
- **Complete** — lines survive the in-game log's rolling buffer.
- **Faithful** — exports match the in-game log line for line.
- **Private** — everything stays on your computer. No account, no uploads, no analytics.

## Install (about one minute)

The extension is not on the Chrome Web Store, so Chrome needs to be pointed at a folder once.
There is nothing to build or install besides the folder itself.

1. **Download** the extension:
   [**Download ZIP**](https://github.com/ding-harrison/RiftAtlasWatcher/archive/HEAD.zip).
   <br><sub>Same thing as the green **Code** button → **Download ZIP** on the repository page.
   If the repository is private you need to be signed in to GitHub for the link to work.</sub>
2. **Unzip it** and move the folder somewhere it can stay, such as `Documents`.
   Chrome loads the extension from this folder every time it starts, so don't leave it in
   `Downloads` if you clean that out.
3. Open **`chrome://extensions`** in Chrome (type it into the address bar).
4. Turn on **Developer mode** (switch in the top-right corner).
5. Click **Load unpacked** and choose the folder you unzipped — the one that contains
   `manifest.json` (it is named `RiftAtlasWatcher-…`; if unzipping made a folder inside a
   folder, pick the inner one).
6. Click the puzzle-piece icon in Chrome's toolbar and **pin** "RiftAtlas Full Log Keeper"
   so its badge is visible.

That's it. Open a match on play.riftatlas.com and the badge starts counting.

> Works in Chrome 116 or newer, and in other Chromium browsers (Edge, Brave) the same way via
> their own extensions page.

### Updating

1. Download the new zip and unzip it.
2. Replace the contents of your existing folder with the new files.
3. On `chrome://extensions`, click the reload arrow (↻) on the extension's card, then refresh
   any open RiftAtlas tab.

Your saved logs are kept across updates.

> **Careful:** clicking **Remove** on `chrome://extensions` deletes every saved log. Export
> first if you want to keep them.

<details>
<summary>Prefer git?</summary>

```bash
git clone https://github.com/ding-harrison/RiftAtlasWatcher.git
```

Load the cloned folder with **Load unpacked**. To update, run `git pull` in that folder and
click the reload arrow on `chrome://extensions`.

</details>

## Using it

### Logs

Capture is automatic whenever a play.riftatlas.com tab is open. Click the extension icon to see
your sessions, newest first. One page load is one session, so every game of a Bo3 in the same
room stays together — just like RiftAtlas's own log.

| Button                | What you get                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| **Export .txt**       | One line per row, exactly as shown in-game: `22:46 Played Scuttle Crab from hand to base.` |
| **Export .json**      | The same lines plus the real time each one was captured (`capturedAt`, ISO-8601). |
| **Export all (.txt)** | Every session, oldest first, separated by `==== Session started <time> ====`. |
| **Delete / Delete all** | Removes saved sessions. "Delete all" asks first.                           |

The log is kept as RiftAtlas showed it: both players' lines, repeat counters
(`Drew 1 card.×2`) and rewinds. A line that a rewind removes from the in-game log stays in
your export, followed by the rewind line.

**Joined late or refreshed mid-match?** RiftAtlas only draws its newest ~16 log lines until
you scroll. Scroll the in-game log down to its oldest line once and the extension picks up
everything RiftAtlas still has.

### Recording a match

1. On the RiftAtlas tab, click the extension icon → **Start recording**
   (or press **Alt+Shift+R**).
2. Play. One recording can cover a whole Bo3, and it keeps going if you switch tabs.
3. Click **Stop & save** (or press **Alt+Shift+R** again). The video lands in your Downloads
   folder as `riftatlas-<date>_<time>.webm`.

Good to know:

- Chrome only allows tab recording to start from your click or shortcut, so it **cannot
  auto-start**. To make up for that, the badge shows **`REC?`** whenever a match is being
  logged but not recorded. Don't want the reminder? Untick it in the popup and the badge shows
  the entry count instead.
- Game sound stays audible while recording.
- Closing the tab mid-match stops the recording and still saves the file.
- Change the shortcut at `chrome://extensions/shortcuts`.
- The `.webm` plays in Chrome, Firefox and VLC. Seeking can be sluggish in some players
  because the file is written as a live stream; running it once through
  `ffmpeg -i in.webm -c copy out.webm` fixes that.
- Expect roughly 1 GB per hour of recording.

### Badge colours

| Badge          | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `REC?` (orange) | Log lines are being captured, but you are not recording. |
| number (red)   | Recording; the number is the lines captured so far.   |
| number (grey)  | Lines captured so far (reminder switched off).        |

## If RiftAtlas changes its page

The extension reads RiftAtlas's own log rows, so there is nothing to set up. If a RiftAtlas
update ever changes how the log is built, two things protect you:

- **Automatic fallback.** When the row selector matches nothing, the extension switches to
  auto-detect: it keeps anything on the page that looks like a timestamped line. You still get
  your log, though it may include other timestamped text such as chat, and re-drawn lines can
  appear twice.
- **One setting to fix it properly.** `CONFIG` at the top of `content.js` holds `rowSelector`,
  the CSS selector for a single log row:

  ```js
  rowSelector: '[data-match-log-group] li',
  ```

  To update it: open a match, right-click a log line → **Inspect**, find the element that wraps
  exactly one line (its time, text and `×2` counter), and write a selector that matches every
  such row. Save the file, click the reload arrow on `chrome://extensions`, and refresh the
  RiftAtlas tab.

The same `CONFIG` block also holds `logContainerSelector` (limits auto-detect to one part of
the page), `linePattern`, `maxLineLength` and `saveDebounceMs`, each with a comment.

## Honest limitations

- **It only sees what RiftAtlas draws.** Lines from before you opened the tab, or lines
  RiftAtlas has already dropped from its own log, cannot be recovered.
- **A refresh starts a new session** with only the newest lines drawn; scroll the in-game log
  to load the older ones (see above).
- **Repeat counters show the highest value seen.** If a rewind undoes one of three identical
  draws, the export still says `×3`, followed by the rewind line.
- **Recording cannot start by itself** — a Chrome rule, not a choice.
- RiftAtlas only. No TCGA, no Firefox, no cloud sync.

## Privacy

Logs are stored in the browser's local extension storage and videos are written to your
Downloads folder. The extension makes no network requests of any kind and can only read pages
on `https://play.riftatlas.com/`. It never clicks, types or changes anything in the game.

Permissions, and why each is needed:

| Permission                     | Why                                                    |
| ------------------------------ | ------------------------------------------------------ |
| `storage`, `unlimitedStorage`  | Keep full match logs locally without a size cap.        |
| `tabCapture`, `offscreen`      | Record the RiftAtlas tab when you ask it to.            |
| `downloads`                    | Save the recording to your Downloads folder.            |
| `https://play.riftatlas.com/*` | Read the game log on that site, and nowhere else.       |

## Troubleshooting

| Problem                                   | Fix                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Badge stays empty during a match           | Refresh the RiftAtlas tab (needed once after installing or updating). If it is still empty, RiftAtlas may have changed its page — see "If RiftAtlas changes its page". |
| "Start recording" is greyed out            | Click the icon while the RiftAtlas tab is the active tab.            |
| The shortcut does nothing                  | Set it at `chrome://extensions/shortcuts`; another extension may already use Alt+Shift+R. |
| "Manifest file is missing" on Load unpacked | You picked the outer folder. Choose the one that directly contains `manifest.json`. |
| Old lines are missing after a refresh       | Scroll the in-game log down to its oldest line once.                 |

## Development

No build step and no dependencies; the repository root is the extension.

```
manifest.json    MV3 manifest
content.js       capture engine: CONFIG, log-row merge, auto-detect fallback, debounced save
background.js    service worker: badge + REC? nag, recording control
offscreen.html   hosts the recorder
offscreen.js     tab stream + audio passthrough + MediaRecorder → .webm
popup.html/.js   session list, exports, recording button
tests/           unit tests and log-line fixtures
```

Run the unit tests (Node 18+, nothing to install):

```bash
node --test tests/unit.test.js
```

To publish a release, bump `version` in `manifest.json`, add a `CHANGELOG.md` entry, and push a
matching tag such as `v1.0.1`. The workflow in `.github/workflows/package.yml` runs the tests
and attaches `riftatlas-log-keeper.zip` to a GitHub Release. The download link at the top of
this page does not depend on releases: it always serves the current default branch.

## License

[MIT](LICENSE)
