import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { highlightCode, theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

/**
 * Splice inverse-video highlighting for changed word spans into an already
 * syntax-highlighted (ANSI-colored) line, without disturbing its embedded
 * color codes.
 *
 * The change spans are computed against the plain (unhighlighted) old/new
 * content, in visible-column space, then sliced out of `highlightedLine` with
 * the same column offsets. This works because `highlightCode` only recolors
 * existing characters (via scoped `theme.fg()` codes, never a full `\x1b[0m`
 * reset) and never inserts/removes visible characters, so a plain-text
 * column offset always lands on the same visible character in the
 * highlighted line.
 */
function spliceHighlightedWordDiff(
	highlightedLine: string,
	plainOld: string,
	plainNew: string,
	role: "old" | "new",
): string {
	const wordDiff = Diff.diffWords(plainOld, plainNew);
	const spans: Array<{ start: number; length: number }> = [];
	let col = 0;
	let strippedLeadingWs = false;

	for (const part of wordDiff) {
		const relevant = role === "old" ? part.removed : part.added;
		const foreign = role === "old" ? part.added : part.removed;
		if (foreign) continue;

		let value = part.value;
		if (relevant) {
			if (!strippedLeadingWs) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				if (leadingWs) {
					col += visibleWidth(leadingWs);
					value = value.slice(leadingWs.length);
				}
				strippedLeadingWs = true;
			}
			const width = visibleWidth(value);
			if (width > 0) spans.push({ start: col, length: width });
			col += width;
		} else {
			col += visibleWidth(value);
		}
	}

	if (spans.length === 0) return highlightedLine;

	const lineWidth = visibleWidth(highlightedLine);
	let result = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) result += sliceByColumn(highlightedLine, cursor, span.start - cursor);
		result += theme.inverse(sliceByColumn(highlightedLine, span.start, span.length));
		cursor = span.start + span.length;
	}
	if (cursor < lineWidth) result += sliceByColumn(highlightedLine, cursor, lineWidth - cursor);
	return result;
}

/** Syntax-highlight a run of contiguous same-role lines as one block, so the
 * highlighter keeps lexer context (e.g. across a multi-line string) instead
 * of re-tokenizing every line in isolation. Falls back to unstyled content
 * if highlightCode ever returns fewer lines than given (should not happen in
 * practice since it round-trips a single `\n`-join). */
function highlightRun(contents: string[], lang: string): string[] {
	if (contents.length === 0) return [];
	const highlighted = highlightCode(contents.join("\n"), lang);
	return contents.map((content, idx) => highlighted[idx] ?? theme.fg("toolOutput", content));
}

const MIN_PAIR_SIMILARITY = 0.4;
const MAX_PAIRING_BLOCK_SIZE = 30;
/** Diff.diffChars/diffWords are effectively quadratic in pathological cases
 * (e.g. a long minified single-line blob edited in two places). Lines longer
 * than this render as plain unpaired removed/added lines instead of paying
 * for intra-line diffing. */
const MAX_INTRALINE_LENGTH = 2000;

interface DiffBlockLine {
	lineNum: string;
	content: string;
}

/** Character-overlap ratio between two lines, via the already-installed `diff`
 * package's diffChars. Used only to decide whether two positionally-aligned
 * lines in a replace block are "the same line, edited" (worth word-diffing)
 * or unrelated (better shown as plain removed/added lines). */
function lineSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	let common = 0;
	for (const part of Diff.diffChars(a, b)) {
		if (!part.added && !part.removed) common += part.value.length;
	}
	return common / maxLen;
}

/**
 * Pair lines in a replace block (N removed lines followed by M added lines)
 * for intra-line highlighting. Pairs are positional (removed[i] <-> added[i]),
 * matching how Python's difflib.Differ handles replace groups: lines in a
 * replace block have no independent identity to align by content, so
 * position is the only signal a reader expects. Gated by a similarity
 * threshold so unrelated positionally-adjacent lines (e.g. N != M shifting
 * alignment) fall back to plain rendering instead of a mostly-inverted line.
 * Blocks larger than MAX_PAIRING_BLOCK_SIZE skip pairing entirely, as a guard
 * against many diffChars calls on a pathologically large single replace
 * block (e.g. a full-file rewrite).
 */
function pairReplaceBlockLines(
	removedLines: DiffBlockLine[],
	addedLines: DiffBlockLine[],
): { pairs: Array<[number, number]>; unpairedRemoved: number[]; unpairedAdded: number[] } {
	const pairs: Array<[number, number]> = [];
	const unpairedRemoved: number[] = [];
	const unpairedAdded: number[] = [];

	if (Math.max(removedLines.length, addedLines.length) > MAX_PAIRING_BLOCK_SIZE) {
		for (let idx = 0; idx < removedLines.length; idx++) unpairedRemoved.push(idx);
		for (let idx = 0; idx < addedLines.length; idx++) unpairedAdded.push(idx);
		return { pairs, unpairedRemoved, unpairedAdded };
	}

	const pairCount = Math.min(removedLines.length, addedLines.length);
	for (let idx = 0; idx < pairCount; idx++) {
		const removedContent = removedLines[idx].content;
		const addedContent = addedLines[idx].content;
		const tooLong = removedContent.length > MAX_INTRALINE_LENGTH || addedContent.length > MAX_INTRALINE_LENGTH;
		if (!tooLong && lineSimilarity(removedContent, addedContent) >= MIN_PAIR_SIMILARITY) {
			pairs.push([idx, idx]);
		} else {
			unpairedRemoved.push(idx);
			unpairedAdded.push(idx);
		}
	}
	for (let idx = pairCount; idx < removedLines.length; idx++) unpairedRemoved.push(idx);
	for (let idx = pairCount; idx < addedLines.length; idx++) unpairedAdded.push(idx);

	return { pairs, unpairedRemoved, unpairedAdded };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
	/** Language id (as returned by getLanguageFromPath) to syntax-highlight line content with. */
	lang?: string;
}

