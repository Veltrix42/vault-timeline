import {
	App,
	ItemView,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
} from "obsidian";

// ─────────────────────────────────────────────
//  Types & Interfaces
// ─────────────────────────────────────────────

export interface TimelineEvent {
	id: string;           // file path
	title: string;
	date: number;         // Unix ms
	endDate?: number;
	tags: string[];
	excerpt: string;
	icon?: string;
	folder: string;
}

export interface TimelineIndex {
	version: number;
	events: TimelineEvent[];
	lastIndexed: number;
}

export interface VaultTimelineSettings {
	dateField: string;          // YAML field for date
	endDateField: string;       // YAML field for end date
	includeFolders: string[];   // empty = all
	excludeFolders: string[];
	filterTags: string[];       // empty = all
	orientation: "horizontal" | "vertical";
	defaultZoom: "day" | "week" | "month" | "year" | "decade";
	colorGroups: ColorGroup[];
	showExcerpt: boolean;
	excerptLength: number;
	autoRefresh: boolean;
}

export interface ColorGroup {
	tag: string;
	color: string;
}

const DEFAULT_SETTINGS: VaultTimelineSettings = {
	dateField: "date",
	endDateField: "endDate",
	includeFolders: [],
	excludeFolders: [],
	filterTags: [],
	orientation: "horizontal",
	defaultZoom: "month",
	colorGroups: [
		{ tag: "project", color: "#4A90E2" },
		{ tag: "milestone", color: "#E2844A" },
		{ tag: "journal", color: "#50E3C2" },
		{ tag: "task", color: "#B8E24A" },
	],
	showExcerpt: true,
	excerptLength: 120,
	autoRefresh: true,
};

const VIEW_TYPE_TIMELINE = "vault-timeline-view";

// ─────────────────────────────────────────────
//  Date Parsing Helpers
// ─────────────────────────────────────────────

const DATE_PATTERNS: RegExp[] = [
	/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/,
	/^\d{2}[.\/]\d{2}[.\/]\d{4}/,
	/^\d{4}\/\d{2}\/\d{2}/,
];

