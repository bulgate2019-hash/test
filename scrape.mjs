import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

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
  console.log("🕵️  Recherche du tableau...");
  
  // On attend 30s max
  try {
      await page.getByText('Model', { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
  } catch(e) {
      const title = await page.title();
      // Capture d'écran pour voir si l'écran virtuel fonctionne
      await page.screenshot({ path: "public/debug_xvfb.png" });
      throw new Error(`Élément non trouvé. Titre page: "${title}" (Voir debug_xvfb.png)`);
  }

  const bodyText = await page.locator('body').innerText();
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
  
  if (headerIndex === -1) throw new Error("Structure introuvable dans le texte.");

  const top = [];
  let rankCounter = 1;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (top.length >= 10) break;

    if (/\d{4}/.test(line)) {
        let modelName = line.replace(/^\d+\s+/, ''); 
        modelName = modelName.split(/\d{4}/)[0].trim(); 
        
        if (modelName.length < 2) continue;

        top.push({
            rank: rankCounter++,
            model: modelName, 
            overall: "Voir JSON"
        });
    }
  }
  return top;
}

(async () => {
  console.log("🖥️  Lancement Chromium avec écran virtuel (Xvfb)...");
  
  const browser = await chromium.launch({
    headless: false, // <--- C'EST LA CLÉ : On lance comme un VRAI navigateur
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,960',
        '--disable-blink-features=AutomationControlled' // Masque le fait que c'est un robot
    ]
  });
  
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    console.log(`➡️  Navigation vers ${URL}`);
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    
    // Attente longue pour laisser passer la vérif Cloudflare (souvent 5-10s)
    console.log("⏳ Pause Cloudflare...");
    await page.waitForTimeout(10000);

    // Simulation de mouvement souris
    await page.mouse.move(100, 100);
    await page.mouse.move(500, 500);

    const top = await extractTop10(page);
    console.log(`🏆 Succès ! ${top.length} modèles trouvés.`);

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
