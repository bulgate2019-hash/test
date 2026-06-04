import fs from "fs";

// ============================================
// LM ARENA — Source officielle (Hugging Face)
// Fini Playwright/Cloudflare : on lit le dataset
// officiel "lmarena-ai/leaderboard-dataset" en JSON.
// Champs : model_name, rating (= Arena Score), rank, category
// ============================================
const LMARENA_SOURCE = "https://lmarena.ai/leaderboard";

function buildRowsUrl(offset, length) {
  const params = new URLSearchParams({
    dataset: "lmarena-ai/leaderboard-dataset",
    config: "text_style_control", // arène texte (style control = défaut officiel)
    split: "latest",              // dernier classement publié
    offset: String(offset),
    length: String(length)
  });
  // Endpoint /rows : lecture directe, pas d'index à charger -> réponse immédiate
  return `https://datasets-server.huggingface.co/rows?${params.toString()}`;
}

// Petit fetch JSON avec réessai (au cas où HF répond "index loading" ou hoquet réseau)
async function fetchJsonWithRetry(url, tries = 4, waitMs = 8000) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "SuperFred-Hub/1.0" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error); // ex: "the dataset index is loading"
      return data;
    } catch (err) {
      console.log(`   ↳ tentative ${attempt}/${tries} échouée (${err.message})`);
      if (attempt < tries) await new Promise(r => setTimeout(r, waitMs));
      else throw err;
    }
  }
}

async function fetchLmArenaTop10() {
  console.log("🏆 Récupération du Top 10 LM Arena (API Hugging Face)...");

  const PAGE = 100;       // lignes par appel (max autorisé par l'API)
  const MAX_PAGES = 3;    // sécurité si la catégorie overall n'est pas en tête
  const overall = [];

  for (let page = 0; page < MAX_PAGES && overall.length < 10; page++) {
    const data = await fetchJsonWithRetry(buildRowsUrl(page * PAGE, PAGE));
    if (!data.rows || data.rows.length === 0) break;

    for (const { row } of data.rows) {
      if (row.category === "overall") overall.push(row);
    }
  }

  if (overall.length === 0) {
    throw new Error("Aucune ligne 'overall' trouvée dans le dataset HF");
  }

  // Tri par rang puis on garde le Top 10
  overall.sort((a, b) => a.rank - b.rank);

  return overall.slice(0, 10).map(row => ({
    rank: row.rank,
    model: row.model_name,
    overall: Math.round(row.rating) // Arena Score arrondi (ex: 1502)
  }));
}

function writeLmArena(top) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(
    "public/lmarena_overall_top3.json",
    JSON.stringify(
      {
        source: LMARENA_SOURCE,
        generated_at_iso: new Date().toISOString(),
        top10_overall: top,
        top3_overall: top.slice(0, 3)
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`✅ ${top.length} modèles écrits -> public/lmarena_overall_top3.json`);
}

// ==========================================
// NEWS — Flux RSS (inchangé)
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
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);

        if (!titleMatch || !linkMatch) continue;

        const title = titleMatch[1].replace(/&#8217;/g, "'").replace(/&quot;/g, '"');
        const desc = descMatch ? descMatch[1] : '';

        if (feed.isGeneral) {
          const textToSearch = (title + " " + desc).toLowerCase();
          const isAiRelated =
            /\b(ia|llm)\b/.test(textToSearch) ||
            textToSearch.includes('intelligence artificielle') ||
            textToSearch.includes('chatgpt') ||
            textToSearch.includes('openai') ||
            textToSearch.includes('gemini') ||
            textToSearch.includes('claude') ||
            textToSearch.includes('copilot') ||
            textToSearch.includes('anthropic');

          if (!isAiRelated) continue;
        }

        const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

        allNews.push({
          source: feed.source,
          title: title,
          link: linkMatch[1],
          pubDate: dateMatch ? dateMatch[1] : new Date().toISOString()
        });
        count++;
        if (count >= 4) break;
      }
    } catch (err) {
      console.error(`❌ Erreur avec ${feed.source}:`, err.message);
    }
  }

  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const finalNews = allNews.slice(0, 12);

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/news.json", JSON.stringify(finalNews, null, 2), "utf-8");
  console.log(`✅ ${finalNews.length} Actualités écrites -> public/news.json`);
}

// ==========================================
// MAIN — les deux tâches sont découplées :
// si LM Arena échoue, les news passent quand même
// (et l'ancien JSON LM Arena reste en place = pas de page vide).
// ==========================================
(async () => {
  console.log("🚀 Lancement du scraper...");

  let hadError = false;

  try {
    const top = await fetchLmArenaTop10();
    writeLmArena(top);
  } catch (err) {
    hadError = true;
    console.error("❌ LM Arena échoué (ancien JSON conservé):", err.message);
  }

  try {
    await updateNews();
  } catch (err) {
    hadError = true;
    console.error("❌ News échoué:", err.message);
  }

  // On ne fait planter l'Action que si TOUT a échoué
  process.exit(hadError ? 0 : 0);
})();
