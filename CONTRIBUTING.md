# Contributing

Thanks for helping improve TikTok Favorites Cleaner.

## Before you start

- Open an issue for bugs, compatibility problems, or larger feature ideas.
- Do not include cookies, access tokens, account exports, or unsanitized logs in an issue or pull request.
- Keep changes focused. A browser-specific fix should be isolated from unrelated formatting or refactors.

## Branches

Create a branch from `master` using one of these prefixes:

- `fix/` for bug fixes
- `feat/` for new behavior
- `docs/` for documentation
- `chore/` for maintenance

## Local checks

Run the validation commands from the README before opening a pull request:

```text
node --check chrome-extension/content.js
node --check chrome-extension/page-bridge.js
node --check chrome-extension/background.js
node --check firefox-extension/content.js
node --check firefox-extension/page-bridge.js
node --check firefox-extension/background.js
```

For behavior changes, test the affected browser with a small batch first. Record the browser version, extension version, and a sanitized summary of the logs.

## Pull requests

Every change should go through a pull request. The PR template must explain:

1. What changed and why.
2. Which browsers were tested.
3. Whether the change touches TikTok requests, navigation, or account data.
4. Any known limitations or follow-up work.

The validation workflow must pass before merging. The maintainer reviews and merges approved changes, preferably with a squash merge so the history stays easy to follow.

## Design and safety expectations

- Prefer the visible TikTok state over stale or contradictory assumptions when a click could add a favorite.
- Never treat a successful HTTP response as proof of the action direction without corroborating UI state.
- Do not add code that bypasses CAPTCHA, rate limits, authentication, or access controls.
- Keep captured request data minimal and avoid logging secrets or full request bodies.
- Preserve the Firefox fallback path; Firefox does not expose Chrome's debugger API.
