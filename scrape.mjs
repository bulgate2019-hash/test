// scrape.mjs
import { chromium } from "playwright";
import fs from "fs";

const URL = "https://lmarena.ai/leaderboard";

// Utilitaire: écrit le JSON de sortie
function writeOutput(payload) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(
    "public/lmarena_overall_top3.json",
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
  console.log("✅ Écrit -> public/lmarena_overall_top3.json");
}

(async () => {
  const browser = await chromium.launch(); // headless par défaut sur GitHub Actions
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US"
  });
  const page = await ctx.newPage();

  try {
    console.log("➡️  Goto:", URL);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // Laisser le temps à Cloudflare / hydratation Next.js
    console.log("⏳ Attente post-chargement (Cloudflare/JS) …");
    await page.waitForTimeout(5000);

    // Trouver la table qui possède un header "Overall"
    console.log('🔎 Recherche de la table avec l’en-tête "Overall" …');
    const table = page.locator('table:has(th:has-text("Overall"))').first();
    await table.waitFor({ state: "visible", timeout: 60_000 });

    // Lire les entêtes pour localiser l’index de la colonne Overall
    const headers = await table.locator("thead tr th").allInnerTexts();
    console.log("🧭 Headers:", headers);
    const overallIdx = headers.findIndex(
      (h) => h.trim().toLowerCase() === "overall"
    );
    if (overallIdx < 0) {
      throw new Error(
        `Colonne "Overall" introuvable. Headers: ${JSON.stringify(headers)}`
      );
    }

    // Récupérer les 3 premières lignes
    const rows = await table.locator("tbody tr").all();
    if (rows.length === 0) {
      throw new Error("Aucune ligne trouvée dans le tableau Overall.");
    }
    const top = [];
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const cells = rows[i].locator("td");
      const vals = await cells.allInnerTexts();
      // Hypothèse: la première colonne est le nom du modèle
      const model = (vals[0] || "").trim();
      const overall = (vals[overallIdx] || "").trim();
      top.push({ model, overall });
    }
    console.log("🏆 Top3:", top);

    // Récupérer la date "Last Updated" si visible
    let lastUpdatedText = null;
    try {
      const lu = page.locator('text=Last Updated').first();
      await lu.waitFor({ state: "visible", timeout: 5000 });
      // Cherche un parent proche contenant le texte complet
      lastUpdatedText = await lu.evaluate((el) => {
        const host = el.closest("div") || el.parentElement || el;
        return host.innerText || el.textContent || null;
      });
    } catch {
      // silencieux si introuvable
    }

    // Écrire le JSON de sortie
    const payload = {
      source: URL,
      last_updated_raw: lastUpdatedText,
      generated_at_iso: new Date().toISOString(),
      top3_overall: top
    };
    writeOutput(payload);
  } catch (err) {
    console.error("❌ Erreur scrape:", err?.message || err);
    // Écrire un JSON d’erreur pour faciliter le debug côté site
    writeOutput({
      source: URL,
      error: String(err?.message || err),
      generated_at_iso: new Date().toISOString(),
      top3_overall: []
    });
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log("✅ Terminé sans erreur.");
})();

