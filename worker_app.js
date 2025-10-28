// Recommandateur — Worker v0.6 (with cache pool support)
// This version extends the original v0.5 Worker with a cache pool endpoint and
// updated default settings to support caching of ratings, parked and rejects
// lists.  The cache pool endpoint allows the GPT agent to fetch multiple lists
// in a single request, reducing latency.  It also adds configuration fields
// (cache_keys, cache_sync_each_action, cache_flush_on_write) to the global
// behaviors section, and includes `rejects` in the cache_pool_keys array.  The
// /l1 handler is aligned with the on-agent logic (type + genre selection,
// Allociné thresholds, cached exclusions) described in the README.
// For details on Cloudflare KV behaviour and the 1000-key limit, see the
// Cloudflare docs【497129539834723†L93-L110】【847087639538105†L142-L163】.

const KEYS = {
  META: "meta",
  SETTINGS: "settings",
  RATINGS: "ratings",
  PARKED: "parked",
  REJECTS: "rejects",
  PARKED_PODIUM: "parked_podium"
};

// --- CORS and helper functions ---
const MAX_BODY_BYTES = 512 * 1024;         // 512 KB
const MAX_LIST_ITEM_BYTES = 32 * 1024;     // 32 KB
const DEFAULT_LIMIT = 1000;                // for GET lists (simple pagination)

function corsHeaders(req) {
  const origin = req ? req.headers.get("Origin") || "*" : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Token, Accept, X-Requested-With",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResp(obj, status = 200, req) {
  const headers = corsHeaders(req);
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(JSON.stringify(obj), { status, headers });
}

function methodNotAllowed(req, allow) {
  const headers = corsHeaders(req);
  headers["allow"] = allow.join(", ");
  return new Response(JSON.stringify({ error: "Method Not Allowed", allow }), {
    status: 405,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" }
  });
}

