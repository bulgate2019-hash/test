#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";

/* ============================== Réglages ============================== */
const DOSSIER_SORTIE = "public";
const MAINTENANT_ISO = new Date().toISOString();
const POIDS_HUMAIN = 0.5;
const POIDS_BENCH = 0.5;
const TAILLE_POOL = 25;

const LMARENA_API = "https://datasets-server.huggingface.co/first-rows?dataset=lmarena-ai/leaderboard-dataset&config=text_style_control&split=latest";
const LMARENA_PAGE = "https://lmarena.ai/leaderboard";
const AA_API = "https://artificialanalysis.ai/api/v2/data/llms/models";
const AA_PAGE = "https://artificialanalysis.ai/";

const ENTETES_DE_BASE = {
  "user-agent": "Mozilla/5.0 (compatible; HubIA-scraper/2.0)",
  accept: "application/json, application/rss+xml, */*",
};

async function fetchAvecReprises(url, options = {}, essais = 3) {
  let derniereErreur;
  for (let i = 1; i <= essais; i++) {
    try {
      const reponse = await fetch(url, { ...options, headers: { ...ENTETES_DE_BASE, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
      if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
      return reponse;
    } catch (erreur) {
      derniereErreur = erreur;
      if (i < essais) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw derniereErreur;
}

async function ecrireJsonSiValide(nomFichier, donnees, estValide) {
  if (!estValide(donnees)) return false;
  await writeFile(`${DOSSIER_SORTIE}/${nomFichier}`, JSON.stringify(donnees, null, 2) + "\n", "utf8");
  return true;
}

const arrondi1 = (v) => Math.round(v * 10) / 10;

/* ====================== 1) Actualités IA ===================== */
const FLUX_RSS = [
  { nom: "Actu IA", url: "https://www.actuia.com/feed/", filtrerIA: false },
  { nom: "Siècle Digital", url: "https://siecledigital.fr/feed/", filtrerIA: true },
  { nom: "Clubic", url: "https://www.clubic.com/feed/news.rss", filtrerIA: true },
];

const MOTS_CLES_IA = ["intelligence artificielle", " ia ", "openai", "chatgpt", "claude", "gemini", "mistral", "llm"];
const parleDIA = (texte) => MOTS_CLES_IA.some((mot) => ` ${texte.toLowerCase()} `.includes(mot));

function nettoyerTexteRss(brut) {
  return String(brut ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parserRss(xml, nomSource) {
  const articles = [];
  for (const bloc of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const champ = (balise) => {
      const m = bloc.match(new RegExp(`<${balise}[^>]*>([\\s\\S]*?)<\\/${balise}>`, "i"));
      return m ? nettoyerTexteRss(m[1]) : "";
    };
    articles.push({ source: nomSource, title: champ("title"), link: champ("link"), pubDate: champ("pubDate") });
  }
  return articles;
}

async function recupererActus() {
  const tous = [];
  for (const flux of FLUX_RSS) {
    try {
      const reponse = await fetchAvecReprises(flux.url);
      const xml = await reponse.text();
      let articles = parserRss(xml, flux.nom).filter((a) => a.title && a.link);
      if (flux.filtrerIA) articles = articles.filter((a) => parleDIA(`${a.title}`));
      tous.push(...articles);
    } catch (e) {}
  }
  const dejaVus = new Set();
  return tous.filter((a) => (dejaVus.has(a.link) ? false : dejaVus.add(a.link))).sort((a, b) => (new Date(b.pubDate) || 0) - (new Date(a.pubDate) || 0)).slice(0, 12);
}

/* ==================== 2) Classements (LM Arena & AA) ==================== */
async function recupererLmArena() {
  const reponse = await fetchAvecReprises(LMARENA_API);
  const json = await reponse.json();
  const lignes = (json.rows ?? [])
    .map((r) => r.row)
    .filter((l) => l?.category === "overall" && l.model_name);
  lignes.sort((a, b) => a.rank - b.rank);
  const pool = lignes.slice(0, TAILLE_POOL).map((l) => ({ model: l.model_name, elo: +l.rating, rank: l.rank }));
  const top10 = pool.slice(0, 10).map((m) => ({ rank: m.rank, model: m.model, overall: Math.round(m.elo) }));
  return { fichier: { generated_at_iso: MAINTENANT_ISO, top10_overall: top10, top3_overall: top10.slice(0, 3) }, pool };
}

async function recupererArtificialAnalysis() {
  const cle = process.env.AA_API_KEY;
  if (!cle) throw new Error("AA_API_KEY absente.");
  const reponse = await fetchAvecReprises(AA_API, { headers: { "x-api-key": cle } });
  const json = await reponse.json();
  const pool = (json.data ?? []).map((m) => ({ name: m.name, creator: m.model_creator?.name, index: m.evaluations?.artificial_analysis_intelligence_index })).filter((m) => m.name && Number.isFinite(m.index)).sort((a, b) => b.index - a.index).slice(0, TAILLE_POOL);
  const top10 = pool.slice(0, 10).map((m, i) => ({ rank: i + 1, model: m.name, creator: m.creator, index: arrondi1(m.index) }));
  return { fichier: { generated_at_iso: MAINTENANT_ISO, top10, top3: top10.slice(0, 3) }, pool };
}

/* ==================== 3) Mix, Annuaire (Ping) & Radar ==================== */
// Clé de correspondance robuste entre les deux sources :
// on ignore les parenthèses et les suffixes de variante (thinking, high, preview...)
// pour que "claude-opus-4-6-thinking" <-> "Claude Opus 4.6" se reconnaissent.
const MOTS_VARIANTE = new Set(["thinking","think","high","low","medium","minimal","max","effort","adaptive","reasoning","reasoner","standard","default","latest","preview","exp","experimental","beta","instruct","chat","it","tuned"]);
function cleNormalisee(nom) {
  const s = String(nom ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return s.split(/\s+/).filter((t) => t && !MOTS_VARIANTE.has(t)).join("");
}

function construireMix(poolHumain, poolBench) {
  const normaliseur = (valeurs) => {
    if (valeurs.length === 0) return () => 0;
    const min = Math.min(...valeurs), max = Math.max(...valeurs);
    return (v) => (max === min ? 100 : ((v - min) / (max - min)) * 100);
  };

  const normHumain = normaliseur(poolHumain.map((m) => m.elo));
  const normBench = normaliseur(poolBench.map((m) => m.index));

  const mapModeles = new Map();

  poolHumain.forEach((m) => {
    const cle = cleNormalisee(m.model);
    mapModeles.set(cle, { nomOriginal: m.model, scoreHumain: normHumain(m.elo), scoreBench: 0, coverage: 1, lmarena: { elo: Math.round(m.elo) } });
  });

  poolBench.forEach((m) => {
    const cle = cleNormalisee(m.name);
    if (mapModeles.has(cle)) {
      const existant = mapModeles.get(cle);
      existant.scoreBench = normBench(m.index);
      existant.coverage = 2;
      // on garde le nom AA (plus lisible) une fois apparié
      existant.nomOriginal = m.name;
    } else {
      mapModeles.set(cle, { nomOriginal: m.name, scoreHumain: 0, scoreBench: normBench(m.index), coverage: 1, lmarena: null });
    }
  });

  const mix = Array.from(mapModeles.values()).map((m) => {
    const scoreFinal = (m.coverage === 2)
      ? (m.scoreHumain * POIDS_HUMAIN) + (m.scoreBench * POIDS_BENCH)
      : (m.scoreHumain > 0 ? m.scoreHumain : m.scoreBench);
    return { model: m.nomOriginal, score: arrondi1(scoreFinal), coverage: m.coverage, lmarena: m.lmarena };
  });

  mix.sort((a, b) => b.score - a.score);
  const top10_mix = mix.slice(0, 10).map((m, i) => ({ rank: i + 1, model: m.model, score: m.score, coverage: m.coverage, lmarena: m.lmarena }));
  return { generated_at_iso: MAINTENANT_ISO, top10_mix };
}

/* --- Ping robuste : un refus de bot n'est PAS un site mort --- */
// En-têtes d'un vrai navigateur : Google & co rejettent les UA exotiques.
const ENTETES_NAVIGATEUR = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
};
// Codes qui signifient « je refuse de te répondre », pas « je n'existe plus ».
const CODES_TOLERES = new Set([401, 402, 403, 405, 406, 409, 418, 429, 451, 503, 999]);

async function pingerUrl(url) {
  for (const methode of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method: methode,
        redirect: "follow",
        headers: ENTETES_NAVIGATEUR,
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok || CODES_TOLERES.has(res.status)) return { vivant: true, detail: `${methode} ${res.status}` };
      if (methode === "HEAD") continue; // on retente en GET avant de condamner
      return { vivant: false, detail: `${methode} ${res.status}` };
    } catch (e) {
      if (methode === "HEAD") continue;
      return { vivant: false, detail: `${methode} ${e.name === "TimeoutError" ? "timeout" : e.message}` };
    }
  }
  return { vivant: false, detail: "injoignable" };
}

/* --- Détection de la version la plus RÉCENTE (et non la mieux notée) --- */
function numeroVersion(nom) {
  const m = String(nom).replace(/\([^)]*\)/g, " ").match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split(".").map(Number) : null;
}
function versionPlusGrande(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
// Cherche dans le pool AA le modèle d'un créateur donné dont le numéro est le plus élevé.
// Le motif est testé sur le nom SANS les parenthèses : sinon
// "Claude Fable 5 (..., Opus 4.8 Fallback)" passerait pour un Opus.
function versionLaPlusRecente(pool, createur, motif) {
  let meilleure = null;
  for (const m of pool) {
    if (!new RegExp(createur, "i").test(m.creator ?? "")) continue;
    const nomBase = String(m.name).replace(/\([^)]*\)/g, " ");
    if (!motif.test(nomBase)) continue;
    const v = numeroVersion(m.name);
    if (!v) continue;
    if (!meilleure || versionPlusGrande(v, meilleure.version)) meilleure = { version: v, nom: m.name };
  }
  return meilleure;
}

async function verifierAnnuaire(poolBench) {
  const path = `${DOSSIER_SORTIE}/annuaire.json`;
  const data = JSON.parse(await readFile(path, "utf-8")); // si ça casse ici, la tâche doit échouer bruyamment

  // Visibilité : on montre ce que la source propose réellement.
  const vusAnthropic = poolBench.filter((m) => /anthropic/i.test(m.creator ?? "")).map((m) => m.name);
  const vusOpenAI = poolBench.filter((m) => /openai/i.test(m.creator ?? "")).map((m) => m.name);
  console.log(`   ↳ pool AA — Anthropic : ${vusAnthropic.join(", ") || "(aucun)"}`);
  console.log(`   ↳ pool AA — OpenAI    : ${vusOpenAI.join(", ") || "(aucun)"}`);

  const claude = versionLaPlusRecente(poolBench, "anthropic", /opus/i);
  const gpt = versionLaPlusRecente(poolBench, "openai", /^gpt/i);
  // On reconstruit un libellé stable, quel que soit l'ordre des mots chez AA.
  const claudeLibelle = claude ? `Claude Opus ${claude.version.join(".")}` : null;
  const gptLibelle = gpt ? `GPT-${gpt.version.join(".")}` : null;

  let remplacements = 0;
  const morts = [];
  const ignores = [];

  for (const cat of data) {
    for (const tool of cat.tools) {
      // 1) Mise à jour des versions dans les descriptions
      if (tool.name === "Claude" && claudeLibelle) {
        const avant = tool.desc;
        tool.desc = tool.desc.replace(/Claude\s+Opus\s+[\d.]+/i, claudeLibelle);
        if (avant !== tool.desc) { remplacements++; console.log(`   ↳ Claude : "${claudeLibelle}" (source : ${claude.nom})`); }
      }
      if (tool.name === "ChatGPT" && gptLibelle) {
        const avant = tool.desc;
        tool.desc = tool.desc.replace(/GPT-[\d.]+/i, gptLibelle);
        if (avant !== tool.desc) { remplacements++; console.log(`   ↳ ChatGPT : "${gptLibelle}" (source : ${gpt.nom})`); }
      }

      tool.tags = tool.tags || [];

      // 2) Sites qui refusent toute sonde automatisée : on ne les teste pas.
      //    (flag "nocheck": true dans annuaire.json — à poser à la main, en connaissance de cause)
      if (tool.nocheck) {
        tool.failures = 0;
        tool.tags = tool.tags.filter((t) => t !== "dead");
        ignores.push(tool.name);
        continue;
      }

      // 3) Ping : HEAD puis GET, en-têtes navigateur, refus de bot tolérés
      const { vivant, detail } = await pingerUrl(tool.url);
      tool.failures = vivant ? 0 : (tool.failures || 0) + 1;
      if (tool.failures >= 3 && !tool.tags.includes("dead")) tool.tags.push("dead");
      if (tool.failures === 0) tool.tags = tool.tags.filter((t) => t !== "dead");
      if (!vivant) morts.push(`${tool.name} (${detail}, ${tool.failures} échec(s))`);
    }
  }

  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`   ↳ ${remplacements} description(s) mise(s) à jour.`);
  if (ignores.length) console.log(`   ↳ ping ignoré (nocheck) : ${ignores.join(", ")}`);
  console.log(morts.length ? `   ↳ ne répondent pas : ${morts.join(" | ")}` : "   ↳ tous les liens testés répondent.");
  if (claudeLibelle === null) console.warn("   ⚠ aucun modèle Anthropic Opus trouvé dans le pool AA — description Claude inchangée.");
  return true;
}

async function recupererRadarPH() {
  const token = process.env.PH_TOKEN;
  if (!token) return false;
  const query = `query { posts(first: 8, order: RANKING, topic: "artificial-intelligence") { edges { node { name tagline url } } } }`;
  try {
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const json = await res.json();
    const radar = (json.data?.posts?.edges || []).map(e => ({ name: e.node.name, desc: e.node.tagline, url: e.node.url }));
    await writeFile(`${DOSSIER_SORTIE}/radar.json`, JSON.stringify(radar, null, 2), 'utf-8');
    return true;
  } catch (e) { return false; }
}

/* ============================== Pilotage ============================== */
async function main() {
  await mkdir(DOSSIER_SORTIE, { recursive: true });

  let toutOk = true;
  // Exécute une tâche en isolant ses erreurs : une source qui tombe
  // ne bloque jamais les autres (et donc le commit final a toujours lieu).
  const tache = async (nom, fn) => {
    try { await fn(); console.log(`✅ ${nom}`); }
    catch (e) { toutOk = false; console.error(`❌ ${nom} : ${e.message}`); }
  };

  // Actus
  await tache("Actus", async () => {
    await ecrireJsonSiValide("news.json", await recupererActus(), d => d.length > 0);
  });

  // LM Arena (humain) — on conserve le pool pour le Mix
  let h = null;
  await tache("LM Arena", async () => {
    h = await recupererLmArena();
    await ecrireJsonSiValide("lmarena_overall_top3.json", h.fichier, d => d.top10_overall.length > 0);
  });

  // Artificial Analysis (benchmark)
  let b = null;
  await tache("Artificial Analysis", async () => {
    b = await recupererArtificialAnalysis();
    await ecrireJsonSiValide("benchmark_top10.json", b.fichier, d => d.top10.length > 0);
  });

  // Mix — seulement si les DEUX sources sont disponibles
  if (h && b) {
    await tache("Mix", async () => {
      await ecrireJsonSiValide("mix_top10.json", construireMix(h.pool, b.pool), d => d.top10_mix.length > 0);
    });
  } else {
    console.warn("ℹ Mix ignoré : il manque une des deux sources (humain ou benchmark).");
  }

  // On passe b.pool (les données d'Artificial Analysis) à l'annuaire
  await tache("Annuaire", () => verifierAnnuaire(b ? b.pool : []));
  await tache("Radar", () => recupererRadarPH());

  console.log(toutOk
    ? "✅ Scrape terminé — toutes les sources OK."
    : "⚠ Scrape terminé — certaines sources ont échoué, les autres ont bien été publiées.");
}

// On ne sort JAMAIS en erreur sur un échec partiel : sinon l'étape "commit"
// est sautée et même les données valides ne sont pas publiées.
main().catch((e) => { console.error("Erreur inattendue :", e); });
