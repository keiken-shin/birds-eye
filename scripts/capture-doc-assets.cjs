#!/usr/bin/env node
/**
 * Capture the documentation's product screenshot and workflow frames.
 *
 * Run the browser-mode workspace first (`cd workspace && npm run dev`), then:
 *
 *   node scripts/capture-doc-assets.cjs
 *
 * The script expects Playwright to be available to Node. It writes temporary
 * PNG frames to `.capture/docs-workflow/` and the current Staged screen to
 * `docs/assets/screenshots/staged.png`. Pass `--inspect` to print the visible
 * controls without changing the documentation assets.
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const URL = process.env.BIRDS_EYE_CAPTURE_URL || "http://127.0.0.1:5174";
const FRAME_DIR = path.join(ROOT, ".capture", "docs-workflow");
const STAGED_SHOT = path.join(ROOT, "docs", "assets", "screenshots", "staged.png");
const inspectOnly = process.argv.includes("--inspect");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function visibleText(page, selector) {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      })
      .map((node) => node.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BIRDS_EYE_CHROMIUM || chromium.executablePath(),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  try {
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.locator("#root").waitFor();
    await pause(450);

    if (inspectOnly) {
      console.log(JSON.stringify({
        title: await page.title(),
        headings: await visibleText(page, "h1,h2,h3"),
        buttons: await visibleText(page, "button"),
      }, null, 2));
      return;
    }

    fs.rmSync(FRAME_DIR, { recursive: true, force: true });
    fs.mkdirSync(FRAME_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(STAGED_SHOT), { recursive: true });

    let frame = 0;
    const capture = async (name) => {
      const file = path.join(FRAME_DIR, `${String(++frame).padStart(2, "0")}-${name}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      return file;
    };

    // One task, not a feature tour: understand a recommendation, stage it,
    // organize the decision, and reach the review gate.
    await capture("overview");

    await page.getByRole("tab", { name: /^Clean up/ }).click();
    await pause(350);
    await capture("recommendations");

    const stageSelected = page.getByRole("button", { name: "Stage selected" });
    const candidateRows = page.locator('button[class*="border-l-[3px]"]');
    for (let index = 0; index < Math.min(2, await candidateRows.count()); index += 1) {
      const row = candidateRows.nth(index);
      if (await row.isEnabled().catch(() => false)) await row.click();
    }
    if (await stageSelected.isEnabled().catch(() => false)) await stageSelected.click();
    await pause(300);
    await capture("staged-in-tray");

    await page.getByRole("tab", { name: /^Staged/ }).click();
    await pause(350);

    const decisions = page.locator('input[type="checkbox"]');
    for (let index = 0; index < Math.min(2, await decisions.count()); index += 1) {
      await decisions.nth(index).check();
    }
    const groupName = page.getByPlaceholder(/Group name/i);
    if (await groupName.isVisible().catch(() => false)) {
      await groupName.fill("Build leftovers");
      await page.getByRole("button", { name: "Put in group" }).click();
      await pause(250);
    }

    await page.screenshot({ path: STAGED_SHOT, animations: "disabled" });
    await capture("decision-desk");

    const review = page.getByRole("button", { name: /Review & clean|Review & delete/i }).first();
    if (await review.isVisible().catch(() => false)) {
      await review.click();
      await pause(350);
      await capture("review-gate");
    }

    console.log(`Captured ${frame} workflow frames in ${path.relative(ROOT, FRAME_DIR)}`);
    console.log(`Updated ${path.relative(ROOT, STAGED_SHOT)}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