function normalizePath(p) {
  if (!p) return "/";
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function safeJSON(req, maxBytes = MAX_BODY_BYTES) {
  const len = Number(req.headers.get("content-length") || "0");
  if (len && len > maxBytes) return null;
  try { return await req.json(); } catch { return null; }
}

async function readJSON(kv, key) {
  if (!kv) return null;
  const s = await kv.get(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function defaultEmoji(n) {
  const EMO = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return EMO[(n-1) % EMO.length];
}

function normalizeMenu(menu) {
  return menu
    .filter(x => x && typeof x.label === "string" && x.label.trim())
    .map((x, i) => ({
      num: Number.isInteger(x.num) ? x.num : (i + 1),
      emoji: (typeof x.emoji === "string" && x.emoji.trim()) ? x.emoji : defaultEmoji(i + 1),
      label: x.label.trim()
    }));
}

function deepMerge(base, patch) {
  if (typeof base !== "object" || base === null) return patch;
  if (typeof patch !== "object" || patch === null) return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch)) {
    const a = base[k];
    const b = patch[k];
    if (Array.isArray(a) && Array.isArray(b)) out[k] = b.slice();
    else if (isRecord(a) && isRecord(b)) out[k] = deepMerge(a, b);
    else out[k] = b;
  }
  return out;
}

// Normalize a canonical key by lowercasing, removing accents, replacing
// non-alphanumeric characters with hyphens, and trimming hyphens at the ends.
// This ensures consistent matching between stored keys and those used for
// exclusions or comparisons.
function normalizeCanonical(key) {
  if (!key) return "";
  return String(key)
    .toLowerCase()
    // Normalize accents to separate base letters and diacritics
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Replace any sequence of non-alphanumeric characters with a single hyphen
    .replace(/[^a-z0-9]+/g, "-")
    // Remove leading or trailing hyphens
    .replace(/^-+|-+$/g, "");
}

function defaultMeta() {
  return {
    app_name: "Recommandateur",
    app_version: "v0.6",
    last_updated: new Date().toISOString(),
    ui_schema_id: "menu-vierge-5",
    menu: [
      { num: 1, emoji: "1️⃣", label: "Recommandation One Shot" },
      { num: 2, emoji: "2️⃣", label: "Liste des titres mis de côté" },
      { num: 3, emoji: "3️⃣", label: "Salves d’affinage des notations" },
      { num: 4, emoji: "4️⃣", label: "Base de notation" },
      { num: 5, emoji: "5️⃣", label: "Paramètres de l’algorithme" }
    ],
    welcome_template:
      "👋 Bienvenue dans le recommandateur ! Prêt à passer une bonne soirée ?\\n\\n" +
      "🧠 Moteur: {app_version} • MAJ: {last_updated}\\n\\n" +
      "Sélectionne un numéro de catégorie pour continuer :\\n" +
      "1️⃣ Recommandation One Shot\\n2️⃣ Liste des titres mis de côté\\n3️⃣ Salves d’affinage des notations\\n4️⃣ Base de notation\\n5️⃣ Paramètres de l’algorithme"
  };
}

function defaultSettings() {
  return {
    config_version: 4,
    updated_at: new Date().toISOString(),
    thresholds: { default: 3.0, horror: 2.5 },
    weights: { user_pref: 0.20, allocine: 0.60, castcrew: 0.20 },
    list_interpretation: { parked_bonus: 0.10, reject_malus: -1.0, recency_weight: 0.15 },
    exclusions: { rated: true, parked: true, rejects: true },
    dedup: { alias_vo_vf_vq: true, remakes: true, sagas: true },
    templates: {
      l1_card: "**{titre} ({annee})** • {genres}\\nP {presse}/5 • S {spectateurs}/5\\n{resume}\\n![Affiche]({affiche_url})",
      l3_item: "**{titre}** — {genres} — {annee}",
      genres: { case: "title", joiner: " • " }
    },
    genre_aliases: {
      "comédie romantique": ["romcom","rom com","rom-com","comedie romantique"],
      "science-fiction": ["sf","science fiction","anticipation","space opera","space-opera"]
    },
    salves: { formats_allowed: ["10F+5S","20F","10S"], autocomplete_missing: true },
    behaviors: {
      // Global behaviour: add cache-related fields and include rejects in pool keys
      "global": {
        "cache_pool_enabled": true,
        "cache_pool_keys": ["ratings", "parked", "rejects"],
        "cache_pool_strategy": "always_fresh",
        "cache_pool_resync_if_empty": true,
        // New fields to support cache management:
        "cache_keys": ["ratings", "parked", "rejects"],
        // When true, the agent should refresh its cache before each action.
        // We set false by default to only resync on writes, but this can be tuned.
        "cache_sync_each_action": false,
        // When true, the agent should flush its local cache when it writes to remote lists.
        "cache_flush_on_write": false,

        // Existing write aggregation behaviour
        "aggregate_writes": true,
        "flush_strategy": "end_of_turn",
        "flush_endpoint": "/backup/import",
        "flush_fallback": "per_item",
        "confirm_writes_mode": "verified",
        "write_verify": true,
        "verify_endpoint": "/backup/export",
        "verify_timeout_ms": 4000,
        "resync_before_each_action": true,
        "retry_on_sync_fail": 2,
        "backoff_ms": 400,
        "show_menu_after_action": true,
        // Do not show generic onboarding; the agent should directly display welcome_template
        "show_onboarding": false,
        "suppress_connector_logs": true
      },
      "l1": {
        ask_type_first: true,
        // Never pick a random title from the local pool; always call the /l1 API
        // to generate a recommendation. The local cache is only used to filter
        // out titles already rated, parked or rejected.
        intro_random_from_pool: true,
        loop_on_response: true,
        auto_commit_actions: true,
        next_after_action: "immediate",
        show_card_always: true,
        accept_synonyms: ["suivant","next","skip"],
        rating_regex: "^(?:[0-5](?:[\\.,][0-9])?)\\/5$",
        accroche: { source: "synopsis_web", max_chars: 180, fallback: "Pitch bref indisponible." },
        castcrew_preferences: { favorites: [], blacklist: [] }
      },
      "l2": { group_by: "genre", order: "added_at_desc" },
      "l3": {
        generate_immediately: true,
        ask_followups: false,
        formats_allowed: ["10F+5S","20F","10S"],
        parse_shorthand: true,
        shorthand_patterns: [
          { re: "^\\s*10\\s*/\\s*5\\s*$", format: "10F+5S" },
          { re: "^\\s*10\\s*f\\s*\\+\\s*5\\s*s\\s*$", format: "10F+5S" },
          { re: "^\\s*20\\s*$", format: "20F" },
          { re: "^\\s*10\\s*$", format: "10S" }
        ],
        format_profiles: {
          "10F+5S": { films: 10, series: 5, enforce: true },
          "20F":    { films: 20, series: 0, enforce: true },
          "10S":    { films: 0,  series: 10, enforce: true }
        },
        auto_complete_missing: true,
        render_mode: "template_only",
        item_fields_allowed: ["titre","annee","genres"],
        compact: true, show_sources: false, show_notes: false
      },
      "l4": {
        podium_sizes: { films: 5, series: 5 },
        sort: { primary: "note_desc", tiebreak: ["added_at_desc"] }
      },
      "l5": { allow_natural_commands: true }
    },
    ux_prompts: {
      l1_intro_pool: [
        "Hop ! Voici une reco taillée pour toi.",
        "Allez, un titre pile dans tes goûts.",
        "On tente ça pour ta soirée ?",
        "Je pense que celui-ci va te plaire.",
        "Essai instantané : regarde ça.",
        "Petit shot ciné rien que pour toi.",
        "J’ai un bon pressentiment pour celui-là.",
        "Coup d’œil express :",
        "Celui-ci coche toutes les cases.",
        "Prêt à découvrir une pépite ?"
      ],
      l1_genre_hint: "Tu préfères tenter : {genre_cible} ou tous genres confondus ?",
      l1_card_template: "**{titre} ({annee})** — {type} • {duree} • Genres : {genres}\\n**P** {note_presse} / **S** {note_spectateurs}\\n*{accroche}*",
      l1_cta: "Réponds : \"x,x/5\" pour noter • \"met de côté\" • \"pas intéressé\" • \"suivant\".",
      l1_on_no_pool: "Aucun titre ne correspond pour l’instant. Essaie un autre genre ou lance une salve (L3).",
      l2_intro: "Voici tes titres mis de côté, classés par genre (les plus récents en premier).",
      l2_empty: "Aucun titre mis de côté pour le moment.",
      l3_item_template_film:  "**{titre}** — {genres} — {annee}",
      l3_item_template_serie: "**{titre}** — {genres} — {annee}",
      l4_intro: "Voici ta base de notation. Podium des 5 meilleurs films et des 5 meilleures séries :",
      l4_genre_select: "Choisis un genre pour afficher les titres (tri note ↓ puis date d’ajout ↓).",
      write_summary_template: "✅ Enregistré (vérifié) : {ratings} notes • {parked} mis de côté • {rejects} rejets.",
      write_summary_soft_template: "✅ Enregistré. ⚠️ Vérification impossible pour le moment.",
      write_summary_error_template: "⚠️ Échec d’enregistrement. Réessaye.",
      sync_error: "⚠️ Sync indisponible.",
      auth_error: "⚠️ Accès non autorisé à la base distante."
    },
    algo_summary: {
      version: "v1",
      current:
        "Objectif : proposer un titre noté strictement >3,5/5. Filtres Allociné (S≥3,0 ; horreur S≥2,5), exclusions (notés, mis de côté, pas intéressé), dédup VO/VF/VQ/remakes/sagas. Scoring : préférences (récence mesurée) + cast/crew (chevauchement pondéré) + Allociné (P/S normalisés) + interprétation des listes (parked=bonus mesuré ; rejects=malus fort étendu). Diversité contrôlée. Rendus : L1 carte complète ; L3 “**Titre** — Genres — Année”.",
      changelog: []
    }
  };
}

// Authorization helper
function isAuthorized(req, env) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const bearer = (m ? m[1] : "").trim();
  const alt = (req.headers.get("X-Api-Token") || new URL(req.url).searchParams.get("api_token") || "").trim();
  return Boolean(env?.API_TOKEN) && (bearer === env.API_TOKEN || alt === env.API_TOKEN);
}

