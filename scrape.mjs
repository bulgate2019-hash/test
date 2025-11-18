import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

chromium.use(stealthPlugin());

// NOUVELLE CIBLE : La source directe sur Hugging Face
// Souvent moins protégée par Cloudflare que le domaine .ai
const URL = "https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard";

function writeOutput(payload) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(
    "public/lmarena_overall_top3.json",
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
  console.log("✅ Écrit -> public/lmarena_overall_top3.json");
}

async function extractFromFrame(frame) {
  try {
    // On récupère le texte brut de la frame
    const text = await frame.innerText('body');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // On cherche si cette frame contient notre tableau
    const hasHeaders = lines.some(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
    
    if (!hasHeaders) return null;

    console.log("🎯 Tableau trouvé dans une iframe ! Extraction...");
    
    const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
    const top = [];
    let rankCounter = 1;

    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (top.length >= 10) break;

        // Regex pour un score Elo (ex: 1310)
        if (/\d{4}/.test(line)) {
            // Nettoyage basique
            let modelName = line.replace(/^\d+\s+/, ''); 
            modelName = modelName.split(/\d{4}/)[0].trim();
            
            // Exclusion des lignes bizarres
            if (modelName.length < 2) continue;

            top.push({
                rank: rankCounter++,
                model: modelName, 
                overall: "Voir JSON" 
            });
        }
    }
    return top.length > 0 ? top : null;
  } catch (e) {
    return null;
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true, // On reste en true pour Playwright standard
    args: [
        "--disable-blink-features=AutomationControlled", 
        "--no-sandbox", 
        "--disable-setuid-sandbox"
    ]
  });
  
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 }
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    console.log(`➡️  Navigation vers la source HF: ${URL}`);
    // Hugging Face est lourd à charger, on attend "networkidle" ou juste un bon timeout
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    
    console.log("⏳ Chargement de l'application (Gradio)...");
    await page.waitForTimeout(15000); // On laisse le temps aux scripts JS de monter le tableau

    // Hugging Face utilise souvent des iframes pour isoler les Apps (Gradio)
    // Nous allons scanner la page principale ET toutes les iframes
    let top = null;

    // 1. Test sur la page principale
    top = await extractFromFrame(page);

    // 2. Si pas trouvé, on cherche dans les iframes
    if (!top) {
        console.log("🕵️  Recherche dans les iframes...");
        for (const frame of page.frames()) {
            const res = await extractFromFrame(frame);
            if (res) {
                top = res;
                break;
            }
        }
    }

    if (!top) {
        // Dernier recours: Dump du texte pour voir ce qui se passe
        await page.screenshot({ path: "public/debug_hf.png" });
        throw new Error("Impossible de trouver le tableau (même dans les iframes). Voir screenshot.");
    }

    console.log(`🏆 Succès ! ${top.length} modèles récupérés.`);

    const now = new Date();
    writeOutput({
      source: URL,
      generated_at_iso: now.toISOString(),
      top10_overall: top,
      top3_overall: top.slice(0, 3)
    });

  } catch (err) {
    console.error("❌ Erreur fatale:", err.message);
    process.exit(1);
  }

  await browser.close();
})();
