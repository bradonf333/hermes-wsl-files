# WSL Files — Hermes plugin

A file manager page for **Hermes Desktop connected to a remote gateway**
(e.g. a Mac app talking to Hermes in WSL). The built-in file browser hides
upload / rename / delete on remote gateways; this adds them.

- Browse folders, jump to any path
- Drag-and-drop upload from Finder (or the upload button), with overwrite prompt
- Edit text files (⌘S to save, warns if the file changed on disk)
- New file / new folder / rename
- Delete → moves to `~/.local/share/Trash/files` (recoverable)

Open it from the **WSL Files** sidebar row or ⌘K → *Open WSL Files*. Drag the
tab to a side split to use it like a pane.

## Install

In Hermes Desktop: **Settings → Capabilities → Plugins → Install from Git**,
paste this repo's URL, and check both the **agent** (gateway) and **Desktop**
targets. Then make sure the backend is enabled on the gateway machine:

```bash
hermes plugins enable wsl-files
```

No restart needed. Manual install: clone into `~/.hermes/plugins/wsl-files` on
the gateway machine, and copy `desktop/plugin.js` to
`~/.hermes/desktop-plugins/wsl-files/plugin.js` on the machine running the app.

## Settings

Only folders listed in `roots` are reachable (default `["~"]`). Set them in
**Settings → Plugins → WSL Files**, or:

```bash
hermes config set plugins.entries.wsl-files.settings.roots '["~", "/mnt/c/Users/you", "/mnt/d"]'
```

Always refused, wherever they are: `.ssh`, `.gnupg`, `.aws`, `.env`,
`auth.json`, `.netrc`.

## Limits

Uploads up to 200 MB per file; the editor opens UTF-8 text up to 2 MB.

## Layout

```
plugin.yaml                # manifest + `roots` setting
__init__.py                # no agent tools; required by the loader
dashboard/manifest.json    # mounts the backend at /api/plugins/wsl-files/
dashboard/plugin_api.py    # FastAPI routes (runs inside the gateway)
desktop/plugin.js          # the Desktop page (plain ESM, no build step)
```