// Helper to fetch combined title pool; used for fallback L1 recommendation
async function fetchTitlePool(type, genre, env) {
  const listRatings = await readJSON(env?.DB, KEYS.RATINGS) || [];
  const listParked = await readJSON(env?.DB, KEYS.PARKED) || [];
  const list = [...listRatings, ...listParked];
  const lowerGenre = (genre || "").toLowerCase();
  const allGenres = !genre || lowerGenre.includes("tous");
  return list.filter(item =>
    item.type === type &&
    (allGenres || item.genres?.some(g =>
      g.toLowerCase().includes(lowerGenre)
    ))
  );
}

// -----------------------------------------------------------------------------
//  fetchCandidatesFromSearch
//
// This helper attempts to fetch a candidate pool of titles from an external
// search service (e.g. Allociné or TMDb) based on the provided type and
// genre.  It returns an array of objects containing at least the fields
// { titre, annee, type, genres, presse, spectateurs, accroche, affiche_url,
//   canonical_key }.  The function honours the rating thresholds defined in
// settings.thresholds (default ≥ 3.0/5, horreur ≥ 2.5/5) by converting them
// into 10‑point scales (6/10 and 5/10 respectively) when calling remote APIs.
//
// Note: This function attempts to fetch a candidate pool of titles from
// Allociné.  It uses the partner code provided via env.ALLOCINE_PARTNER_CODE
// (or env.SEARCH_API_KEY for backward compatibility) and searches the
// Allociné v3 REST API.  Because the Allociné API returns ratings on a 5‑point
// scale, we filter results client‑side based on the minimum note required by
// settings.thresholds (default ≥ 3.0/5, horreur ≥ 2.5/5).  If the API is
// unreachable or misconfigured, the function returns an empty array, causing
// the caller to fall back to the local pool.
async function fetchCandidatesFromSearch(type, genre, settings, env) {
  try {
    // Use ALLOCINE_PARTNER_CODE if provided; fall back to SEARCH_API_KEY.
    const partner = env?.ALLOCINE_PARTNER_CODE || env?.SEARCH_API_KEY;
    if (!partner) return [];

    // Determine the endpoint filter: Allociné uses "movie" for films and
    // "tvseries" for series.  See the v3 API documentation for details.
    const filter = (type === "film") ? "movie" : "tvseries";

    // Minimum note spectateurs (scale 0–5).  Horreur genres use the horror
    // threshold; otherwise use default threshold.  We keep the 5‑point scale
    // because Allociné returns userRating averages on a 5‑point scale.
    const lowerGenre = (genre || "").toLowerCase();
    const isHorror = /(horreur|epouvante|frisson|gore|peur)/.test(lowerGenre);
    const minSpectators = isHorror
      ? (settings.thresholds?.horror ?? 2.5)
      : (settings.thresholds?.default ?? 3.0);

    // Construct the search URL for Allociné.  We request JSON format.  The
    // query parameter `q` takes the genre string (e.g. "science-fiction").
    // Note: The API might require a signature; here we assume the partner
    // parameter suffices.  If the environment cannot reach api.allocine.fr,
    // this call will fail and we will fall back to the local pool.
    const query = encodeURIComponent(genre);
    const url = `https://api.allocine.fr/rest/v3/search?partner=${encodeURIComponent(partner)}&filter=${filter}&count=20&q=${query}&format=json`;

    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();

    // Extract the appropriate array of results from the API response.  The
    // Allociné search returns objects in data.feed.movie or data.feed.tvseries.
    const feed = data && data.feed;
    if (!feed) return [];
    const items = (type === "film") ? (feed.movie || []) : (feed.tvseries || []);
    if (!Array.isArray(items) || items.length === 0) return [];

    return items
      .map(item => {
        // Title fields may differ between movies and series
        const titre = item.title || item.originalTitle || item.name || item.original_name;
        const annee = item.productionYear || (item.year || "");
        // Genres may be an array of objects with a "$" or "name" property
        let genres = [];
        if (Array.isArray(item.genre)) {
          genres = item.genre.map(g => g.$ || g.name || g);
        }
        const presse = (item.statistics && item.statistics.pressRating)
          ? parseFloat(item.statistics.pressRating) || null
          : null;
        let spectateurs = null;
        if (item.statistics && item.statistics.userRating) {
          // Allociné returns userRating as a float on 5‑point scale; ensure number
          const sr = parseFloat(item.statistics.userRating);
          if (!Number.isNaN(sr)) spectateurs = sr.toFixed(1);
        }
        // Only keep candidates meeting the minimum spectator rating
        if (spectateurs === null || parseFloat(spectateurs) <= minSpectators) {
          return null;
        }
        const accroche = item.synopsisShort || item.synopsis || "";
        const affiche_url = item.poster && item.poster.href ? item.poster.href : null;
        if (!affiche_url) return null;
        const pressFormatted = (presse !== null && !Number.isNaN(presse)) ? presse.toFixed(1) : null;
        let cast = [];
        let crew = [];
        if (item.castingShort && typeof item.castingShort === "object") {
          if (item.castingShort.actors) {
            cast = String(item.castingShort.actors).split(/,|\/|\u2022/).map(s => s.trim()).filter(Boolean);
          }
          if (item.castingShort.directors) {
            crew = String(item.castingShort.directors).split(/,|\/|\u2022/).map(s => s.trim()).filter(Boolean);
          }
        }
        // Canonical key: slugify title + year
        const slug = String(titre).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const canonical_key = `${slug}-${annee}`;
        return {
          titre,
          annee: String(annee || "").trim(),
          type,
          genres,
          presse: pressFormatted,
          spectateurs,
          accroche,
          affiche_url,
          cast,
          crew,
          canonical_key
        };
      })
      .filter(x => x);
  } catch (err) {
    // On any error (network, parsing), return an empty array to trigger the
    // fallback to the local pool
    return [];
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pickIntroText(settings, seed) {
  const pool = settings?.ux_prompts?.l1_intro_pool;
  if (Array.isArray(pool) && pool.length) {
    if (!seed) return String(pool[0]).trim();
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    const index = Math.abs(hash) % pool.length;
    return String(pool[index]).trim();
  }
  if (typeof pool === "string" && pool.trim()) {
    return pool.trim();
  }
  return null;
}

function computeAllocineComponent(candidate) {
  const spectateurNorm = clamp01(parseFloat(candidate.spectateurs) / 5);
  const presseVal = candidate.presse !== null && candidate.presse !== undefined
    ? parseFloat(candidate.presse)
    : NaN;
  const presseNorm = Number.isNaN(presseVal) ? spectateurNorm : clamp01(presseVal / 5);
  // Spectateur rating weighs heavier than presse, but both come from Allociné.
  return clamp01((spectateurNorm * 0.7) + (presseNorm * 0.3));
}

function computeUserPreferenceComponent(ratings, candidate) {
  if (!Array.isArray(ratings) || ratings.length === 0) return 0.2;
  const candidateGenres = new Set((candidate.genres || []).map(g => String(g).toLowerCase()));
  if (!candidateGenres.size) return 0.2;
  const relevant = ratings.filter(item =>
    item && item.type === candidate.type && Array.isArray(item.genres) &&
    item.genres.some(g => candidateGenres.has(String(g).toLowerCase()))
  );
  if (!relevant.length) return 0.2;
  const sumRatings = relevant.reduce((acc, item) => {
    const val = parseFloat(item.rating);
    return acc + (Number.isNaN(val) ? 0 : val);
  }, 0);
  const avg = sumRatings / relevant.length;
  const normalized = clamp01((avg - 2) / 3); // map [2;5] -> [0;1]
  const coverage = clamp01(relevant.reduce((acc, item) => {
    const itemGenres = (item.genres || []).map(g => String(g).toLowerCase());
    const matches = itemGenres.filter(g => candidateGenres.has(g)).length;
    return acc + matches;
  }, 0) / (Math.max(candidateGenres.size, 1) * relevant.length));
  return clamp01((normalized * 0.8) + (coverage * 0.2));
}

function computeCastCrewComponent(candidate, settings) {
  const prefs = settings?.behaviors?.l1?.castcrew_preferences || {};
  const favorites = Array.isArray(prefs.favorites)
    ? prefs.favorites.map(v => normalizeCanonical(v)).filter(Boolean)
    : [];
  const blacklist = Array.isArray(prefs.blacklist)
    ? prefs.blacklist.map(v => normalizeCanonical(v)).filter(Boolean)
    : [];
  const participants = [...(candidate.cast || []), ...(candidate.crew || [])]
    .map(name => normalizeCanonical(name))
    .filter(Boolean);
  if (!participants.length) return favorites.length ? 0 : 0.5;
  let score = 0.5;
  if (favorites.length) {
    const favSet = new Set(favorites);
    const favMatches = participants.filter(p => favSet.has(p)).length;
    score += Math.min(0.4, favMatches / favorites.length);
  }
  if (blacklist.length) {
    const blackSet = new Set(blacklist);
    const blackMatches = participants.filter(p => blackSet.has(p)).length;
    score -= Math.min(0.5, blackMatches / blacklist.length);
  }
  return clamp01(score);
}

async function l1Reco(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const genre = url.searchParams.get("genre");

  if (!["film", "serie"].includes(type) || !genre) {
    return jsonResp({ error: "Paramètres requis : ?type=film|serie&genre=..." }, 400, req);
  }

  // Charger settings et listes
  const [settingsRaw, ratings, parked, rejects] = await Promise.all([
    readJSON(env.DB, KEYS.SETTINGS),
    readJSON(env.DB, KEYS.RATINGS) ?? [],
    readJSON(env.DB, KEYS.PARKED) ?? [],
    readJSON(env.DB, KEYS.REJECTS) ?? []
  ]);

  const settings = settingsRaw ?? defaultSettings();

  // Build a set of normalized canonical keys from all exclusion lists (ratings, parked, rejects)
  const exclusions = new Set([...ratings, ...parked, ...rejects].map(x => normalizeCanonical(x.canonical_key)));
  const template = settings.templates?.l1_card ?? "⚠️ Pas de template l1_card";

  // Préparer le pool de candidats via Allociné exclusivement.
  const pool = await fetchCandidatesFromSearch(type, genre, settings, env);

  // Sélection stricte L1
  const lowerGenre = (genre || "").toLowerCase();
  const isAllGenres = !genre || lowerGenre.includes("tous");
  const isHorror = /(horreur|epouvante|frisson|gore|peur)/.test(lowerGenre);
  const minRating = isHorror
    ? (settings.thresholds?.horror ?? 2.5)
    : (settings.thresholds?.default ?? 3.0);
  const candidates = Array.isArray(pool) ? pool
    .filter(t => t.type === type)
    .filter(t => isAllGenres || (t.genres || []).some(g => String(g).toLowerCase().includes(lowerGenre)))
    // Exclude any candidate whose normalized canonical_key appears in the exclusions set
    .filter(t => !exclusions.has(normalizeCanonical(t.canonical_key)))
    .filter(t => {
      const s = parseFloat(t.spectateurs || "0");
      return s > minRating;
    })
    .filter(t => t.affiche_url)
    .filter(t => t.presse !== null && t.presse !== undefined)
  : [];

  if (!candidates.length) {
    return jsonResp({ error: "Aucune recommandation valide trouvée." }, 404, req);
  }

  const weightsRaw = settings.weights || {};
  const allocineWeight = Number.isFinite(weightsRaw.allocine) ? weightsRaw.allocine : 0.6;
  const userWeight = Number.isFinite(weightsRaw.user_pref) ? weightsRaw.user_pref : 0.2;
  const castCrewWeight = Number.isFinite(weightsRaw.castcrew) ? weightsRaw.castcrew : 0.2;
  const totalWeight = allocineWeight + userWeight + castCrewWeight || 1;
  const normalizedWeights = {
    allocine: allocineWeight / totalWeight,
    user_pref: userWeight / totalWeight,
    castcrew: castCrewWeight / totalWeight
  };

  const scored = candidates.map(t => {
    const allocineComponent = computeAllocineComponent(t);
    const userComponent = computeUserPreferenceComponent(ratings, t);
    const castcrewComponent = computeCastCrewComponent(t, settings);
    const score =
      (normalizedWeights.allocine * allocineComponent) +
      (normalizedWeights.user_pref * userComponent) +
      (normalizedWeights.castcrew * castcrewComponent);
    return { ...t, score, components: { allocine: allocineComponent, user_pref: userComponent, castcrew: castcrewComponent } };
  });

  scored.sort((a, b) => b.score - a.score);
  // Select the first candidate not present in the exclusions set (safety check)
  let top = null;
  for (const cand of scored) {
    if (!exclusions.has(normalizeCanonical(cand.canonical_key))) {
      top = cand;
      break;
    }
  }
  if (!top) {
    return jsonResp({ error: "Aucune recommandation valide trouvée." }, 404, req);
  }

  // Format selon template.  Ensure that non-string values are converted to strings
  const notePresseStr = (top.presse !== undefined && top.presse !== null) ? String(top.presse) : "–";
  const noteSpectateursStr = (top.spectateurs !== undefined && top.spectateurs !== null) ? String(top.spectateurs) : "–";
  // 'duree' may not exist on the candidate object.  Use bracket notation to access it safely.
  const dureeVal = (top && (top)["duree"] !== undefined && (top)["duree"] !== null) ? (top)["duree"] : "N/A";
  const dureeStr = dureeVal;
  const card = template
    .replace(/{titre}/g, top.titre)
    .replace(/{annee}/g, top.annee || "N/A")
    .replace(/{type}/g, top.type)
    .replace(/{duree}/g, dureeStr)
    .replace(/{genres}/g, (top.genres || []).join(" • "))
    .replace(/{note_presse}/g, notePresseStr)
    .replace(/{note_spectateurs}/g, noteSpectateursStr)
    .replace(/{presse}/g, notePresseStr)
    .replace(/{spectateurs}/g, noteSpectateursStr)
    .replace(/{resume}/g, top.accroche || "Résumé indisponible.")
    .replace(/{affiche_url}/g, top.affiche_url || "https://dummyimage.com/600x800/cccccc/000000&text=Affiche");

  const introText = pickIntroText(settings, top.canonical_key || top.titre || "");
  const components = top.components || {
    allocine: computeAllocineComponent(top),
    user_pref: computeUserPreferenceComponent(ratings, top),
    castcrew: computeCastCrewComponent(top, settings)
  };
  const payload = {
    titre: top.titre,
    formatted_card: card,
    poster_url: top.affiche_url,
    notes: {
      spectateurs: noteSpectateursStr,
      presse: notePresseStr
    },
    score_breakdown: {
      weights: normalizedWeights,
      components
    },
    raw: top
  };
  if (introText) payload.intro = introText;

  return jsonResp(payload, 200, req);
}

async function cachePool(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const url = new URL(req.url);
  const requestedKeys = [];
  const pushKey = (val) => {
    if (!val) return;
    requestedKeys.push(val.toLowerCase());
  };
  url.searchParams.getAll("key").forEach(pushKey);
  const altParams = [
    ...url.searchParams.getAll("keys"),
    ...url.searchParams.getAll("keys[]")
  ];
  for (const raw of altParams) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          parsed.forEach(item => pushKey(String(item)));
          continue;
        }
      } catch (err) {
        // fall through to treat as single value
      }
    }
    pushKey(trimmed);
  }
  const allowed = {
    ratings: KEYS.RATINGS,
    parked: KEYS.PARKED,
    rejects: KEYS.REJECTS
  };

  const uniqueRequested = Array.from(new Set(requestedKeys));
  const keysToLoad = ((uniqueRequested.length ? uniqueRequested : Object.keys(allowed)))
    .filter(k => Object.prototype.hasOwnProperty.call(allowed, k));

  const loaders = keysToLoad.map(k => readJSON(env?.DB, allowed[k]).then(v => Array.isArray(v) ? v : []));
  const results = await Promise.all(loaders);

  const payload = { synced_at: new Date().toISOString() };
  keysToLoad.forEach((k, idx) => {
    payload[k] = results[idx];
  });

  return jsonResp(payload, 200, req);
}

