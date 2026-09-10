import { type Component, sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffDisplayStyle } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { type DiffRow, type DiffRowCell, parseDiffIntoRows, renderDiff } from "./diff.ts";

const DEFAULT_MIN_SPLIT_WIDTH = 100;
/** " │ " between columns. */
const COLUMN_GAP = 3;

export interface SplitDiffViewOptions {
	lang?: string;
	/** Preferred display style; "auto" decides per `render()` call based on width. Default: "auto". */
	style?: DiffDisplayStyle;
	/** Terminal-width threshold at/above which "auto" renders split instead of unified. Default: 100. */
	minSplitWidth?: number;
	/** Left/right padding cells, matching the `Text` component this replaces at each call site. Default: 0. */
	paddingX?: number;
}

function padOrTruncate(content: string, width: number): string {
	if (width <= 0) return "";
	const truncated = sliceByColumn(content, 0, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function renderCell(
	prefix: string,
	cell: DiffRowCell | undefined,
	colorKey: "toolDiffRemoved" | "toolDiffAdded" | "toolDiffContext",
	width: number,
): string {
	if (!cell) return " ".repeat(Math.max(0, width));
	const rendered = theme.fg(colorKey, `${prefix}${cell.lineNum} `) + cell.content;
	return padOrTruncate(rendered, width);
}

/**
 * A side-by-side (old | new) diff view. Falls back to the unified `renderDiff` rendering below
 * `minSplitWidth` (or when `style` is "unified"), since two truncated narrow columns read worse
 * than one full-width column with wrapping. Terminal width is only known at `render()` time, so the
 * unified/split decision is made there rather than at construction.
 *
 * Each side truncates content to its column width rather than wrapping, so rows stay aligned
 * old-to-new; wrapping would desync the two columns' line counts.
 */
export class SplitDiffView implements Component {
	private diffText: string;
	private lang: string | undefined;
	private style: DiffDisplayStyle;
	private minSplitWidth: number;
	private paddingX: number;
	private rows: DiffRow[] = [];
	private unifiedView: Text;

	constructor(diffText: string, options: SplitDiffViewOptions = {}) {
		this.diffText = diffText;
		this.lang = options.lang;
		this.style = options.style ?? "auto";
		this.minSplitWidth = options.minSplitWidth ?? DEFAULT_MIN_SPLIT_WIDTH;
		this.paddingX = options.paddingX ?? 0;
		this.unifiedView = new Text("", this.paddingX, 0);
		this.applyDiff();
	}

	private applyDiff(): void {
		this.rows = parseDiffIntoRows(this.diffText, this.lang);
		this.unifiedView.setText(renderDiff(this.diffText, { lang: this.lang }));
	}

	setDiff(diffText: string, lang?: string): void {
		if (diffText === this.diffText && lang === this.lang) return;
		this.diffText = diffText;
		this.lang = lang;
		this.applyDiff();
	}

	setStyle(style: DiffDisplayStyle): void {
		this.style = style;
	}

	invalidate(): void {
		this.unifiedView.invalidate();
	}

	private shouldSplit(width: number): boolean {
		if (this.style === "unified") return false;
		// Even an explicit "split" choice needs a usable floor - below it, two columns are unreadable.
		if (this.style === "split") return width >= 40;
		return width >= this.minSplitWidth;
	}

	private renderSplit(width: number): string[] {
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const rowWidth = Math.max(1, width - paddingX * 2);
		const contentWidth = Math.max(0, rowWidth - COLUMN_GAP);
		const leftWidth = Math.ceil(contentWidth / 2);
		const rightWidth = Math.max(0, contentWidth - leftWidth);
		const margin = " ".repeat(paddingX);
		const separator = ` ${theme.fg("muted", "│")} `;

		const lines: string[] = [];
		for (const row of this.rows) {
			if (row.role === "raw") {
				lines.push(margin + padOrTruncate(theme.fg("toolDiffContext", row.raw), rowWidth) + margin);
				continue;
			}
			const oldCell = row.role === "added" ? undefined : row.old;
			const newCell = row.role === "removed" ? undefined : row.new;
			const oldColor = row.role === "context" ? "toolDiffContext" : "toolDiffRemoved";
			const newColor = row.role === "context" ? "toolDiffContext" : "toolDiffAdded";
			const oldPrefix = row.role === "context" ? " " : "-";
			const newPrefix = row.role === "context" ? " " : "+";
			const left = renderCell(oldPrefix, oldCell, oldColor, leftWidth);
			const right = renderCell(newPrefix, newCell, newColor, rightWidth);
			lines.push(margin + left + separator + right + margin);
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.shouldSplit(width)) return this.renderSplit(width);
		return this.unifiedView.render(width);
	}
}
