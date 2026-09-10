import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const INVERSE_ON = "\x1b[7m";

function diffBlock(removed: string[], added: string[]): string {
	const lines: string[] = [];
	for (let idx = 0; idx < removed.length; idx++) lines.push(`-${idx + 1} ${removed[idx]}`);
	for (let idx = 0; idx < added.length; idx++) lines.push(`+${idx + 1} ${added[idx]}`);
	return lines.join("\n");
}

describe("renderDiff", () => {
	beforeAll(() => {
		// theme.inverse() goes through chalk, which disables all styling under a
		// non-TTY test runner unless forced; theme.fg() bypasses chalk with raw
		// truecolor codes so it isn't affected. Force color so inverse-highlight
		// assertions below reflect real terminal behavior.
		chalk.level = 3;
		initTheme("dark");
	});

	describe("multi-line pairing", () => {
		it("pairs same-length replace blocks positionally and highlights each pair", () => {
			const text = diffBlock(
				["const fooValue = 1;", "const barValue = 2;"],
				["const fooValue = 10;", "const barValue = 20;"],
			);
			const rendered = renderDiff(text);
			const lines = rendered.split("\n");
			expect(lines).toHaveLength(4);
			// Interleaved: removed[0], added[0], removed[1], added[1]
			expect(stripAnsi(lines[0])).toBe("-1 const fooValue = 1;");
			expect(stripAnsi(lines[1])).toBe("+1 const fooValue = 10;");
			expect(stripAnsi(lines[2])).toBe("-2 const barValue = 2;");
			expect(stripAnsi(lines[3])).toBe("+2 const barValue = 20;");
			for (const line of lines) expect(line).toContain(INVERSE_ON);
		});

		it("pairs only the aligned prefix when block lengths differ, rest falls back to plain", () => {
			const text = diffBlock(
				["const value = 1;", "totally unrelated old line one", "totally unrelated old line two"],
				["const value = 10;"],
			);
			const rendered = renderDiff(text);
			const lines = rendered.split("\n");
			// pair (0,0) rendered first, then leftover unpaired removed lines
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain(INVERSE_ON);
			expect(lines[1]).toContain(INVERSE_ON);
			expect(stripAnsi(lines[2])).toBe("-2 totally unrelated old line one");
			expect(stripAnsi(lines[3])).toBe("-3 totally unrelated old line two");
			expect(lines[2]).not.toContain(INVERSE_ON);
			expect(lines[3]).not.toContain(INVERSE_ON);
		});

		it("skips pairing entirely for blocks above the size cap", () => {
			const removed = Array.from({ length: 35 }, (_, i) => `value${i} = ${i};`);
			const added = Array.from({ length: 35 }, (_, i) => `value${i} = ${i + 1};`);
			const rendered = renderDiff(diffBlock(removed, added));
			expect(rendered).not.toContain(INVERSE_ON);
			const lines = rendered.split("\n");
			expect(lines).toHaveLength(70);
			// today's plain-block order: all removed, then all added
			expect(stripAnsi(lines[0])).toBe("-1 value0 = 0;");
			expect(stripAnsi(lines[34])).toBe("-35 value34 = 34;");
			expect(stripAnsi(lines[35])).toBe("+1 value0 = 1;");
		});
	});

	describe("similarity gate", () => {
		it("does not pair positionally-adjacent but unrelated lines", () => {
			const text = diffBlock(["function alpha() { return 1; }"], ["totally different content, no overlap xyz"]);
			const rendered = renderDiff(text);
			expect(rendered).not.toContain(INVERSE_ON);
		});

		it("skips pairing for lines beyond the intraline length guard", () => {
			const base = "x".repeat(2500);
			const removed = `${base}a`;
			const added = `${base}b`;
			const rendered = renderDiff(diffBlock([removed], [added]));
			expect(rendered).not.toContain(INVERSE_ON);
		});
	});

	describe("lang option", () => {
		it("does not affect visible text, only styling", () => {
			const text = diffBlock(["const fooValue = 1;", "unrelated old line"], ["const fooValue = 10;"]);
			const plain = renderDiff(text);
			const highlighted = renderDiff(text, { lang: "typescript" });
			expect(stripAnsi(highlighted)).toBe(stripAnsi(plain));
		});

		it("does not crash and stays ANSI-balanced for an unsupported language id", () => {
			const text = diffBlock(["const fooValue = 1;"], ["const fooValue = 10;"]);
			const rendered = renderDiff(text, { lang: "not-a-real-language" });
			expect(stripAnsi(rendered)).toBe(stripAnsi(renderDiff(text)));
		});

		it("never highlights the collapsed-gap marker as code", () => {
			const text = " 10 ...";
			const rendered = renderDiff(text, { lang: "typescript" });
			expect(stripAnsi(rendered)).toBe(" 10 ...");
		});

		it("returns no visible content for an empty diff", () => {
			expect(stripAnsi(renderDiff("", { lang: "typescript" }))).toBe("");
		});
	});

	describe("ANSI-safe splicing", () => {
		it("renders correctly through a real terminal emulator", async () => {
			const text = diffBlock(
				["const fooValue = 1;", "const barValue = 2;"],
				["const fooValue = 10;", "const barValue = 20;"],
			);
			const rendered = renderDiff(text, { lang: "typescript" });

			const terminal = new VirtualTerminal(120, 10);
			const tui = new TuiMainScreen(terminal);
			tui.addChild(new Text(rendered, 0, 0));
			tui.start();
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("const fooValue = 10;");
			expect(viewport).toContain("const barValue = 20;");
		});
	});
});
