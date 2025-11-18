import { firefox } from "playwright-extra"; // On passe à FIREFOX
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

// Le mode stealth fonctionne mieux sur Chrome, mais aide aussi sur Firefox
const stealth = stealthPlugin();
// Hack pour éviter un bug de stealth avec Firefox
stealth.enabledEvasions.delete('user-agent-override');
firefox.use(stealth);

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
  console.log("🕵️ Recherche du tableau...");
  
  // Attente que le texte "Model" apparaisse (max 30s)
  try {
      await page.getByText('Model', { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
  } catch(e) {
      // Si échec, on prend une photo pour comprendre
      await page.screenshot({ path: "public/debug_fail_firefox.png" });
      const title = await page.title();
      throw new Error(`Tableau non trouvé. Titre de la page: "${title}"`);
  }

  // Extraction brute
  const bodyText = await page.locator('body').innerText();
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
  
  if (headerIndex === -1) throw new Error("Structure introuvable dans le texte.");

  const top = [];
  let rankCounter = 1;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (top.length >= 10) break;

    // Regex pour trouver le score Elo (ex: 1310)
    // LMArena format typique: "1   GPT-4o-2024-05-13   1287"
    if (/\d{4}/.test(line)) {
        let modelName = line.replace(/^\d+\s+/, ''); // Enlever le rang au début
        modelName = modelName.split(/\d{4}/)[0].trim(); // Garder ce qui est avant le score
        
        // Petit nettoyage si le nom est vide ou trop court
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
  console.log("🦊 Lancement de Firefox...");
  
  const browser = await firefox.launch({
    headless: true, // Firefox headless est moins détecté que Chrome headless
  });
  
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    // User Agent légitime de Firefox Windows
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    // Headers indispensables pour passer pour un humain
    extraHTTPHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1"
    }
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    console.log(`➡️  Navigation vers ${URL}`);
    
    // Navigation fluide
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    
    // Pause tactique pour laisser les scripts tourner
    await page.waitForTimeout(8000);

    // Petit scroll pour déclencher le lazy loading éventuel
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(2000);

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
