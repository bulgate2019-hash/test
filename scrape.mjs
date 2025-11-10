// scrape.mjs
import { chromium } from "playwright";
import fs from "fs";

const URL = "https://lmarena.ai/leaderboard";

function writeOutput(payload) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(
    "public/lmarena_overall_top3.json",
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
  console.log("✅ Écrit -> public/lmarena_overall_top3.json");
}

async function getTop10(page) {
  // Chercher la table qui contient un <th> "Overall"
  const table = page.locator('table:has(th:has-text("Overall"))').first();
  await table.waitFor({ state: "visible", timeout: 120_000 });

  const headers = await table.locator("thead tr th").allInnerTexts();
  console.log("🧭 Headers:", headers);
  const overallIdx = headers.findIndex(h => h.trim().toLowerCase() === "overall");
  if (overallIdx < 0) throw new Error(`Colonne "Overall" introuvable. Headers: ${JSON.stringify(headers)}`);

  const rows = await table.locator("tbody tr").all();
  if (rows.length === 0) throw new Error("Aucune ligne trouvée dans le tableau.");

  const top = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].locator("td");
    const vals = await cells.allInnerTexts();
    const model = (vals[0] || "").trim();
    const overall = (vals[overallIdx] || "").trim();
    top.push({ rank: i + 1, model, overall });
  }
  return top;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);

  try {
    console.log("➡️  Goto:", URL);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForLoadState("networkidle", { timeout: 120_000 });
    await page.waitForTimeout(6000); // laisser Cloudflare/JS finir

    let top = null;
    try {
      console.log("🔎 Essai #1 extraction…");
      top = await getTop10(page);
    } catch (e) {
      console.warn("⚠️  Essai #1 a échoué:", e.message);
      console.log("🔄 Reload & essai #2…");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 120_000 });
      await page.waitForTimeout(6000);
      top = await getTop10(page); // si ça échoue ici, on laisse remonter l’erreur
    }

    console.log("🏆 Top10:", top.map(t => t.model));

    // Bandeau "Last Updated" (optionnel / parfois absent)
    let lastUpdatedText = null;
    try {
      const lu = page.locator('text=Last Updated').first();
      await lu.waitFor({ state: "visible", timeout: 5000 });
      lastUpdatedText = await lu.evaluate(el => (el.closest("div") || el.parentElement || el).innerText || el.textContent || null);
    } catch {}

    const now = new Date();
    const payload = {
      source: URL,
      last_updated_raw: lastUpdatedText || null,
      last_updated_iso: lastUpdatedText ? null : now.toISOString().slice(0, 10),
      last_updated_human: lastUpdatedText ? null : now.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }),
      generated_at_iso: now.toISOString(),
      top10_overall: top,
      top3_overall: top.slice(0, 3)
    };
    writeOutput(payload);
  } catch (err) {
    console.error("❌ Erreur scrape:", err?.message || err);
    writeOutput({
      source: URL,
      error: String(err?.message || err),
      generated_at_iso: new Date().toISOString(),
      top10_overall: [],
      top3_overall: []
    });
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log("✅ Terminé sans erreur.");
})();
