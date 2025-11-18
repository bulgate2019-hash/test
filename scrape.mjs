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
  console.log("🕵️ Recherche du tableau via le texte des colonnes...");

  // On cherche un élément qui contient "Model" (souvent l'entête)
  // On attend jusqu'à 30s que cet élément apparaisse visuellement
  const modelHeader = page.getByText('Model', { exact: true }).first();
  
  try {
    await modelHeader.waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    console.log("⚠️ HEADER 'Model' NON TROUVÉ. Dump partiel du HTML:");
    const html = await page.content();
    console.log(html.slice(0, 1000)); // Affiche le début du HTML pour debug
    throw new Error("Le site a chargé mais l'entête 'Model' est introuvable.");
  }

  console.log("✅ Entête 'Model' trouvé. Extraction des lignes...");

  // Récupération de toutes les lignes potentielles (divs ou tr avec du texte)
  // On récupère le texte brut du body pour analyse si le DOM est trop complexe
  const bodyHandle = await page.locator('body');
  const bodyText = await bodyHandle.innerText();
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // On cherche la ligne qui contient les entêtes pour commencer juste après
  // Ex: "Rank Model Arena Elo ..."
  const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo") || l.includes("Score")));
  
  if (headerIndex === -1) {
      throw new Error("Impossible de trouver la ligne d'entête dans le texte visible.");
  }

  const top = [];
  let rankCounter = 1;

  // On parcourt les lignes suivantes
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    
    // Sécurité: on arrête si on a 10 éléments ou si la ligne ne ressemble pas à une donnée
    if (top.length >= 10) break;

    // Une ligne de donnée typique sur lmarena : "1   GPT-4o   1310"
    // Ou parfois le rang est sur une ligne, le modèle sur l'autre.
    // On fait une heuristic simple : si la ligne contient un nombre > 1000 (score Elo), c'est une ligne de score.
    
    // Cette logique est simplifiée pour la robustesse : on capture la ligne entière comme "model" pour l'instant
    // si on n'arrive pas à séparer proprement.
    
    // Si la ligne est juste un petit nombre (ex: "1"), c'est le rang, on passe à la suivante pour le modèle
    if (/^\d+$/.test(line) && parseInt(line) < 100) continue;

    // Si la ligne contient un score ELO (ex: 1287)
    if (/\d{4}/.test(line)) {
        top.push({
            rank: rankCounter++,
            model: line, // On stocke la ligne brute pour éviter de couper le nom du modèle
            overall: "Voir json" 
        });
    }
  }
  
  // Si l'heuristique texte échoue, on tente l'ancienne méthode via sélecteur
  if (top.length === 0) {
      console.log("⚠️ Parsing texte échoué, tentative via sélecteurs CSS...");
      const rows = await page.locator('tbody tr').all();
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const txt = await rows[i].innerText();
        top.push({ rank: i+1, model: txt.replace(/\n/g, ' '), overall: "" });
      }
  }

  return top;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  try {
    let top = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`➡️  Essai #${attempt}`);
      try {
        // CORRECTION ICI : domcontentloaded au lieu de networkidle
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        
        // Petite pause tactique pour l'hydratation JS
        await page.waitForTimeout(5000);

        top = await extractTop10(page);
        
        if (top && top.length > 0) {
            console.log(`🏆 Succès ! ${top.length} modèles récupérés.`);
            break;
        } else {
            throw new Error("Tableau vide récupéré.");
        }
      } catch (e) {
        console.warn(`⚠️  Essai #${attempt} échec: ${e.message}`);
        await page.screenshot({ path: `public/debug_error_${attempt}.png` });
        if (attempt === 3) throw e;
      }
    }

    const now = new Date();
    writeOutput({
      source: URL,
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
