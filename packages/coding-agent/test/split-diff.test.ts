import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { SplitDiffView } from "../src/modes/interactive/components/split-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function diffBlock(removed: string[], added: string[]): string {
	const lines: string[] = [];
	for (let idx = 0; idx < removed.length; idx++) lines.push(`-${idx + 1} ${removed[idx]}`);
	for (let idx = 0; idx < added.length; idx++) lines.push(`+${idx + 1} ${added[idx]}`);
	return lines.join("\n");
}

describe("SplitDiffView", () => {
	beforeAll(() => {
		chalk.level = 3;
		initTheme("dark");
	});

	describe("width threshold (auto style)", () => {
		it("renders unified below minSplitWidth and split at/above it", () => {
			const text = diffBlock(["const fooValue = 1;"], ["const fooValue = 10;"]);
			const view = new SplitDiffView(text, { style: "auto" });

			const narrow = stripAnsi(view.render(99).join("\n"));
			expect(narrow).not.toContain("│");
			expect(narrow).toContain("-1 const fooValue = 1;");
			expect(narrow).toContain("+1 const fooValue = 10;");

			const wide = view.render(100).map(stripAnsi);
			expect(wide.some((line) => line.includes("│"))).toBe(true);
			// Old and new content land on the SAME row, side by side.
			const row = wide.find((line) => line.includes("const fooValue"));
			expect(row).toBeDefined();
			expect(row).toContain("-1 const fooValue = 1;");
			expect(row).toContain("+1 const fooValue = 10;");
		});
	});

	describe("style overrides", () => {
		it('"unified" never splits regardless of width', () => {
			const text = diffBlock(["a"], ["b"]);
			const view = new SplitDiffView(text, { style: "unified" });
			expect(stripAnsi(view.render(200).join("\n"))).not.toContain("│");
		});

		it('"split" splits below the auto threshold, down to a hard floor', () => {
			const text = diffBlock(["a"], ["b"]);
			const view = new SplitDiffView(text, { style: "split" });
			expect(stripAnsi(view.render(60).join("\n"))).toContain("│");
			expect(stripAnsi(view.render(20).join("\n"))).not.toContain("│");
		});
	});

	describe("row alignment", () => {
		it("gives an unpaired removed line a blank right-hand side", () => {
			const text = diffBlock(
				["const value = 1;", "totally unrelated old line one", "totally unrelated old line two"],
				["const value = 10;"],
			);
			const view = new SplitDiffView(text, { style: "split" });
			const lines = view.render(120).map(stripAnsi);
			const row = lines.find((line) => line.includes("totally unrelated old line two"));
			expect(row).toBeDefined();
			const dividerIdx = row!.indexOf("│");
			expect(row!.slice(dividerIdx + 1).trim()).toBe("");
		});

		it("gives an unpaired added line a blank left-hand side", () => {
			const text = diffBlock(
				["const value = 1;"],
				["const value = 10;", "totally unrelated new line one", "totally unrelated new line two"],
			);
			const view = new SplitDiffView(text, { style: "split" });
			const lines = view.render(120).map(stripAnsi);
			const row = lines.find((line) => line.includes("totally unrelated new line two"));
			expect(row).toBeDefined();
			const dividerIdx = row!.indexOf("│");
			expect(row!.slice(0, dividerIdx).trim()).toBe("");
		});
	});
});

class FakeTerminal implements Terminal {
	columns: number;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	constructor(columns: number) {
		this.columns = columns;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

describe("edit tool split diff rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders unified at columns=80 and split at columns=160", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-split-diff-"));
		tempDirs.push(dir);
		const filePath = join(dir, "file.ts");
		await writeFile(filePath, "const value = 1;\n", "utf8");

		for (const [columns, expectSplit] of [
			[80, false],
			[160, true],
		] as const) {
			const terminal = new FakeTerminal(columns);
			const tui: TUI = new TuiMainScreen(terminal);
			const root = new Container();
			const component = new ToolExecutionComponent(
				"edit",
				`tool-call-${columns}`,
				{ path: filePath, oldText: "const value = 1;", newText: "const value = 100;" },
				{ diffDisplayStyle: "auto" },
				createEditToolDefinition(process.cwd()),
				tui,
				process.cwd(),
			);
			root.addChild(component);
			tui.addChild(root);
			tui.start();
			await waitForRender();

			component.setArgsComplete();
			tui.requestRender();

			const plain = await waitForRenderedText(
				() => stripAnsi(component.render(columns).join("\n")),
				"const value = 100;",
				() => tui.requestRender(true),
			);
			if (expectSplit) {
				expect(plain).toContain("│");
			} else {
				expect(plain).not.toContain("│");
			}
		}
	});
});
