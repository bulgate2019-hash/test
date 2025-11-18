import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

// Active le mode furtif
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

async function solveCloudflare(page) {
  console.log("🛡️ Vérification du challenge Cloudflare...");
  
  try {
    // On attend un peu pour voir si ça passe tout seul
    await page.waitForTimeout(5000);

    const title = await page.title();
    if (!title.includes("Just a moment") && !title.includes("Security")) {
      console.log("✅ Pas de blocage détecté (ou redirection déjà faite).");
      return;
    }

    console.log("⚠️ Blocage détecté. Tentative de résolution du CAPTCHA...");

    // On cherche toutes les iframes (le bouton est souvent dans une iframe)
    const frames = page.frames();
    let clicked = false;

    for (const frame of frames) {
      // On cherche une iframe qui ressemble à celle de Cloudflare (turnstile ou challenge)
      const url = frame.url();
      if (url.includes("cloudflare") || url.includes("turnstile") || url.includes("challenge")) {
        console.log("⚡ Frame Cloudflare trouvée, tentative de clic...");
        try {
            // On essaie de cliquer au milieu de l'iframe
            const box = await frame.frameElement().boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                console.log("🖱️ Clic envoyé !");
                clicked = true;
            }
            // On essaie aussi de cliquer sur les éléments input/label s'ils existent
            const checkbox = await frame.locator('input[type="checkbox"], label, .ctp-checkbox-label').first();
            if (await checkbox.isVisible()) {
                await checkbox.click({ force: true });
                console.log("🖱️ Clic ciblé sur checkbox !");
                clicked = true;
            }
        } catch (e) {
            console.log("⚠️ Erreur clic frame:", e.message);
        }
      }
    }

    if (!clicked) {
        // Tentative désespérée : cliquer au milieu de la page
        console.log("⚠️ Pas d'iframe explicite, clic au centre de la page...");
        await page.mouse.click(400, 300);
    }

    // On attend la redirection après le clic
    console.log("⏳ Attente après tentative de résolution...");
    await page.waitForTimeout(15000);

  } catch (e) {
    console.log("⚠️ Erreur dans solveCloudflare (non bloquant):", e.message);
  }
}

async function extractTop10(page) {
  // Étape 1 : Essayer de passer Cloudflare
  await solveCloudflare(page);

  // Étape 2 : Vérifier si on est passé
  const title = await page.title();
  if (title.includes("Just a moment")) {
      // Screenshot pour debug final
      await page.screenshot({ path: "public/blocked_screenshot.png" });
      throw new Error("⛔ Toujours bloqué par Cloudflare après tentatives.");
  }

  console.log("🕵️  Accès réussi ! Recherche du tableau...");
  
  // Attente de l'élément "Model"
  try {
    await page.getByText('Model', { exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
  } catch (e) {
     const html = await page.content();
     // Petit check pour voir si c'est une erreur 403/429 cachée
     if (html.includes("Just a moment")) throw new Error("⛔ Cloudflare est revenu.");
     throw new Error("Tableau introuvable (Timeout).");
  }

  // Extraction des données (Méthode Texte Brut pour robustesse)
  const bodyText = await page.locator('body').innerText();
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const headerIndex = lines.findIndex(l => l.includes("Model") && (l.includes("Overall") || l.includes("Elo")));
  if (headerIndex === -1) throw new Error("Structure du tableau non trouvée.");

  const top = [];
  let rankCounter = 1;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (top.length >= 10) break;

    // Regex pour trouver un score Elo (ex: 1310)
    if (/\d{4}/.test(line)) {
        let modelName = line.replace(/^\d+\s+/, ''); // Retire le rang du début
        // Nettoyage sommaire
        modelName = modelName.split(/\d{4}/)[0].trim(); 
        
        top.push({
            rank: rankCounter++,
            model: modelName || "Unknown", 
            overall: "Voir JSON"
        });
    }
  }
  
  return top;
}

(async () => {
  // Lancement avec des arguments anti-détection agressifs
  const browser = await chromium.launch({
    headless: true, // Correction : Playwright veut un booléen
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certifcate-errors',
      '--ignore-certificate-errors-spki-list',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ]
  });
  
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    deviceScaleFactor: 1,
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000); // Timeout global très long

  try {
    let top = null;
    
    console.log("➡️  Navigation vers l'arène...");
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    
    // Petite simulation de souris immédiate pour montrer qu'on est "vivant"
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

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
    console.error("❌ Erreur fatale:", err.message);
    process.exit(1);
  }

  await browser.close();
})();