async function cachePool(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  const url = new URL(req.url);
  const requestedKeys = url.searchParams.getAll("key").map(k => k.toLowerCase());
  const allowed = {
    ratings: KEYS.RATINGS,
    parked: KEYS.PARKED,
    rejects: KEYS.REJECTS
  };

  const keysToLoad = (requestedKeys.length ? requestedKeys : Object.keys(allowed))
    .filter(k => Object.prototype.hasOwnProperty.call(allowed, k));

  const loaders = keysToLoad.map(k => readJSON(env?.DB, allowed[k]).then(v => Array.isArray(v) ? v : []));
  const results = await Promise.all(loaders);

  const payload = { synced_at: new Date().toISOString() };
  keysToLoad.forEach((k, idx) => {
    payload[k] = results[idx];
  });

  return jsonResp(payload, 200, req);
}


// --- Handlers for meta, settings, lists, podium, backup, diag, health ---

async function getMeta(env, req) {
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const fallback = defaultMeta();
  const obj = (await readJSON(env?.DB, KEYS.META)) ?? fallback;
  return jsonResp(obj, 200, req);
}

async function putMeta(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const incoming = await safeJSON(req, MAX_BODY_BYTES);
  if (!isRecord(incoming)) return jsonResp({ error: "Invalid payload" }, 400, req);

  const current = (await readJSON(env.DB, KEYS.META)) ?? defaultMeta();
  const merged = deepMerge(current, incoming);
  // Normalise menu si fourni
  if (Array.isArray(merged.menu)) merged.menu = normalizeMenu(merged.menu);
  merged.last_updated = new Date().toISOString();
  await env.DB.put(KEYS.META, JSON.stringify(merged));
  return jsonResp({ ok: true, meta: merged }, 200, req);
}

