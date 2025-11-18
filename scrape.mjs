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

// --- C'est ici que vous aviez l'erreur : la fonction doit être bien définie ---
async function extractTop10(page) {
  // 1. On cherche le premier tableau visible
  const table = page.locator('table').first();
  await table.waitFor({ state: "visible", timeout: 30_000 });

  // 2. On récupère les headers pour trouver la colonne "Overall" dynamiquement
  const headers = await table.locator("thead tr th").allInnerTexts();
  console.log("🧭 Headers trouvés:", headers);

  // 3. On cherche l'index de la colonne (Overall, Arena Elo, Score...)
  const overallIdx = headers.findIndex(h => {
    const t = h.trim().toLowerCase();
    return t.includes("overall") || t.includes("elo") || t.includes("score");
  });

  if (overallIdx < 0) {
    throw new Error(`Colonne de score introuvable. Headers: ${JSON.stringify(headers)}`);
  }

  const rows = await table.locator("tbody tr").all();
  if (rows.length === 0) throw new Error("Aucune ligne trouvée dans le tableau.");

  const top = [];
  // On prend max 10 lignes
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].locator("td");
    const vals = await cells.allInnerTexts();
    
    // Sécurité : vérifier qu'on a assez de colonnes
    if (vals.length <= overallIdx) continue;

    const model = (vals[0] || "").trim(); // Modèle souvent en 1ère colonne
    const overall = (vals[overallIdx] || "").trim();
    
    top.push({ rank: i + 1, model, overall });
  }
  
  return top; // <--- Ce return est maintenant valide car il est DANS la fonction
}

// --- Bloc principal ---
(async () => {
  const browser = await chromium.launch(); 
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    let top = null;
    // Tentatives
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`➡️  Essai #${attempt}`);
      
      try {
        if (attempt === 1) {
          await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        } else {
          await page.reload({ waitUntil: "domcontentloaded" });
        }
        
        // Pause pour laisser Cloudflare/JS charger
        await page.waitForTimeout(5000);

        top = await extractTop10(page);
        console.log("🏆 Top récupéré:", top.length, "éléments");
        break; // Succès, on sort de la boucle
      } catch (e) {
        console.warn(`⚠️  Essai #${attempt} échec: ${e.message}`);
        // Capture d'écran pour le debug
        await page.screenshot({ path: `public/error_attempt_${attempt}.png` });
        
        if (attempt === 3) throw e; 
      }
    }

    // Récupération date (optionnel)
    let lastUpdatedText = null;
    try {
        const lu = page.locator('text=Last Updated').first();
        if (await lu.isVisible()) {
            lastUpdatedText = await lu.innerText();
        }
    } catch {}

    const now = new Date();
    writeOutput({
      source: URL,
      last_updated_raw: lastUpdatedText,
      generated_at_iso: now.toISOString(),
      top10_overall: top || [],
      top3_overall: top ? top.slice(0, 3) : []
    });

  } catch (err) {
    console.error("❌ Erreur fatale:", err);
    process.exit(1);
  }

  await browser.close();
})();
