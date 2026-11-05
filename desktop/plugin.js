/**
 * WSL Files — a file manager pane for the machine the gateway runs on.
 * Browse, edit text, drag-and-drop upload, new file/folder, rename, delete.
 *
 * Talks only to its own backend (~/.hermes/plugins/wsl-files/dashboard/plugin_api.py
 * on the gateway) via ctx.rest, so it works the same on a remote gateway.
 *
 * Install on the Mac: ~/.hermes/desktop-plugins/wsl-files/plugin.js
 *
 * Styling note: only Tailwind classes the app itself already uses exist in its
 * CSS (plugins aren't compiled). Check new classes against the app's dist CSS.
 * Plain ESM, loaded uncompiled — jsx() calls, not JSX syntax.
 */

import { Button, Codicon, Input, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, cn, host } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'wsl-files'
let api = null // the plugin ctx, set in register()

// ---------- backend calls ----------

const get = (path, params) => api.rest(`${path}?${new URLSearchParams(params)}`)
const post = (path, body) => api.rest(path, { method: 'POST', body })

const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const errText = e => String(e?.message || e).replace(/^.*?"detail":\s*"([^"]+)".*$/, '$1')
const isConflict = e => /409|already exists/i.test(String(e?.message || e))

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function fail(e) {
  host.notify({ kind: 'error', message: errText(e) })
}

async function uploadOne(dir, file, overwrite = false) {
  const bytes = await file.arrayBuffer()
  const qs = new URLSearchParams({ dir, overwrite: String(overwrite) })
  return api.rest(`/upload?${qs}`, {
    method: 'POST',
    upload: { filename: file.name, contentType: file.type || 'application/octet-stream', bytes },
    timeoutMs: 10 * 60 * 1000
  })
}

// ---------- small pieces ----------

function IconButton({ icon, label, onClick, disabled }) {
  return jsx(Button, {
    variant: 'ghost',
    size: 'xs',
    title: label,
    'aria-label': label,
    disabled,
    onClick,
    children: jsx(Codicon, { name: icon, size: 14 })
  })
}

/** Inline name box: Enter commits, Escape/blur cancels. */
function NameInput({ initial = '', placeholder, onSubmit, onCancel }) {
  const [value, setValue] = useState(initial)
  return jsx(Input, {
    autoFocus: true,
    className: 'h-6 text-xs',
    placeholder,
    value,
    onChange: e => setValue(e.target.value),
    onBlur: onCancel,
    onKeyDown: e => {
      if (e.key === 'Enter' && value.trim()) onSubmit(value.trim())
      if (e.key === 'Escape') onCancel()
    }
  })
}

function Row({ entry, renaming, onOpen, onRename, onRenameDone, onDelete }) {
  return jsxs('div', {
    className: 'group flex h-7 cursor-pointer items-center gap-2 rounded px-2 hover:bg-(--chrome-action-hover)',
    onClick: () => !renaming && onOpen(entry),
    children: [
      jsx(Codicon, {
        name: entry.dir ? 'folder' : 'file',
        size: 14,
        className: entry.dir ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)'
      }),
      renaming
        ? jsx('div', {
            className: 'flex-1',
            onClick: e => e.stopPropagation(),
            children: jsx(NameInput, { initial: entry.name, onSubmit: onRenameDone, onCancel: () => onRenameDone(null) })
          })
        : jsx('span', { className: 'flex-1 truncate text-xs', children: entry.name }),
      !entry.dir &&
        !renaming &&
        jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: formatSize(entry.size) }),
      !renaming &&
        jsxs('span', {
          className: 'flex items-center opacity-60 group-hover:opacity-100',
          onClick: e => e.stopPropagation(),
          children: [
            jsx(IconButton, { icon: 'edit', label: 'Rename', onClick: () => onRename(entry) }),
            jsx(IconButton, { icon: 'trash', label: 'Move to trash', onClick: () => onDelete(entry) })
          ]
        })
    ]
  })
}

// ---------- text editor ----------