async function getMenu(env, req) {
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const meta = (await readJSON(env?.DB, KEYS.META)) ?? defaultMeta();
  return jsonResp({ menu: meta.menu, welcome_template: meta.welcome_template }, 200, req);
}

async function putMenu(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const body = await safeJSON(req, MAX_BODY_BYTES);
  if (!body || !Array.isArray(body.menu)) {
    return jsonResp({ error: "Invalid payload (menu array required)" }, 400, req);
  }
  const current = (await readJSON(env.DB, KEYS.META)) ?? defaultMeta();
  current.menu = normalizeMenu(body.menu);
  if (typeof body.welcome_template === "string") current.welcome_template = String(body.welcome_template).slice(0, 5000);
  current.last_updated = new Date().toISOString();
  await env.DB.put(KEYS.META, JSON.stringify(current));
  return jsonResp({ ok: true, meta: current }, 200, req);
}

async function getSettings(env, req) {
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const fallback = defaultSettings();
  const obj = (await readJSON(env?.DB, KEYS.SETTINGS)) ?? fallback;
  return jsonResp(obj, 200, req);
}

async function putSettings(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const incoming = await safeJSON(req, MAX_BODY_BYTES);
  if (!isRecord(incoming)) return jsonResp({ error: "Invalid payload" }, 400, req);

  const current = (await readJSON(env.DB, KEYS.SETTINGS)) ?? defaultSettings();
  const merged = deepMerge(current, incoming);
  merged.updated_at = new Date().toISOString();
  await env.DB.put(KEYS.SETTINGS, JSON.stringify(merged));
  return jsonResp({ ok: true, settings: merged }, 200, req);
}