function parseDate(value: unknown): number | null {
	if (!value) return null;
	if (typeof value === "number") return value;
	const str = String(value).trim();
	for (const pattern of DATE_PATTERNS) {
		if (pattern.test(str)) {
			const ts = Date.parse(str.replace(/\./g, "-").replace(/\//g, "-"));
			if (!isNaN(ts)) return ts;
		}
	}
	return null;
}

function extractExcerpt(content: string, maxLen: number): string {
	// Remove frontmatter
	const body = content.replace(/^---[\s\S]*?---\n/, "").trim();
	// Remove markdown syntax
	const plain = body
		.replace(/#+\s/g, "")
		.replace(/\*\*|__|\*|_|~~|`{1,3}/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
		.replace(/\n+/g, " ")
		.trim();
	return plain.length > maxLen ? plain.slice(0, maxLen) + "…" : plain;
}

// ─────────────────────────────────────────────
//  Indexer
// ─────────────────────────────────────────────

export class VaultIndexer {
	constructor(
		private app: App,
		private settings: VaultTimelineSettings
	) {}

	async indexAll(): Promise<TimelineEvent[]> {
		const files = this.app.vault.getMarkdownFiles();
		const events: TimelineEvent[] = [];

		for (const file of files) {
			const event = await this.indexFile(file);
			if (event) events.push(event);
		}

		events.sort((a, b) => a.date - b.date);
		return events;
	}

	async indexFile(file: TFile): Promise<TimelineEvent | null> {
		const { settings } = this;

		// Folder filter
		const folder = file.parent?.path || "";
		if (
			settings.includeFolders.length > 0 &&
			!settings.includeFolders.some((f) => folder.startsWith(f))
		) {
			return null;
		}
		if (settings.excludeFolders.some((f) => folder.startsWith(f))) {
			return null;
		}

		const metadata = this.app.metadataCache.getFileCache(file);
		const frontmatter = metadata?.frontmatter ?? {};

		// Tag filter
		const fileTags: string[] = [
			...(metadata?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
			...(frontmatter.tags ?? []),
		];
		if (
			settings.filterTags.length > 0 &&
			!settings.filterTags.some((t) => fileTags.includes(t))
		) {
			return null;
		}

		// Date resolution: YAML field > file ctime
		let date: number | null = parseDate(frontmatter[settings.dateField]);
		if (!date) {
			date = file.stat.ctime;
		}

		const endDate = parseDate(frontmatter[settings.endDateField]) ?? undefined;

		// Read content for excerpt (skip if file is large)
		let excerpt = "";
		if (settings.showExcerpt && file.stat.size < 512_000) {
			try {
				const content = await this.app.vault.cachedRead(file);
				excerpt = extractExcerpt(content, settings.excerptLength);
			} catch {
				// ignore
			}
		}

		return {
			id: file.path,
			title: frontmatter.title || file.basename,
			date,
			endDate,
			tags: fileTags,
			excerpt,
			icon: frontmatter.icon,
			folder,
		};
	}
}

// ─────────────────────────────────────────────
//  Timeline View
// ─────────────────────────────────────────────

export class TimelineView extends ItemView {
	private index: TimelineEvent[] = [];
	private filteredEvents: TimelineEvent[] = [];
	private settings: VaultTimelineSettings;
	private plugin: VaultTimelinePlugin;

	// View state
	private zoom: "day" | "week" | "month" | "year" | "decade" = "month";
	private viewStart: Date = new Date();
	private activeTag: string = "";
	private searchQuery: string = "";
	private tooltip: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultTimelinePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = plugin.settings;
		this.zoom = this.settings.defaultZoom;
	}

	getViewType() {
		return VIEW_TYPE_TIMELINE;
	}

	getDisplayText() {
		return "Vault Timeline";
	}

	getIcon() {
		return "calendar-clock";
	}

	async onOpen() {
		await this.refresh();
	}

	async onClose() {
		if (this.tooltip) this.tooltip.remove();
	}

	async refresh() {
		this.index = this.plugin.index;
		this.applyFilters();
		this.render();
	}

	private applyFilters() {
		let events = [...this.index];

		if (this.activeTag) {
			events = events.filter((e) => e.tags.includes(this.activeTag));
		}

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			events = events.filter(
				(e) =>
					e.title.toLowerCase().includes(q) ||
					e.excerpt.toLowerCase().includes(q) ||
					e.tags.some((t) => t.toLowerCase().includes(q))
			);
		}

		this.filteredEvents = events;
	}

	private getZoomMs(): number {
		switch (this.zoom) {
			case "day":
				return 86_400_000;
			case "week":
				return 7 * 86_400_000;
			case "month":
				return 30 * 86_400_000;
			case "year":
				return 365 * 86_400_000;
			case "decade":
				return 3650 * 86_400_000;
		}
	}

	private getTagColor(tags: string[]): string {
		for (const group of this.settings.colorGroups) {
			if (tags.includes(group.tag)) return group.color;
		}
		return "var(--vt-accent)";
	}

	private getAllTags(): string[] {
		const tagSet = new Set<string>();
		for (const e of this.index) {
			for (const t of e.tags) tagSet.add(t);
		}
		return Array.from(tagSet).sort();
	}

	private render() {
		const container = this.containerEl;
		container.empty();
		container.addClass("vt-root");

		this.renderToolbar(container);

		if (this.filteredEvents.length === 0) {
			this.renderEmpty(container);
			return;
		}

		const wrapper = container.createDiv({ cls: "vt-timeline-wrapper" });
		this.renderTimeline(wrapper);
	}

	private renderEmpty(container: HTMLElement) {
		const empty = container.createDiv({ cls: "vt-empty" });
		empty.createEl("div", { cls: "vt-empty-icon", text: "⏳" });
		empty.createEl("h3", { text: "No events found" });
		empty.createEl("p", {
			text: "Add dates to your notes' frontmatter or adjust filters.",
		});
	}

	private renderToolbar(container: HTMLElement) {
		const toolbar = container.createDiv({ cls: "vt-toolbar" });

		// Title
		toolbar.createEl("span", { cls: "vt-toolbar-title", text: "Vault Timeline" });

		// Search
		const searchWrap = toolbar.createDiv({ cls: "vt-search-wrap" });
		const searchInput = searchWrap.createEl("input", {
			cls: "vt-search",
			type: "text",
			placeholder: "Search events…",
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener(
			"input",
			debounce(() => {
				this.searchQuery = searchInput.value;
				this.applyFilters();
				this.render();
			}, 250)
		);

		// Tag filter
		const tags = this.getAllTags();
		if (tags.length > 0) {
			const tagSelect = toolbar.createEl("select", { cls: "vt-tag-select" });
			tagSelect.createEl("option", { value: "", text: "All tags" });
			for (const tag of tags) {
				const opt = tagSelect.createEl("option", { value: tag, text: `#${tag}` });
				if (tag === this.activeTag) opt.selected = true;
			}
			tagSelect.addEventListener("change", () => {
				this.activeTag = tagSelect.value;
				this.applyFilters();
				this.render();
			});
		}

		// Zoom buttons
		const zoomGroup = toolbar.createDiv({ cls: "vt-zoom-group" });
		for (const z of ["day", "week", "month", "year", "decade"] as const) {
			const btn = zoomGroup.createEl("button", {
				cls: `vt-zoom-btn ${this.zoom === z ? "active" : ""}`,
				text: z.charAt(0).toUpperCase() + z.slice(1),
			});
			btn.addEventListener("click", () => {
				this.zoom = z;
				this.render();
			});
		}

		// Nav buttons
		const navGroup = toolbar.createDiv({ cls: "vt-nav-group" });

		const prevBtn = navGroup.createEl("button", { cls: "vt-nav-btn", text: "‹" });
		prevBtn.addEventListener("click", () => {
			this.viewStart = new Date(this.viewStart.getTime() - this.getZoomMs());
			this.render();
		});

		const todayBtn = navGroup.createEl("button", { cls: "vt-nav-btn vt-today-btn", text: "Today" });
		todayBtn.addEventListener("click", () => {
			this.viewStart = new Date();
			this.render();
		});

		const nextBtn = navGroup.createEl("button", { cls: "vt-nav-btn", text: "›" });
		nextBtn.addEventListener("click", () => {
			this.viewStart = new Date(this.viewStart.getTime() + this.getZoomMs());
			this.render();
		});

		// Stats
		const stats = toolbar.createDiv({ cls: "vt-stats" });
		stats.createEl("span", {
			text: `${this.filteredEvents.length} events`,
		});
	}

	private renderTimeline(container: HTMLElement) {
		const zoomMs = this.getZoomMs();
		const viewEndMs = this.viewStart.getTime() + zoomMs;
		const viewStartMs = this.viewStart.getTime() - zoomMs; // show wider range

		// Find events in visible window (±1 window)
		const visibleEvents = this.filteredEvents.filter(
			(e) => e.date >= viewStartMs && e.date <= viewEndMs
		);

		// Timeline container
		const timeline = container.createDiv({ cls: "vt-timeline" });

		// Axis
		this.renderAxis(timeline, viewStartMs, viewEndMs);

		// Events
		const eventsTrack = timeline.createDiv({ cls: "vt-events-track" });

		for (const event of visibleEvents) {
			this.renderEvent(eventsTrack, event, viewStartMs, viewEndMs);
		}

		// Show all-time mini-map
		this.renderMinimap(container);

		// "Jump to first/last" if none visible
		if (visibleEvents.length === 0 && this.filteredEvents.length > 0) {
			const hint = container.createDiv({ cls: "vt-no-visible" });
			hint.createEl("p", { text: "No events in this range." });

			const closest = this.findClosestEvent();
			if (closest) {
				const jumpBtn = hint.createEl("button", {
					cls: "vt-jump-btn",
					text: `Jump to nearest event: ${new Date(closest.date).toLocaleDateString()}`,
				});
				jumpBtn.addEventListener("click", () => {
					this.viewStart = new Date(closest.date);
					this.render();
				});
			}
		}
	}

	private renderAxis(container: HTMLElement, startMs: number, endMs: number) {
		const axis = container.createDiv({ cls: "vt-axis" });
		const totalMs = endMs - startMs;
		const tickCount = 8;

		for (let i = 0; i <= tickCount; i++) {
			const ms = startMs + (totalMs / tickCount) * i;
			const date = new Date(ms);
			const pct = (i / tickCount) * 100;

			const tick = axis.createDiv({ cls: "vt-axis-tick" });
			tick.style.left = `${pct}%`;

			const label = tick.createEl("span", { cls: "vt-axis-label" });
			label.setText(this.formatAxisDate(date));
		}

		// Today line
		const nowMs = Date.now();
		if (nowMs >= startMs && nowMs <= endMs) {
			const nowPct = ((nowMs - startMs) / totalMs) * 100;
			const nowLine = axis.createDiv({ cls: "vt-now-line" });
			nowLine.style.left = `${nowPct}%`;
			nowLine.createEl("span", { cls: "vt-now-label", text: "Now" });
		}
	}

	private formatAxisDate(date: Date): string {
		switch (this.zoom) {
			case "day":
				return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			case "week":
				return date.toLocaleDateString([], { weekday: "short", day: "numeric" });
			case "month":
				return date.toLocaleDateString([], { day: "numeric", month: "short" });
			case "year":
				return date.toLocaleDateString([], { month: "short" });
			case "decade":
				return String(date.getFullYear());
		}
	}

	private renderEvent(
		container: HTMLElement,
		event: TimelineEvent,
		startMs: number,
		endMs: number
	) {
		const totalMs = endMs - startMs;
		const pct = ((event.date - startMs) / totalMs) * 100;
		const color = this.getTagColor(event.tags);

		const row = container.createDiv({ cls: "vt-event-row" });

		const dot = row.createDiv({ cls: "vt-event-dot" });
		dot.style.left = `${pct}%`;
		dot.style.setProperty("--dot-color", color);

		if (event.icon) {
			dot.createEl("span", { cls: "vt-event-icon", text: event.icon });
		}

		// Duration bar
		if (event.endDate) {
			const endPct = Math.min(100, ((event.endDate - startMs) / totalMs) * 100);
			const bar = row.createDiv({ cls: "vt-event-bar" });
			bar.style.left = `${pct}%`;
			bar.style.width = `${Math.max(0.5, endPct - pct)}%`;
			bar.style.setProperty("--bar-color", color);
		}

		// Label
		const label = row.createDiv({ cls: "vt-event-label" });
		label.style.left = `${pct}%`;
		label.createEl("span", { cls: "vt-event-date", text: this.formatEventDate(event.date) });
		label.createEl("span", { cls: "vt-event-title", text: event.title });
		if (event.tags.length > 0) {
			const tagsEl = label.createDiv({ cls: "vt-event-tags" });
			for (const tag of event.tags.slice(0, 3)) {
				const tagEl = tagsEl.createEl("span", { cls: "vt-tag-chip", text: `#${tag}` });
				tagEl.style.setProperty("--chip-color", this.getTagColor([tag]));
			}
		}

		// Tooltip & click
		const showTooltip = (e: MouseEvent) => this.showTooltip(e, event, color);
		const hideTooltip = () => this.hideTooltip();

		dot.addEventListener("mouseenter", showTooltip);
		dot.addEventListener("mouseleave", hideTooltip);
		label.addEventListener("mouseenter", showTooltip);
		label.addEventListener("mouseleave", hideTooltip);

		dot.addEventListener("click", () => this.openNote(event.id));
		label.addEventListener("click", () => this.openNote(event.id));

		// Context menu
		dot.addEventListener("contextmenu", (e: MouseEvent) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Open note")
					.setIcon("file-text")
					.onClick(() => this.openNote(event.id))
			);
			menu.addItem((item) =>
				item
					.setTitle("Go to this date")
					.setIcon("calendar")
					.onClick(() => {
						this.viewStart = new Date(event.date);
						this.render();
					})
			);
			menu.showAtMouseEvent(e);
		});
	}

	private formatEventDate(ms: number): string {
		const d = new Date(ms);
		switch (this.zoom) {
			case "day":
				return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			case "week":
			case "month":
				return d.toLocaleDateString([], { day: "numeric", month: "short" });
			default:
				return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
		}
	}

	private showTooltip(e: MouseEvent, event: TimelineEvent, color: string) {
		this.hideTooltip();

		const tip = document.createElement("div");
		tip.className = "vt-tooltip";
		tip.style.setProperty("--tip-color", color);

		tip.createEl("div", { cls: "vt-tip-title", text: event.title });
		tip.createEl("div", {
			cls: "vt-tip-date",
			text: new Date(event.date).toLocaleDateString([], {
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
			}),
		});

		if (event.excerpt) {
			tip.createEl("div", { cls: "vt-tip-excerpt", text: event.excerpt });
		}

		if (event.tags.length > 0) {
			const tagsEl = tip.createDiv({ cls: "vt-tip-tags" });
			for (const tag of event.tags) {
				tagsEl.createEl("span", { cls: "vt-tip-tag", text: `#${tag}` });
			}
		}

		tip.createEl("div", { cls: "vt-tip-hint", text: "Click to open · Right-click for menu" });

		document.body.appendChild(tip);
		this.tooltip = tip;

		const rect = (e.target as HTMLElement).getBoundingClientRect();
		const tipRect = tip.getBoundingClientRect();

		let left = rect.left + rect.width / 2 - tipRect.width / 2;
		let top = rect.top - tipRect.height - 10;

		// Clamp to viewport
		left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
		if (top < 8) top = rect.bottom + 10;

		tip.style.left = `${left}px`;
		tip.style.top = `${top}px`;
		tip.addClass("visible");
	}

	private hideTooltip() {
		if (this.tooltip) {
			this.tooltip.remove();
			this.tooltip = null;
		}
	}

	private renderMinimap(container: HTMLElement) {
		if (this.filteredEvents.length === 0) return;

		const minimap = container.createDiv({ cls: "vt-minimap" });
		minimap.createEl("div", { cls: "vt-minimap-label", text: "All events" });

		const track = minimap.createDiv({ cls: "vt-minimap-track" });

		const allMin = this.filteredEvents[0]!.date;
		const allMax = this.filteredEvents[this.filteredEvents.length - 1]!.date;
		const totalMs = allMax - allMin || 1;

		for (const event of this.filteredEvents) {
			const pct = ((event.date - allMin) / totalMs) * 100;
			const dot = track.createDiv({ cls: "vt-mini-dot" });
			dot.style.left = `${pct}%`;
			dot.style.setProperty("--dot-color", this.getTagColor(event.tags));
			dot.title = event.title;

			dot.addEventListener("click", () => {
				this.viewStart = new Date(event.date);
				this.render();
			});
		}

		// Viewport indicator
		const zoomMs = this.getZoomMs();
		const vpStart = this.viewStart.getTime() - zoomMs;
		const vpEnd = this.viewStart.getTime() + zoomMs;
		const vpLeft = Math.max(0, ((vpStart - allMin) / totalMs) * 100);
		const vpWidth = Math.min(100, ((vpEnd - vpStart) / totalMs) * 100);

		const vp = track.createDiv({ cls: "vt-mini-viewport" });
		vp.style.left = `${vpLeft}%`;
		vp.style.width = `${vpWidth}%`;
	}

	private findClosestEvent(): TimelineEvent | null {
		if (this.filteredEvents.length === 0) return null;
		const now = this.viewStart.getTime();
		return this.filteredEvents.reduce((a, b) =>
			Math.abs(a.date - now) < Math.abs(b.date - now) ? a : b
		);
	}

	private async openNote(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		}
	}
}

