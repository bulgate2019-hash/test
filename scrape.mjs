import { chromium } from "playwright";
import fs from "fs";

const URL = "https://lmarena.ai/leaderboard"; // page générale (Arena Overview)

function pickOverallIndex(headers) {
  const idx = headers.findIndex(h =>
    h.trim().toLowerCase() === "overall"
  );
  return idx >= 0 ? idx : null;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });
  const page = await ctx.newPage();

  // 1) Ouvrir la page et laisser Cloudflare/Next.js s’hydrater
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // 2) Attendre que le bloc "Arena Overview" et un tableau soient présents
  await page.waitForTimeout(3000); // petit temps pour l'hydratation
  await page.waitForSelector("text=Arena Overview", { timeout: 30000 });
  const table = await page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 30000 });

  // 3) Lire les entêtes pour trouver la colonne "Overall"
  const headerCells = await table.locator("thead tr th").allInnerTexts();
  const overallIdx = pickOverallIndex(headerCells);
  if (overallIdx === null) {
    throw new Error("Colonne 'Overall' introuvable");
  }

  // 4) Récupérer les 3 premières lignes du corps
  const rows = await table.locator("tbody tr").all();
  const top = [];
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    const cells = rows[i].locator("td");
    const cellTexts = await cells.allInnerTexts();
    const model = (cellTexts[0] || "").trim();        // 1ère colonne: Model (texte)
    const overall = (cellTexts[overallIdx] || "").trim();
    top.push({ model, overall });
  }

  // 5) Récupérer la date "Last Updated" si présente
  let lastUpdatedText = null;
  try {
    const lu = await page.locator("text=Last Updated").first();
    await lu.waitFor({ state: "visible", timeout: 3000 });
    const section = await page.locator("text=Last Updated").first().locator("xpath=..");
    lastUpdatedText = await section.innerText();
  } catch { /* silencieux */ }

  await browser.close();

  // 6) Écrire le JSON
  const out = {
    source: URL,
    last_updated_raw: lastUpdatedText,
    generated_at_iso: new Date().toISOString(),
    top3_overall: top
  };
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/lmarena_overall_top3.json", JSON.stringify(out, null, 2), "utf-8");
  console.log("OK -> public/lmarena_overall_top3.json");
})();