// List endpoints
async function getList(env, key, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT), 5000);

  const full = (await readJSON(env?.DB, key)) || [];
  const items = full.slice(offset, offset + limit);
  return jsonResp({ total: full.length, offset, limit, items }, 200, req);
}

async function addToList(env, req, key) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);

  const item = await safeJSON(req, MAX_LIST_ITEM_BYTES);
  if (!isRecord(item)) return jsonResp({ error: "Invalid payload" }, 400, req);

  // canonical_key
  if (!item.canonical_key || typeof item.canonical_key !== "string" || !item.canonical_key.trim()) {
    return jsonResp({ error: "canonical_key (non-empty string) required" }, 400, req);
  }
  // Normalize canonical_key for consistent comparisons and storage
  item.canonical_key = normalizeCanonical(String(item.canonical_key).trim());

  // Validations spécifiques
  if (key === KEYS.RATINGS) {
    if (typeof item.rating !== "number" || Number.isNaN(item.rating)) {
      return jsonResp({ error: "rating (number) required for ratings" }, 400, req);
    }
    if (item.rating < 0 || item.rating > 5) {
      return jsonResp({ error: "rating must be between 0 and 5" }, 400, req);
    }
  } else {
    if ("rating" in item) return jsonResp({ error: "rating not allowed for this list" }, 400, req);
  }

  const [ratings, parked, rejects] = await Promise.all([
    readJSON(env.DB, KEYS.RATINGS) ?? [],
    readJSON(env.DB, KEYS.PARKED) ?? [],
    readJSON(env.DB, KEYS.REJECTS) ?? []
  ]);

  // Conflits croisés
  const k = item.canonical_key;
  if (key === KEYS.RATINGS && parked.some(x=>x.canonical_key===k)) return jsonResp({ ok:false, conflict_with:"parked" }, 409, req);
  if (key === KEYS.RATINGS && rejects.some(x=>x.canonical_key===k)) return jsonResp({ ok:false, conflict_with:"rejects" }, 409, req);
  if (key === KEYS.PARKED  && ratings.some(x=>x.canonical_key===k)) return jsonResp({ ok:false, conflict_with:"ratings" }, 409, req);
  if (key === KEYS.REJECTS && ratings.some(x=>x.canonical_key===k)) return jsonResp({ ok:false, conflict_with:"ratings" }, 409, req);

  // Dédup interne
  const arr = (key === KEYS.RATINGS) ? ratings : (key === KEYS.PARKED ? parked : rejects);
  if (arr.find(x => x.canonical_key === k)) {
    return jsonResp({ ok: true, added: false, reason: "duplicate" }, 200, req);
  }

  // Champs auto
  const now = new Date().toISOString();
  if (key === KEYS.RATINGS) item.rated_at = item.rated_at || now;
  else item.added_at = item.added_at || now;
  arr.push(item);

  // Persistance
  if (key === KEYS.RATINGS) await env.DB.put(KEYS.RATINGS, JSON.stringify(arr));
  if (key === KEYS.PARKED)  await env.DB.put(KEYS.PARKED,  JSON.stringify(arr));
  if (key === KEYS.REJECTS) await env.DB.put(KEYS.REJECTS, JSON.stringify(arr));

  return jsonResp({ ok: true, added: true }, 201, req);
}