function Editor({ path, onClose }) {
  const [file, setFile] = useState(null) // { content, mtime }
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    get('/read', { path })
      .then(f => {
        setFile(f)
        setDraft(f.content)
      })
      .catch(e => setError(errText(e)))
  }, [path])

  const dirty = file && draft !== file.content

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const res = await post('/write', { path, content: draft, mtime: file.mtime })
      setFile({ content: draft, mtime: res.mtime })
      host.notify({ kind: 'success', message: 'Saved' })
    } catch (e) {
      if (isConflict(e) && window.confirm('This file changed on disk since you opened it. Overwrite anyway?')) {
        const res = await post('/write', { path, content: draft }).catch(fail)
        if (res) setFile({ content: draft, mtime: res.mtime })
      } else {
        fail(e)
      }
    } finally {
      setSaving(false)
    }
  }, [dirty, saving, path, draft, file])

  const close = () => {
    if (!dirty || window.confirm('Discard unsaved changes?')) onClose()
  }

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1',
        children: [
          jsx(IconButton, { icon: 'arrow-left', label: 'Back to files', onClick: close }),
          jsx('span', { className: 'flex-1 truncate text-xs', title: path, children: (dirty ? '● ' : '') + path.split('/').pop() }),
          jsx(Button, { size: 'xs', disabled: !dirty || saving, onClick: save, children: saving ? 'Saving…' : 'Save' })
        ]
      }),
      error
        ? jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: error })
        : !file
          ? jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Loading…' })
          : jsx('textarea', {
              className: 'flex-1 resize-none bg-transparent p-2 font-mono text-xs outline-none',
              spellCheck: false,
              value: draft,
              onChange: e => setDraft(e.target.value),
              onKeyDown: e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  save()
                }
              }
            })
    ]
  })
}

// ---------- main pane ----------

