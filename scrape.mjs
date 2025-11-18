import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

// On garde le plugin stealth car il aide toujours à passer Cloudflare
chromium.use(stealthPlugin());

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
  console.log("🕵️  Recherche du tableau HTML...");
  
  // 🧩 1️⃣ CONSIGNE : Remplacer le détecteur par waitForSelector('table')
  // On attend que le tableau apparaisse dans le DOM
  try {
    await page.waitForSelector('table', { state: "visible", timeout: 30000 });
  } catch (e) {
    // Si pas de table, c'est probablement encore Cloudflare ou un changement de structure
    const title = await page.title();
    await page.screenshot({ path: "public/debug_no_table.png" });
    throw new Error(`Tableau introuvable après attente. Titre de la page: "${title}"`);
  }

  console.log("📊 Tableau trouvé ! Extraction des données...");

  // 🧩 2️⃣ CONSIGNE : Extraction directe via $$eval
  // On exécute ce code DANS le navigateur pour récupérer proprement les données
  const rows = await page.$$eval('table tbody tr', trs => {
    return trs.slice(0, 10).map((tr, i) => {
      const cols = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      
      // Logique de colonne : souvent Rank=0, Model=1, ELO=2 ou 3
      return {
        rank: i + 1,
        model: cols[1] || 'Inconnu',
        // On prend la colonne 3 (souvent ELO) ou fallback sur la 2
        overall: cols[3] || cols[2] || 'N/A'
      };
    });
  });

  if (!rows || rows.length === 0) {
      throw new Error("Aucune ligne de donnée extraite du tableau.");
  }

  return rows;
}

(async () => {
  console.log("🚀 Lancement du scraper (Mode Table + Headless)...");

  // 🧩 3️⃣ CONSIGNE : headless: true
  const browser = await chromium.launch({
    headless: true, 
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled' // Aide discrète contre la détection
    ]
  });
  
  const ctx = await browser.newContext({
    // User Agent moderne pour ressembler à un vrai Chrome
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 }
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    console.log(`➡️  Navigation vers ${URL}`);
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    
    // 🧩 4️⃣ CONSIGNE : Pause augmentée à 15 secondes
    console.log("⏳ Pause de 15s pour laisser passer Cloudflare/Hydratation...");
    await page.waitForTimeout(15000);

    // Petit scroll pour forcer le chargement visuel si nécessaire
    await page.mouse.wheel(0, 200);

    const top = await extractTop10(page);
    console.log(`🏆 Succès ! ${top.length} modèles récupérés.`);

    const now = new Date();
    writeOutput({
      source: URL,
      generated_at_iso: now.toISOString(),
      top10_overall: top || [],
      top3_overall: top ? top.slice(0, 3) : []
    });

  } catch (err) {
    console.error("❌ Erreur fatale:", err.message);
    process.exit(1);
  }

  await browser.close();
})();