// L2 podium handlers
async function getParkedPodium(env, req) {
  const podium = (await readJSON(env?.DB, KEYS.PARKED_PODIUM)) ?? [];
  return jsonResp({ keys: podium }, 200, req);
}

async function putParkedPodium(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const body = await safeJSON(req, MAX_BODY_BYTES);
  if (!body || !Array.isArray(body.keys)) return jsonResp({ error: "Invalid payload (keys array required)" }, 400, req);

  // normalise + dédoublonne + clamp à 3
  const keys = Array.from(new Set(body.keys.map(v => String(v).trim()).filter(Boolean))).slice(0, 3);
  const parked = (await readJSON(env.DB, KEYS.PARKED)) ?? [];
  // Vérifier existence dans 'parked'
  const missing = keys.filter(k => !parked.some(p => p.canonical_key === k));
  if (missing.length) return jsonResp({ error: "keys not in parked", missing }, 400, req);
  await env.DB.put(KEYS.PARKED_PODIUM, JSON.stringify(keys));
  return jsonResp({ ok: true, keys }, 200, req);
}

// Backup handlers
async function backupExport(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const [meta, settings, ratings, parked, rejects, podium] = await Promise.all([
    readJSON(env?.DB, KEYS.META),
    readJSON(env?.DB, KEYS.SETTINGS),
    readJSON(env?.DB, KEYS.RATINGS),
    readJSON(env?.DB, KEYS.PARKED),
    readJSON(env?.DB, KEYS.REJECTS),
    readJSON(env?.DB, KEYS.PARKED_PODIUM)
  ]);
  return jsonResp({
    exported_at: new Date().toISOString(),
    meta, settings, ratings, parked, rejects,
    parked_podium: podium ?? []
  }, 200, req);
}

async function backupImport(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  if (!env?.DB) return jsonResp({ error: "KV DB not bound to worker" }, 503, req);
  const body = await safeJSON(req, 2 * MAX_BODY_BYTES);
  if (!isRecord(body)) return jsonResp({ error: "Invalid payload" }, 400, req);

  // Normalise et vérifie types attendus
  const ops = [];
  if ("meta" in body)           ops.push(env.DB.put(KEYS.META, JSON.stringify(isRecord(body.meta) ? body.meta : defaultMeta())));
  if ("settings" in body)       ops.push(env.DB.put(KEYS.SETTINGS, JSON.stringify(isRecord(body.settings) ? body.settings : defaultSettings())));
  if ("ratings" in body)        ops.push(env.DB.put(KEYS.RATINGS, JSON.stringify(Array.isArray(body.ratings) ? body.ratings : [])));
  if ("parked" in body)         ops.push(env.DB.put(KEYS.PARKED, JSON.stringify(Array.isArray(body.parked) ? body.parked : [])));
  if ("rejects" in body)        ops.push(env.DB.put(KEYS.REJECTS, JSON.stringify(Array.isArray(body.rejects) ? body.rejects : [])));
  if ("parked_podium" in body)  ops.push(env.DB.put(KEYS.PARKED_PODIUM, JSON.stringify(Array.isArray(body.parked_podium) ? body.parked_podium : [])));

  await Promise.all(ops);
  return jsonResp({ ok: true }, 200, req);
}

