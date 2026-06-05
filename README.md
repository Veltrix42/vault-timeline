# Vault Timeline

An [Obsidian](https://obsidian.md) plugin that turns your notes into an interactive, zoomable timeline — automatically indexed from frontmatter dates.

---

## Features

- **Auto-indexing** — scans all markdown files and builds a timeline from their frontmatter dates
- **Zoomable axis** — switch between Day / Week / Month / Year / Decade views
- **Tag-based color groups** — assign colors to tags; events are colored by their first matching tag
- **Duration bars** — notes with both a start and end date render as a horizontal span
- **Search & filter** — filter events by full-text search or by tag
- **Minimap** — a compact all-events overview at the bottom with a draggable viewport indicator
- **Tooltips** — hover over any event to see its title, date, excerpt, and tags
- **Click to open** — click any event dot or label to jump straight to the note
- **Context menu** — right-click an event for quick actions (open note, jump to date)
- **Auto-refresh** — timeline updates automatically when notes are created, modified, or deleted

---

## Installation

### From the Obsidian Community Plugins browser *(once published)*

1. Open **Settings → Community plugins → Browse**
2. Search for **Vault Timeline**
3. Click **Install**, then **Enable**

### Manual installation

1. Download the latest release from the [Releases](../../releases) page (`main.js`, `manifest.json`, `styles.css`)
2. Copy the files into your vault at `.obsidian/plugins/vault-timeline/`
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**

---

## Usage

### Opening the timeline

- Click the **clock-calendar icon** in the left ribbon, or
- Run the command `Open Vault Timeline` from the command palette (`Ctrl/Cmd + P`)

### Date frontmatter

The plugin reads dates from your notes' YAML frontmatter. By default it looks for the field `date`:

```yaml
---
title: Project kickoff
date: 2024-03-15
endDate: 2024-04-01
tags: [project, milestone]
---
```

Supported date formats:
- `2024-03-15`
- `2024-03-15T09:30`
- `15.03.2024`
- `15/03/2024`
- `2024/03/15`

If a note has no date field, its **file creation time** is used as a fallback.

### Navigation

| Control | Action |
|---|---|
| `‹` / `›` buttons | Move the view backward / forward by one zoom unit |
| **Today** button | Jump to the current date |
| Zoom buttons | Switch between Day, Week, Month, Year, Decade |
| Minimap dots | Click any dot to jump to that event |

---

## Settings

Open **Settings → Vault Timeline** to configure the plugin.

| Setting | Default | Description |
|---|---|---|
| Date YAML field | `date` | Frontmatter key used as the event date |
| End date YAML field | `endDate` | Optional frontmatter key for the event end date (enables duration bars) |
| Exclude folders | *(empty)* | Comma-separated folder paths to skip (e.g. `Templates, Archive`) |
| Filter tags | *(empty)* | Only include notes that have at least one of these tags; leave empty for all notes |
| Default zoom level | `Month` | The zoom level shown when the timeline first opens |
| Show excerpts in tooltips | on | Whether to display note text previews in hover tooltips |
| Auto-refresh on vault changes | on | Automatically re-index when notes are added, edited, or deleted |
| Color groups | see below | Map tag names to hex colors |

### Default color groups

| Tag | Color |
|---|---|
| `project` | `#4A90E2` (blue) |
| `milestone` | `#E2844A` (orange) |
| `journal` | `#50E3C2` (teal) |
| `task` | `#B8E24A` (lime) |

You can add, edit, or remove color groups in the settings panel. The first matching group color is applied to each event.

---

## Commands

| Command | Description |
|---|---|
| `Open Vault Timeline` | Opens (or focuses) the timeline view |
| `Re-index Vault Timeline` | Forces a full re-scan of all notes |

---

## Development

Requirements: **Node.js 18+**

```bash
# Clone into your vault's plugin directory
git clone https://github.com/your-username/vault-timeline .obsidian/plugins/vault-timeline
cd .obsidian/plugins/vault-timeline

# Install dependencies
npm install

# Development build with watch
npm run dev

# Production build
npm run build
```

The plugin is written in TypeScript and uses the standard [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api).

---

## Contributing

Pull requests and issues are welcome. Please open an issue before submitting large changes so we can discuss the approach first.

---

## License

[MIT](LICENSE)
