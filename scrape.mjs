// scrape.mjs
// Note: On utilise maintenant playwright-extra pour le mode Stealth
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

// Active le plugin de camouflage
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
  console.log("🕵️  Analyse du contenu de la page...");
  
  // Vérification anti-Cloudflare: Si le titre reste "Just a moment...", on est bloqué
  const title = await page.title();
  if (title.includes("Just a moment")) {
      throw new Error("⛔ Bloqué par Cloudflare (Challenge non passé).");
  }

  // On cherche le tableau via le texte "Model" (plus robuste que <table>)
  try {
    await page.getByText('Model', { exact: true }).first().waitFor({ state: "visible", timeout: 15000 });
  } catch (e) {
     // Si échec, on dump le HTML pour debug
     const html = await page.content();
     // On vérifie si on est sur la page Cloudflare malgré tout
     if (html.includes("Challenge") || html.includes("Verify")) {
         throw new Error("⛔ Détecté comme bot par Cloudflare.");
     }
     throw new Error("Tableau introuvable (problème de structure HTML).");
  }

  // Extraction robuste (via texte brut si nécessaire)
  const bodyText = await page.locator('body').innerText();
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Recherche de la ligne d'entête
  const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
  
  if (headerIndex === -1) throw new Error("Structure du tableau non trouvée dans le texte.");

  const top = [];
  let rankCounter = 1;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (top.length >= 10) break;

    // Logique de parsing simplifiée pour lmarena
    // On cherche les lignes qui contiennent un score ELO (ex: 1310)
    if (/\d{4}/.test(line)) {
        // Nettoyage basique : on enlève le rang s'il est au début (ex "1 GPT-4")
        let modelName = line;
        // Si la ligne commence par un chiffre seul suivi d'espace
        modelName = modelName.replace(/^\d+\s+/, ''); 
        
        top.push({
            rank: rankCounter++,
            model: modelName, 
            overall: "Voir json pour raw" 
        });
    }
  }
  
  return top;
}

(async () => {
  // Lancement avec playwright-extra (déjà configuré avec stealth)
  const browser = await chromium.launch({ headless: true });
  
  const ctx = await browser.newContext({
    // User Agent "Chrome Windows" très standard pour se fondre dans la masse
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    deviceScaleFactor: 1,
  });

  const page = await ctx.newPage();
  // Masquer webdriver est géré par le plugin stealth, mais on ajoute un timeout généreux
  page.setDefaultTimeout(60_000);

  try {
    let top = null;
    
    // On ne fait qu'un seul essai "long" pour laisser Cloudflare passer le challenge
    console.log("➡️  Navigation vers l'arène (Attente résolution challenge)...");
    
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    
    // ASTUCE : On attend 10 secondes pour laisser le script Cloudflare tourner
    // Souvent, la page se recharge toute seule après 5s
    await page.waitForTimeout(10000);
    
    // Petite simulation humaine (mouvement de souris)
    try {
        await page.mouse.move(100, 100);
        await page.mouse.move(200, 200);
    } catch {}

    top = await extractTop10(page);
    console.log(`🏆 Succès ! ${top.length} modèles trouvés.`);

    const now = new Date();
    writeOutput({
      source: URL,
      generated_at_iso: now.toISOString(),
      top10_overall: top || [],
      top3_overall: top ? top.slice(0, 3) : []
    });

  } catch (err) {
    console.error("❌ Erreur:", err.message);
    // Snapshot en cas d'erreur finale
    await page.screenshot({ path: "public/debug_final_error.png" });
    process.exit(1);
  }

  await browser.close();
})();