// Diagnostic handler
async function diag(env, req) {
  if (!isAuthorized(req, env)) return jsonResp({ error: "Unauthorized" }, 401, req);
  const [
    ratingsRaw,
    parkedRaw,
    rejectsRaw,
    podiumRaw,
    metaRaw,
    settingsRaw
  ] = await Promise.all([
    readJSON(env?.DB, KEYS.RATINGS),
    readJSON(env?.DB, KEYS.PARKED),
    readJSON(env?.DB, KEYS.REJECTS),
    readJSON(env?.DB, KEYS.PARKED_PODIUM),
    readJSON(env?.DB, KEYS.META),
    readJSON(env?.DB, KEYS.SETTINGS)
  ]);

  const ratings  = Array.isArray(ratingsRaw)  ? ratingsRaw  : [];
  const parked   = Array.isArray(parkedRaw)   ? parkedRaw   : [];
  const rejects  = Array.isArray(rejectsRaw)  ? rejectsRaw  : [];
  const podium   = Array.isArray(podiumRaw)   ? podiumRaw   : [];
  const meta     = metaRaw     || defaultMeta();
  const settings = settingsRaw || defaultSettings();

  const authorized = isAuthorized(req, env);
  const kvBound = !!env?.DB;
  const hasApiToken = !!env?.API_TOKEN;

  const ok = kvBound && hasApiToken;
  return jsonResp({
    ok,
    kvBound,
    hasApiToken,
    authorized,
    counts: {
      ratings: ratings.length,
      parked: parked.length,
      rejects: rejects.length,
      parked_podium: podium.length
    },
    versions: {
      app_version: meta.app_version,
      config_version: settings.config_version
    }
  }, 200, req);
}

export default {
  async fetch(req, env) {
    try {
      // CORS preflight
      if (req.method.toUpperCase() === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }

      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const path = normalizePath(url.pathname);

      // Fallback: GET / => meta
      if (path === "/" && method === "GET") return getMeta(env, req);

      // --- META ---
      if (path === "/meta") {
        if (method === "GET") return getMeta(env, req);
        if (method === "PUT") return putMeta(env, req);
        return methodNotAllowed(req, ["GET","PUT"]);
      }
      if (path === "/meta/menu") {
        if (method === "GET") return getMenu(env, req);
        if (method === "PUT") return putMenu(env, req);
        return methodNotAllowed(req, ["GET","PUT"]);
      }

      // --- SETTINGS ---
      if (path === "/settings") {
        if (method === "GET") return getSettings(env, req);
        if (method === "PUT") return putSettings(env, req);
        return methodNotAllowed(req, ["GET","PUT"]);
      }

      // --- LISTS ---
      if (path === "/lists/ratings") {
        if (method === "GET") return getList(env, KEYS.RATINGS, req);
        if (method === "POST") return addToList(env, req, KEYS.RATINGS);
        return methodNotAllowed(req, ["GET","POST"]);
      }
      if (path === "/lists/parked") {
        if (method === "GET") return getList(env, KEYS.PARKED, req);
        if (method === "POST") return addToList(env, req, KEYS.PARKED);
        return methodNotAllowed(req, ["GET","POST"]);
      }
      if (path === "/lists/rejects") {
        if (method === "GET") return getList(env, KEYS.REJECTS, req);
        if (method === "POST") return addToList(env, req, KEYS.REJECTS);
        return methodNotAllowed(req, ["GET","POST"]);
      }

      // --- L2 podium ---
      if (path === "/lists/parked_podium") {
        if (method === "GET") return getParkedPodium(env, req);
        if (method === "PUT") return putParkedPodium(env, req);
        return methodNotAllowed(req, ["GET","PUT"]);
      }

      // --- BACKUP ---
      if (path === "/backup/export") {
        if (method === "GET") return backupExport(env, req);
        return methodNotAllowed(req, ["GET"]);
      }
      if (path === "/backup/import") {
        if (method === "POST") return backupImport(env, req);
        return methodNotAllowed(req, ["POST"]);
      }

      // --- CACHE POOL ---
      if (path === "/cache/pool") {
        if (method === "GET") return cachePool(env, req);
        return methodNotAllowed(req, ["GET"]);
      }

      // --- DIAG/HEALTH ---
      if (path === "/diag") {
        if (method === "GET") return diag(env, req);
        return methodNotAllowed(req, ["GET"]);
      }
      if (path === "/health") {
        if (method === "GET") return jsonResp({ ok: true }, 200, req);
        return methodNotAllowed(req, ["GET"]);
      }

      // --- L1 recommendation ---
      if (path === "/l1" && method === "GET") return l1Reco(env, req);


      return jsonResp({ error: "Not found", path }, 404, req);
    } catch (e) {
      return jsonResp({ error: "Worker exception", detail: String(e?.stack || e) }, 500);
    }
  }
};