/** One cell of a diff row: a line number plus already-highlighted (syntax + intra-line word-diff,
 * still gutter-free) content. */
export interface DiffRowCell {
	lineNum: string;
	content: string;
}

/**
 * One logical row of a parsed diff, shared by unified and split rendering.
 * - "context": unchanged line, identical `old`/`new` cells.
 * - "pair": a positionally-paired replace-block line, `old` is the removed side and `new` the added side.
 * - "removed" / "added": an unpaired line from a replace block, or a standalone `+`/`-` run.
 * - "raw": a line that didn't match the expected diff-line format, kept verbatim for graceful degradation.
 */
export type DiffRow =
	| { role: "context"; old: DiffRowCell; new: DiffRowCell }
	| { role: "pair"; old: DiffRowCell; new: DiffRowCell }
	| { role: "removed"; old: DiffRowCell }
	| { role: "added"; new: DiffRowCell }
	| { role: "raw"; raw: string };

/**
 * Parse a diff string into structured rows: pairing, syntax highlighting, and intra-line word-diff
 * are all resolved here, so both `renderDiff` (unified) and `SplitDiffView` (side-by-side) render the
 * same underlying data instead of re-parsing the diff text independently.
 */
export function parseDiffIntoRows(diffText: string, lang?: string): DiffRow[] {
	const lines = diffText.split("\n");
	const rows: DiffRow[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			rows.push({ role: "raw", raw: line });
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: DiffBlockLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: replaceTabs(p.content) });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: DiffBlockLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: replaceTabs(p.content) });
				i++;
			}

			const highlightedRemoved = lang
				? highlightRun(
						removedLines.map((l) => l.content),
						lang,
					)
				: undefined;
			const highlightedAdded = lang
				? highlightRun(
						addedLines.map((l) => l.content),
						lang,
					)
				: undefined;

			const { pairs, unpairedRemoved, unpairedAdded } = pairReplaceBlockLines(removedLines, addedLines);

			for (const [ri, ai] of pairs) {
				const removed = removedLines[ri];
				const added = addedLines[ai];

				let oldContent: string;
				let newContent: string;
				if (highlightedRemoved && highlightedAdded) {
					oldContent = spliceHighlightedWordDiff(highlightedRemoved[ri], removed.content, added.content, "old");
					newContent = spliceHighlightedWordDiff(highlightedAdded[ai], removed.content, added.content, "new");
				} else {
					const { removedLine, addedLine } = renderIntraLineDiff(removed.content, added.content);
					oldContent = removedLine;
					newContent = addedLine;
				}
				rows.push({
					role: "pair",
					old: { lineNum: removed.lineNum, content: oldContent },
					new: { lineNum: added.lineNum, content: newContent },
				});
			}

			for (const ri of unpairedRemoved) {
				const removed = removedLines[ri];
				rows.push({
					role: "removed",
					old: { lineNum: removed.lineNum, content: highlightedRemoved ? highlightedRemoved[ri] : removed.content },
				});
			}
			for (const ai of unpairedAdded) {
				const added = addedLines[ai];
				rows.push({
					role: "added",
					new: { lineNum: added.lineNum, content: highlightedAdded ? highlightedAdded[ai] : added.content },
				});
			}
		} else if (parsed.prefix === "+") {
			// Collect consecutive standalone added lines (no preceding removed run)
			const addedLines: DiffBlockLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: replaceTabs(p.content) });
				i++;
			}
			const highlighted = lang
				? highlightRun(
						addedLines.map((l) => l.content),
						lang,
					)
				: undefined;
			for (let idx = 0; idx < addedLines.length; idx++) {
				const added = addedLines[idx];
				rows.push({
					role: "added",
					new: { lineNum: added.lineNum, content: highlighted ? highlighted[idx] : added.content },
				});
			}
		} else {
			// Context line. The "..." collapsed-gap marker is never syntax-highlighted.
			const content = replaceTabs(parsed.content);
			const isGapMarker = parsed.lineNum.trim() === "" && content === "...";
			const rendered =
				lang && !isGapMarker ? (highlightCode(content, lang)[0] ?? theme.fg("toolDiffContext", content)) : content;
			rows.push({
				role: "context",
				old: { lineNum: parsed.lineNum, content: rendered },
				new: { lineNum: parsed.lineNum, content: rendered },
			});
			i++;
		}
	}

	return rows;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 * When `options.lang` is set, line content is syntax-highlighted and only the
 * `+`/`-`/` ` gutter (prefix + line number) carries the diff role color, so
 * syntax colors stay legible instead of being overridden by a uniform
 * red/green line color.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const rows = parseDiffIntoRows(diffText, options.lang);
	const result: string[] = [];

	for (const row of rows) {
		switch (row.role) {
			case "raw":
				result.push(theme.fg("toolDiffContext", row.raw));
				break;
			case "context":
				result.push(theme.fg("toolDiffContext", ` ${row.old.lineNum} `) + row.old.content);
				break;
			case "pair":
				result.push(theme.fg("toolDiffRemoved", `-${row.old.lineNum} `) + row.old.content);
				result.push(theme.fg("toolDiffAdded", `+${row.new.lineNum} `) + row.new.content);
				break;
			case "removed":
				result.push(theme.fg("toolDiffRemoved", `-${row.old.lineNum} `) + row.old.content);
				break;
			case "added":
				result.push(theme.fg("toolDiffAdded", `+${row.new.lineNum} `) + row.new.content);
				break;
		}
	}

	return result.join("\n");
}
