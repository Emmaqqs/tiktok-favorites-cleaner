# TikTok Favorites Cleaner

[![Validate](https://github.com/Emmaqqs/tiktok-favorites-cleaner/actions/workflows/validate.yml/badge.svg)](https://github.com/Emmaqqs/tiktok-favorites-cleaner/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local Chrome/Chromium and Firefox extension for removing TikTok saved videos in controlled batches. It uses the TikTok session already open in the browser and does not use Playwright, an external server, or a separate account token.

> Experimental community project. It is not affiliated with TikTok. TikTok can change its website, rate-limit requests, or show a CAPTCHA at any time.

## Features

- Batch processing without selecting videos one by one.
- Date filters for narrowing the cleanup range.
- Chrome/Chromium and Firefox builds.
- Real UI interaction with SPA-aware navigation.
- Network-aware waiting after each save/remove action.
- Adaptive cooldowns for 403/429 and other risk signals.
- Detailed local logs for navigation, button state, mutation responses, and verification.
- Safety-first handling of contradictory state: if TikTok's visible button says **Add to Favorites**, the extension skips the item instead of clicking it.
- No CAPTCHA solving and no attempt to bypass TikTok restrictions.

## Download

Ready-to-use archives are available in [`dist/`](dist/):

- [Chrome / Chromium ZIP](dist/tiktok-favorites-cleaner-chrome-0.9.8.zip)
- [Firefox ZIP](dist/tiktok-favorites-cleaner-firefox-0.9.8.zip)

## Installation

### Chrome / Chromium

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select [`chrome-extension/`](chrome-extension/).
5. Open TikTok with the intended account signed in and click the extension icon.

### Firefox

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Choose **Load Temporary Add-on**.
4. Select the Firefox ZIP from [`dist/`](dist/) or the `manifest.json` inside [`firefox-extension/`](firefox-extension/).

Temporary Firefox extensions must be loaded again after Firefox restarts.

## Safe first run

1. Start with a batch of 1–3 items and a narrow date range.
2. Keep **Allow unknown state** disabled.
3. Check the detailed logs before retrying skipped or failed items.
4. Increase the batch size only after confirming the account state is correct.

The **Verify the complete list** option can be slow because it walks the pages returned by TikTok. Action pacing may also increase automatically when TikTok signals a limit.

## Development

The extension has no package manager or build step. The two extension directories are directly loadable in their respective browsers.

Run the local validation checks with:

```text
node --check chrome-extension/content.js
node --check chrome-extension/page-bridge.js
node --check chrome-extension/background.js
node --check firefox-extension/content.js
node --check firefox-extension/page-bridge.js
node --check firefox-extension/background.js
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch, issue, and pull-request workflow.

## Privacy and limitations

- All processing runs locally in the browser.
- The extension does not send cookies, tokens, or logs to an owned server.
- Local logs can contain TikTok paths, public post IDs, and HTTP statuses; sanitize them before sharing.
- Deleted, private, or removed posts may leave stale counters or references that no longer appear in the Favorites grid.
- The extension cannot safely remove an item that TikTok no longer returns or renders.

## License

MIT. See [`LICENSE`](LICENSE).
