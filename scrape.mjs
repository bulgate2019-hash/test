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

  // STRATÉGIE : On ne cherche pas <table>, on cherche le texte "Model" qui sert de titre
  // On cherche un élément qui contient "Model", puis on remonte à son conteneur
  const modelHeader = page.getByText('Model', { exact: true }).first();
  
  try {
    await modelHeader.waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    // Si on ne trouve pas "Model", on dump le HTML pour comprendre
    console.log("⚠️ HEADER 'Model' NON TROUVÉ. Dump du HTML body:");
    const html = await page.content();
    console.log(html.slice(0, 2000)); // On affiche les 2000 premiers caractères
    throw new Error("Impossible de trouver l'entête du tableau (Cloudflare ou changement de texte).");
  }

  console.log("✅ Entête 'Model' trouvé ! Analyse de la structure...");

  // On suppose que le tableau est structuré en lignes (row) ou en grille.
  // On récupère tout le texte de la page pour faire une extraction "brute" si le DOM est trop complexe
  const bodyText = await page.locator('body').innerText();
  
  // Si le DOM est complexe (div soup), on utilise une approche visuelle simplifiée :
  // On va chercher tous les éléments qui ressemblent à des lignes de tableau
  
  // TENTATIVE 1 : Sélecteur générique de ligne (souvent role="row" ou des classes grid)
  let rows = await page.locator('[role="row"]').all();
  
  // Si pas de role="row", on cherche des TR
  if (rows.length === 0) {
     rows = await page.locator('tbody tr').all();
  }
  
  // Si toujours rien, c'est peut-être des DIVs. On va parser le texte brut ligne par ligne
  // C'est une méthode de secours "Dernier recours"
  if (rows.length === 0) {
      console.log("⚠️ Pas de structure de tableau détectée. Tentative de parsing texte brut.");
      const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      // Logique simplifiée : trouver la ligne "Model" et prendre les suivantes
      const headerIdx = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
      
      if (headerIdx === -1) throw new Error("Impossible de repérer la structure dans le texte.");
      
      const top = [];
      // On prend les 10 lignes suivantes qui ressemblent à des données
      let currentRank = 1;
      for (let i = headerIdx + 1; i < lines.length && currentRank <= 10; i++) {
          const line = lines[i];
          // Heuristique : Une ligne de data commence souvent par un chiffre (rang) ou un nom de modèle
          // Ceci est très fragile, mais mieux que rien.
          // Pour LMArena, les lignes sont souvent : "1  GPT-4  1250 ..."
          top.push({ rank: currentRank++, model: line, overall: "N/A (Parsing texte)" });
      }
      return top;
  }

  // Si on a trouvé des rows HTML (cas idéal)
  console.log(`✅ ${rows.length} lignes trouvées.`);
  const top = [];
  
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const text = await rows[i].innerText();
    // On saute l'entête
    if (text.includes("Model") && text.includes("Overall")) continue;
    
    // Parsing basique : on split par tab ou retour à la ligne
    const parts = text.split(/\t|\n/).filter(p => p.trim() !== '');
    
    if (parts.length < 2) continue;

    // On essaie de deviner les positions. 
    // Souvent : [Rank, Model, Arena Elo, ...]
    // Parfois Rank est implicite.
    
    const model = parts[0].length < 3 ? parts[1] : parts[0]; // Si parts[0] est "1", alors le modèle est parts[1]
    const score = parts.find(p => p.match(/^\d{3,5}$/)); // Cherche un nombre type Elo (ex: 1280)

    top.push({ 
        rank: top.length + 1, 
        model: model, 
        overall: score || "N/A" 
    });
    
    if (top.length >= 10) break;
  }
  
  return top;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    // User Agent "Stealth" plus moderne (Chrome Mac)
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US"
  });
  
  const page = await ctx.newPage();
  // Masquer webdriver pour éviter la détection basique
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  page.setDefaultTimeout(60_000);

  try {
    let top = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`➡️  Essai #${attempt}`);
      try {
        await page.goto(URL, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForTimeout(5000); // Pause tactique

        top = await extractTop10(page);
        console.log("🏆 Top récupéré:", top.length);
        break;
      } catch (e) {
        console.warn(`⚠️  Essai #${attempt} échec: ${e.message}`);
        await page.screenshot({ path: `public/debug_${attempt}.png` });
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