// ─────────────────────────────────────────────
//  Settings Tab
// ─────────────────────────────────────────────

class VaultTimelineSettingTab extends PluginSettingTab {
	plugin: VaultTimelinePlugin;

	constructor(app: App, plugin: VaultTimelinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vault Timeline Settings" });

		// Date field
		new Setting(containerEl)
			.setName("Date YAML field")
			.setDesc("Frontmatter field to use as event date (e.g. date, created)")
			.addText((text) =>
				text
					.setPlaceholder("date")
					.setValue(this.plugin.settings.dateField)
					.onChange(async (value) => {
						this.plugin.settings.dateField = value || "date";
						await this.plugin.saveSettings();
					})
			);

		// End date field
		new Setting(containerEl)
			.setName("End date YAML field")
			.setDesc("Optional: frontmatter field for event end date (for duration bars)")
			.addText((text) =>
				text
					.setPlaceholder("endDate")
					.setValue(this.plugin.settings.endDateField)
					.onChange(async (value) => {
						this.plugin.settings.endDateField = value || "endDate";
						await this.plugin.saveSettings();
					})
			);

		// Exclude folders
		new Setting(containerEl)
			.setName("Exclude folders")
			.setDesc("Comma-separated folder paths to exclude (e.g. Templates,Archive)")
			.addText((text) =>
				text
					.setPlaceholder("Templates, Archive")
					.setValue(this.plugin.settings.excludeFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludeFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		// Filter tags
		new Setting(containerEl)
			.setName("Filter tags (optional)")
			.setDesc("Only include notes with these tags (comma-separated). Leave empty for all notes.")
			.addText((text) =>
				text
					.setPlaceholder("timeline, project")
					.setValue(this.plugin.settings.filterTags.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.filterTags = value
							.split(",")
							.map((s) => s.trim().replace(/^#/, ""))
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		// Default zoom
		new Setting(containerEl)
			.setName("Default zoom level")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						day: "Day",
						week: "Week",
						month: "Month",
						year: "Year",
						decade: "Decade",
					})
					.setValue(this.plugin.settings.defaultZoom)
					.onChange(async (value) => {
						this.plugin.settings.defaultZoom = value as VaultTimelineSettings["defaultZoom"];
						await this.plugin.saveSettings();
					})
			);

		// Show excerpt
		new Setting(containerEl)
			.setName("Show excerpts in tooltips")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showExcerpt).onChange(async (value) => {
					this.plugin.settings.showExcerpt = value;
					await this.plugin.saveSettings();
				})
			);

		// Auto refresh
		new Setting(containerEl)
			.setName("Auto-refresh on vault changes")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
					this.plugin.settings.autoRefresh = value;
					await this.plugin.saveSettings();
				})
			);

		// Color groups
		containerEl.createEl("h3", { text: "Color Groups" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Assign colors to tags. The first matching tag color is used.",
		});

		for (let i = 0; i < this.plugin.settings.colorGroups.length; i++) {
			const group = this.plugin.settings.colorGroups[i]!;
			new Setting(containerEl)
				.setName(`Group ${i + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("tag name")
						.setValue(group.tag)
						.onChange(async (value) => {
							const g = this.plugin.settings.colorGroups[i];
							if (g) g.tag = value;
							await this.plugin.saveSettings();
						})
				)
				.addColorPicker((picker) =>
					picker.setValue(group.color).onChange(async (value) => {
						const g = this.plugin.settings.colorGroups[i];
						if (g) g.color = value;
						await this.plugin.saveSettings();
					})
				)
				.addButton((btn) =>
					btn.setIcon("trash").onClick(async () => {
						this.plugin.settings.colorGroups.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("+ Add color group")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.colorGroups.push({ tag: "", color: "#888888" });
					await this.plugin.saveSettings();
					this.display();
				})
		);

		// Re-index button
		containerEl.createEl("h3", { text: "Actions" });
		new Setting(containerEl)
			.setName("Re-index vault")
			.setDesc("Force a full re-scan of all notes.")
			.addButton((btn) =>
				btn
					.setButtonText("Re-index now")
					.setCta()
					.onClick(async () => {
						await this.plugin.reindex();
						new Notice("Vault Timeline: re-indexed successfully.");
					})
			);
	}
}

// ─────────────────────────────────────────────
//  Main Plugin
// ─────────────────────────────────────────────

export default class VaultTimelinePlugin extends Plugin {
	settings: VaultTimelineSettings = DEFAULT_SETTINGS;
	index: TimelineEvent[] = [];
	private indexer!: VaultIndexer;

	async onload() {
		await this.loadSettings();

		this.indexer = new VaultIndexer(this.app, this.settings);

		// Register view
		this.registerView(VIEW_TYPE_TIMELINE, (leaf) => new TimelineView(leaf, this));

		// Commands
		this.addCommand({
			id: "open-vault-timeline",
			name: "Open Vault Timeline",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "reindex-vault-timeline",
			name: "Re-index Vault Timeline",
			callback: async () => {
				await this.reindex();
				new Notice("Vault Timeline re-indexed.");
			},
		});

		// Ribbon icon
		this.addRibbonIcon("calendar-clock", "Open Vault Timeline", () => this.activateView());

		// Settings tab
		this.addSettingTab(new VaultTimelineSettingTab(this.app, this));

		// Initial index after layout ready
		this.app.workspace.onLayoutReady(async () => {
			await this.reindex();
			this.registerVaultEvents();
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TIMELINE);
	}

	private registerVaultEvents() {
		const refresh = debounce(async () => {
			if (!this.settings.autoRefresh) return;
			await this.reindex();
			this.refreshViews();
		}, 1000);

		this.registerEvent(this.app.vault.on("create", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.vault.on("modify", refresh));
		this.registerEvent(this.app.metadataCache.on("changed", refresh));
	}

	async reindex() {
		this.indexer = new VaultIndexer(this.app, this.settings);
		const events = await this.indexer.indexAll();
		this.index = events;
		await this.saveIndex();
		this.refreshViews();
	}

	private refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE)) {
			const view = leaf.view as TimelineView;
			view.refresh();
		}
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_TIMELINE)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_TIMELINE, active: true });
		}

		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as {
			settings?: VaultTimelineSettings;
			index?: TimelineEvent[];
		} | null;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
		this.index = saved?.index ?? [];
	}

	async saveSettings() {
		const saved = (await this.loadData()) as Record<string, unknown> | null ?? {};
		await this.saveData({ ...saved, settings: this.settings });
	}

	private async saveIndex() {
		const saved = (await this.loadData()) as Record<string, unknown> | null ?? {};
		await this.saveData({ ...saved, index: this.index });
	}
}
