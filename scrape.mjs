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

async function extractTop10(page) {
  // 1. On cherche n'importe quel tableau visible
  const table = page.locator('table').first();
  
  // On attend qu'il soit visible
  await table.waitFor({ state: "visible", timeout: 30_000 });

  // 2. On récupère tous les headers pour trouver la bonne colonne dynamiquement
  const headers = await table.locator("thead tr th").allInnerTexts();
  console.log("🧭 Headers trouvés:", headers);

  // 3. On cherche l'index de la colonne qui ressemble à "Overall" ou "Arena Elo" ou "Elo"
  const overallIdx = headers.findIndex(h => {
    const t = h.trim().toLowerCase();
    return t.includes("overall") || t.includes("elo") || t.includes("score");
  });

  if (overallIdx < 0) {
    // Screenshot ici aussi si on ne trouve pas la colonne
    await page.screenshot({ path: 'public/error_headers.png' });
    throw new Error(`Colonne de score introuvable. Headers: ${JSON.stringify(headers)}`);
  }

  // ... reste du code identique pour extraire les lignes
  const rows = await table.locator("tbody tr").all();
  // ...
  // Assurez-vous de retourner les données
}

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
  const browser = await chromium.launch(); // headless par défaut en CI
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);

  try {
    let top = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const isFirst = attempt === 1;
      console.log(`${isFirst ? "➡️  Goto" : "🔄 Reload"} (essai #${attempt})`);
      if (isFirst) {
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
      } else {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      }

      // Laisse le temps à Cloudflare / hydratation Next.js
      await page.waitForTimeout(7000);

      try {
        top = await extractTop10(page);
        console.log("🏆 Top10:", top.map(t => t.model));
        break; // succès
      } catch (e) {
        console.warn(`⚠️  Essai #${attempt} KO: ${e.message}`);
        await page.screenshot({ path: `public/error_attempt_${attempt}.png` });
        if (attempt === 3) throw e; // après 3 essais, on remonte l'erreur
      }
    }

    // "Last Updated" (pas toujours visible sur la page overview)
    let lastUpdatedText = null;
    try {
      const lu = page.locator('text=Last Updated').first();
      await lu.waitFor({ state: "visible", timeout: 5000 });
      lastUpdatedText = await lu.evaluate(el => (el.closest("div") || el.parentElement || el).innerText || el.textContent || null);
    } catch { /* silencieux */ }

    const now = new Date();
    writeOutput({
      source: URL,
      last_updated_raw: lastUpdatedText || null,
      last_updated_iso: lastUpdatedText ? null : now.toISOString().slice(0, 10),
      last_updated_human: lastUpdatedText ? null : now.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }),
      generated_at_iso: now.toISOString(),
      top10_overall: top,
      top3_overall: top.slice(0, 3)
    });
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

