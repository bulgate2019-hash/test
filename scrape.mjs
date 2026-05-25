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
// ==========================================
// NOUVEAU BLOC : Récupération des Flux RSS
// ==========================================
const RSS_FEEDS = [
  { url: 'https://www.actuia.com/feed/', source: 'Actu IA', isGeneral: false },
  { url: 'https://siecledigital.fr/intelligence-artificielle/feed/', source: 'Siècle Digital', isGeneral: false },
  { url: 'https://www.clubic.com/feed/news.rss', source: 'Clubic', isGeneral: true },
  { url: 'https://www.presse-citron.net/feed/', source: 'Presse-Citron', isGeneral: true },
  { url: 'https://www.lebigdata.fr/feed/', source: 'LeBigData', isGeneral: true }
];

async function updateNews() {
  console.log("📰 Récupération des actualités IA...");
  let allNews = [];

  for (const feed of RSS_FEEDS) {
      try {
          const res = await fetch(feed.url, {
              headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
                  'Accept': 'application/rss+xml, application/xml, text/xml, */*'
              }
          });
          
          if (!res.ok) continue;
          
          const xml = await res.text();
          const items = xml.split('<item>').slice(1); 
          
          let count = 0;
          for (const item of items) {
              // Extraction propre avant toute analyse
              const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
              const linkMatch = item.match(/<link>(.*?)<\/link>/);
              const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
              
              if (!titleMatch || !linkMatch) continue;

              const title = titleMatch[1].replace(/&#8217;/g, "'").replace(/&quot;/g, '"');
              const desc = descMatch ? descMatch[1] : '';

              // Filtre ultra-robuste pour les flux généralistes
              if (feed.isGeneral) {
                  // On cherche UNIQUEMENT dans le titre et la description
                  const textToSearch = (title + " " + desc).toLowerCase();
                  
                  const isAiRelated = 
                      /\b(ia|llm)\b/.test(textToSearch) || // On a supprimé "ai" pour éviter le "J'ai" français
                      textToSearch.includes('intelligence artificielle') ||
                      textToSearch.includes('chatgpt') ||
                      textToSearch.includes('openai') ||
                      textToSearch.includes('gemini') ||
                      textToSearch.includes('claude') ||
                      textToSearch.includes('copilot') ||
                      textToSearch.includes('anthropic');
                      
                  if (!isAiRelated) continue; // Si ça ne parle pas d'IA, on passe au suivant
              }

              const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

              allNews.push({
                  source: feed.source,
                  title: title,
                  link: linkMatch[1],
                  pubDate: dateMatch ? dateMatch[1] : new Date().toISOString()
              });
              count++;
              
              // On s'arrête à 4 articles pertinents par source
              if (count >= 4) break;
          }
      } catch (err) {
          console.error(`❌ Erreur avec ${feed.source}:`, err.message);
      }
  }

  // Tri du plus récent au plus ancien
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  
  // On garde les 12 dernières actus
  const finalNews = allNews.slice(0, 12);

  fs.writeFileSync(
    "public/news.json",
    JSON.stringify(finalNews, null, 2),
    "utf-8"
  );
  console.log(`✅ ${finalNews.length} Actualités écrites -> public/news.json`);
}
// ==========================================
// Fonction pour simuler un comportement humain (bouger la souris)
async function humanize(page) {
  console.log("🖱️ Simulation de mouvements humains...");
  for (let i = 0; i < 5; i++) {
    // Bouger la souris aléatoirement
    const x = Math.floor(Math.random() * 500) + 100;
    const y = Math.floor(Math.random() * 500) + 100;
    await page.mouse.move(x, y, { steps: 10 });
    
    // Parfois scroller un peu
    if (Math.random() > 0.5) {
      await page.mouse.wheel(0, Math.floor(Math.random() * 100));
    }
    
    // Attendre un peu entre les mouvements (2 à 4 secondes)
    await page.waitForTimeout(Math.random() * 2000 + 2000);
  }
}

async function extractTop10(page) {
  console.log("🕵️  Recherche du tableau HTML...");
  
  try {
    // On attend jusqu'à 60 secondes car Cloudflare peut être long
    await page.waitForSelector('table', { state: "visible", timeout: 60000 });
  } catch (e) {
    const title = await page.title();
    // Capture d'écran pour le debug
    await page.screenshot({ path: "public/debug_error.png" });
    throw new Error(`Tableau introuvable. Titre de la page: "${title}"`);
  }

  console.log("📊 Tableau trouvé ! Extraction des données...");

  const rows = await page.$$eval('table tbody tr', trs => {
    return trs.slice(0, 10).map((tr, i) => {
      const cols = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      return {
        rank: i + 1,
        model: cols[1] || 'Inconnu',
        overall: cols[3] || cols[2] || 'N/A' // Gestion dynamique des colonnes
      };
    });
  });

  if (!rows || rows.length === 0) {
      throw new Error("Aucune ligne de donnée extraite.");
  }

  return rows;
}

(async () => {
  console.log("🚀 Lancement du scraper...");

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome', // Utilise le vrai Chrome installé par l'action Github
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
    ]
  });
  
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    locale: "en-US"
  });

  const page = await ctx.newPage();
  
  // Masquer le webdriver (double sécurité avec stealth plugin)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  try {
    console.log(`➡️  Navigation vers ${URL}`);
    
    // Chargement de la page
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // REMPLACEMENT DE LA PAUSE STATIQUE PAR UNE PAUSE DYNAMIQUE
    console.log("⏳ Passage de Cloudflare (Simulation humaine)...");
    await humanize(page);

    const top = await extractTop10(page);
    console.log(`🏆 Succès ! ${top.length} modèles récupérés.`);

    const now = new Date();
    writeOutput({
      source: URL,
      generated_at_iso: now.toISOString(),
      top10_overall: top || [],
      top3_overall: top ? top.slice(0, 3) : []
    });
    //Lancement de la récupération RSS
    await updateNews();

  } catch (err) {
    console.error("❌ Erreur fatale:", err.message);
    process.exit(1);
  }

  await browser.close();
})();