function FilesPane() {
  const [cwd, setCwd] = useState(() => api.storage.get('cwd', null))
  const [listing, setListing] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // file path
  const [creating, setCreating] = useState(null) // 'file' | 'folder'
  const [renaming, setRenaming] = useState(null) // path
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [pathDraft, setPathDraft] = useState('')
  const fileInput = useRef(null)

  const load = useCallback(async dir => {
    try {
      const res = await get('/list', { path: dir })
      setListing(res)
      setCwd(res.path)
      setPathDraft(res.path)
      setError(null)
      api.storage.set('cwd', res.path)
    } catch (e) {
      setError(errText(e))
    }
  }, [])

  // First load: last folder, else home.
  useEffect(() => {
    if (cwd) load(cwd)
    else get('/roots').then(r => load(r.home)).catch(e => setError(errText(e)))
  }, [])

  const refresh = () => cwd && load(cwd)

  const upload = async files => {
    if (!cwd || !files.length) return
    setUploading(n => n + files.length)
    for (const file of files) {
      try {
        await uploadOne(cwd, file)
      } catch (e) {
        if (isConflict(e) && window.confirm(`${file.name} already exists. Replace it?`)) {
          await uploadOne(cwd, file, true).catch(fail)
        } else if (!isConflict(e)) {
          fail(e)
        }
      } finally {
        setUploading(n => n - 1)
      }
    }
    host.notify({ kind: 'success', message: `Uploaded ${files.length} file${files.length > 1 ? 's' : ''}` })
    refresh()
  }

  const create = async name => {
    const kind = creating
    setCreating(null)
    const path = joinPath(cwd, name)
    try {
      await post(kind === 'folder' ? '/mkdir' : '/new-file', { path })
      await load(cwd)
      if (kind === 'file') setEditing(path)
    } catch (e) {
      fail(e)
    }
  }

  const finishRename = async name => {
    const path = renaming
    setRenaming(null)
    if (!name || name === path.split('/').pop()) return
    await post('/rename', { path, name }).catch(fail)
    refresh()
  }

  const remove = async entry => {
    if (!window.confirm(`Move "${entry.name}" to the trash?`)) return
    await post('/delete', { path: entry.path }).catch(fail)
    refresh()
  }

  if (editing) return jsx(Editor, { path: editing, onClose: () => setEditing(null) })

  const toolbar = jsxs('div', {
    className: 'flex items-center gap-0.5 border-b border-(--ui-stroke-secondary) px-1 py-1',
    children: [
      jsx(IconButton, { icon: 'arrow-up', label: 'Up one folder', disabled: !listing?.parent, onClick: () => load(listing.parent) }),
      jsx(IconButton, { icon: 'home', label: 'Home', onClick: () => get('/roots').then(r => load(r.home)) }),
      jsx('div', {
        className: 'mx-1 flex-1',
        children: jsx(Input, {
          className: 'h-6 text-xs',
          value: pathDraft,
          onChange: e => setPathDraft(e.target.value),
          onKeyDown: e => e.key === 'Enter' && load(pathDraft.trim())
        })
      }),
      jsx(IconButton, { icon: 'new-file', label: 'New file', onClick: () => setCreating('file') }),
      jsx(IconButton, { icon: 'new-folder', label: 'New folder', onClick: () => setCreating('folder') }),
      jsx(IconButton, { icon: 'cloud-upload', label: 'Upload files', onClick: () => fileInput.current?.click() }),
      jsx(IconButton, { icon: 'refresh', label: 'Refresh', onClick: refresh }),
      jsx('input', {
        ref: fileInput,
        type: 'file',
        multiple: true,
        hidden: true,
        onChange: e => {
          upload([...e.target.files])
          e.target.value = ''
        }
      })
    ]
  })

  const body = error
    ? jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: error })
    : !listing
      ? jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Loading…' })
      : jsxs('div', {
          className: 'flex-1 overflow-y-auto p-1',
          children: [
            creating &&
              jsxs('div', {
                className: 'flex h-7 items-center gap-2 px-2',
                children: [
                  jsx(Codicon, { name: creating === 'folder' ? 'folder' : 'file', size: 14 }),
                  jsx('div', {
                    className: 'flex-1',
                    children: jsx(NameInput, {
                      placeholder: creating === 'folder' ? 'folder name' : 'file name',
                      onSubmit: create,
                      onCancel: () => setCreating(null)
                    })
                  })
                ]
              }),
            ...listing.entries.map(entry =>
              jsx(
                Row,
                {
                  entry,
                  renaming: renaming === entry.path,
                  onOpen: e => (e.dir ? load(e.path) : setEditing(e.path)),
                  onRename: e => setRenaming(e.path),
                  onRenameDone: finishRename,
                  onDelete: remove
                },
                entry.path
              )
            ),
            !listing.entries.length &&
              !creating &&
              jsx('div', { className: 'p-3 text-center text-xs text-(--ui-text-quaternary)', children: 'Empty folder — drop files here' })
          ]
        })

  return jsxs('div', {
    className: cn('relative flex h-full flex-col', dragging && 'bg-primary/10 ring-2 ring-inset ring-(--ui-accent)'),
    onDragOver: e => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: e => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
    },
    onDrop: e => {
      e.preventDefault()
      setDragging(false)
      upload([...e.dataTransfer.files])
    },
    children: [
      toolbar,
      body,
      uploading > 0 &&
        jsx('div', {
          className: 'border-t border-(--ui-stroke-secondary) px-2 py-1 text-[0.6875rem] text-(--ui-text-tertiary)',
          children: `Uploading ${uploading} file${uploading > 1 ? 's' : ''}…`
        })
    ]
  })
}

const PAGE = '/wsl-files'

export default {
  id: ID, // must match the folder name
  name: 'WSL Files',
  register(ctx) {
    api = ctx
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, title: 'WSL Files', data: { path: PAGE }, render: () => jsx(FilesPane, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PAGE, label: 'WSL Files', codicon: 'files' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: { id: 'wsl-files.open', label: 'Open WSL Files', keywords: ['files', 'wsl', 'upload'], run: () => host.navigate(PAGE) }
      }
    ])
  }
}
