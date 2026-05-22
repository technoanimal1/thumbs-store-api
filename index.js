/**
 * thumbs.store API v4
 * XLS upload + per-client game access + multi-aggregator
 *
 * CLIENT ROUTES  (x-api-key: ts_xxxx)
 *   GET  /api/thumbnails              → only their specific games
 *   GET  /api/thumbnails/:game_id     → single game thumbnail
 *
 * ADMIN ROUTES  (x-admin-key: your_secret)
 *   GET    /admin/clients                        → all clients + game counts
 *   POST   /admin/clients                        → create client
 *   POST   /admin/clients/:id/suspend            → suspend
 *   POST   /admin/clients/:id/reinstate          → reinstate
 *   PATCH  /admin/clients/:id                    → update notes
 *   POST   /admin/clients/:id/upload-games       → upload XLS → match → assign games
 *   GET    /admin/clients/:id/games              → list client's assigned games
 *   DELETE /admin/clients/:id/games/:mapping_id  → remove one game
 *   POST   /admin/sync/:aggregator_slug          → pull catalog from any aggregator
 *   POST   /admin/publish/:provider_slug         → export Figma → Supabase Storage
 *   GET    /admin/aggregators                    → list all aggregators
 *   POST   /admin/aggregators                    → add new aggregator
 *   GET    /health
 */

import express  from "express";
import fetch    from "node-fetch";
import multer   from "multer";
import xlsx     from "xlsx";
import { createClient } from "@supabase/supabase-js";

const app     = express();
const upload  = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────────

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const ADMIN_KEY   = process.env.ADMIN_KEY || "change_this_secret";
const PORT        = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL || "https://cdwplbjjjbpqkmytlmaf.supabase.co",
  process.env.SUPABASE_KEY
);

const providerCodes = {
    'st8':              'ST8',
    'egt-amusnet':      'EGT_AMUSNET',
    'egt-digital':      'EGT_DIGITAL',
    'aviator':          'AVIATOR',
    'pragmatic':        'PRAGMATIC',
    'red-tiger':        'RED_TIGER',
    'netent':           'NETENT',
    'relax-gaming':     'RELAX_GAMING',
    'habanero':         'HABANERO',
    'endorphina':       'ENDORPHINA',
    'nolimit-city':     'NOLIMIT_CITY',
    '3-oaks-gaming':    '3_OAKS_GAMING',
    'spinomenal':       'SPINOMENAL',
    'big-time-gaming':  'BIG_TIME_GAMING',
    'hacksaw-gaming':   'HACKSAW_GAMING',
    'bgaming':          'BGAMING',
    'rubyplay':         'RUBYPLAY',
    'lambda':           'LAMBDA',
    'gr8':              'GR8',
    'lucky-streak':     'LUCKY_STREAK',
    'flappybet':        'FLAPPYBET',
    'evolution':        'EVOLUTION',
    'playson':          'PLAYSON',
    'wazdan':           'WAZDAN',
    'yggdrasil':        'YGGDRASIL',
    'play-n-go':        'PLAYNGO',
};
// ─── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Export a Figma frame and return image Buffer */
async function exportFigmaNode(fileKey, nodeId, format = "png") {
  if (!FIGMA_TOKEN) throw new Error("FIGMA_TOKEN not set");
  const res = await fetch(
    `https://api.figma.com/v1/images/${fileKey}?ids=${nodeId}&format=${format}&scale=1`,
    { headers: { "X-Figma-Token": FIGMA_TOKEN } }
  );
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data    = await res.json();
  const tempUrl = Object.values(data.images || {})[0];
  if (!tempUrl) throw new Error(`No image returned for ${nodeId}`);
  const imgRes  = await fetch(tempUrl);
  return Buffer.from(await imgRes.arrayBuffer());
}

/** Upload buffer to Supabase Storage */
async function uploadToStorage(buffer, path, contentType = "image/png") {
  const { error } = await supabase.storage
    .from("thumbnails")
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Storage: ${error.message}`);
  return supabase.storage.from("thumbnails").getPublicUrl(path).data.publicUrl;
}

// Known provider prefixes that Slotegrator prepends to game names
// e.g. "Play'n GO Mole Digger" → strip "Play'n GO" → "Mole Digger"
const PROVIDER_PREFIXES = [
  "play'n go", "playn go", "play n go", "playng go",
  "pragmatic play", "pragmaticplay",
  "evolution gaming", "evolution",
  "netent", "net ent",
  "nolimit city", "nolimitcity",
  "push gaming", "pushgaming",
  "hacksaw gaming", "hacksawgaming",
  "relax gaming", "relaxgaming",
  "blueprint gaming", "blueprintgaming",
  "big time gaming", "bigtimegaming",
  "red tiger", "redtiger",
  "quickspin",
  "yggdrasil",
  "thunderkick",
  "elk studios", "elkstudios",
  "iron dog studio",
  "stakelogic",
  "kalamba games",
  "fantasma games",
];

/** Strip known provider prefix from a game name */
function stripProviderPrefix(gameName) {
  const lower = gameName.toLowerCase();
  for (const prefix of PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix + " ")) {
      return gameName.slice(prefix.length + 1).trim();
    }
  }
  return gameName;
}

/** Match game name to best Figma slug */
function bestFigmaMatch(gameName, figmaGames) {
  // Try with original name first, then with prefix stripped
  const namesToTry = [gameName, stripProviderPrefix(gameName)];

  for (const name of namesToTry) {
    const target = slugify(name);
    const exact  = figmaGames.find(g => g.slug === target);
    if (exact) return { ...exact, confidence: 1 };
  }

  // Best partial overlap across both name variants
  let best = null, bestScore = 0;
  for (const name of namesToTry) {
    const target = slugify(name);
    for (const g of figmaGames) {
      const keyWords    = new Set(g.slug.split("-").filter(Boolean));
      const targetWords = target.split("-").filter(Boolean);
      const hits        = targetWords.filter(w => keyWords.has(w)).length;
      const score       = hits / Math.max(keyWords.size, targetWords.length);
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        best = { ...g, confidence: parseFloat(score.toFixed(2)) };
      }
    }
  }
  return best;
}

/**
 * Parse XLS/CSV file buffer → array of game objects
 * Tries to detect uuid, game_name, provider columns automatically
 */
function parseGamesFromXLS(buffer) {
  const workbook  = xlsx.read(buffer, { type: "buffer" });
  const sheet     = workbook.Sheets[workbook.SheetNames[0]];
  const rows      = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  if (!rows.length) throw new Error("XLS file is empty");

  // Auto-detect column names (case insensitive)
  const sample    = rows[0];
  const keys      = Object.keys(sample);

  const uuidCol   = keys.find(k => /uuid|id|game_id/i.test(k));
  const nameCol   = keys.find(k => /name|title|game_name/i.test(k));
  const provCol   = keys.find(k => /provider|studio|vendor/i.test(k));

  if (!uuidCol) throw new Error(`Could not find UUID column. Columns found: ${keys.join(", ")}`);
  if (!nameCol) throw new Error(`Could not find game name column. Columns found: ${keys.join(", ")}`);

  return rows.map(row => ({
    uuid:     String(row[uuidCol] || "").trim(),
    name:     String(row[nameCol] || "").trim(),
    provider: provCol ? String(row[provCol] || "").trim() : "",
  })).filter(r => r.uuid && r.name);
}

// ─── Middleware ────────────────────────────────────────────────────────────────

async function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header" });

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, name, slug, is_active")
    .eq("api_key", apiKey)
    .single();

  if (error || !client) return res.status(401).json({ error: "Invalid API key" });
  if (!client.is_active) return res.status(403).json({ error: "Account suspended. Contact thumbs.store." });

  req.client = client;
  next();
}

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── CLIENT ROUTES ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const { count } = await supabase
    .from("catalog_mappings")
    .select("*", { count: "exact", head: true });
  res.json({ status: "ok", total_mappings: count });
});

// GET /api/thumbnails — only returns THIS client's specific games
app.get("/api/thumbnails", requireApiKey, async (req, res) => {
  const { page = 1, limit = 50 } = req.query;

  const { data, error } = await supabase
    .from("client_games")
    .select(`
      catalog_mappings (
        aggregator_uuid,
        game_name,
        game_type,
        match_confidence,
        synced_at,
        providers ( slug, name ),
        figma_games ( storage_url, published_at )
      )
    `)
    .eq("client_id", req.client.id)
    .range((Number(page) - 1) * Number(limit), Number(page) * Number(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    client:  req.client.name,
    page:    Number(page),
    limit:   Number(limit),
    results: (data || []).map(row => {
      const m = row.catalog_mappings;
      return {
        game_id:          m.aggregator_uuid,
        game_name:        m.game_name,
        provider:         m.providers?.name,
        provider_code:    providerCodes[m.providers?.slug] || null,
      provider_slug:    m.providers?.slug,
      provider_code:    providerCodes[m.providers?.slug] || null,
      provider_slug:    m.providers?.slug,
        type:             m.game_type,
        thumbnail_url:    m.figma_games?.storage_url || null,
        published_at:     m.figma_games?.published_at || null,
        match_confidence: m.match_confidence,
      };
    }),
  });
});

// GET /api/thumbnails/:game_id
app.get("/api/thumbnails/:game_id", requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from("client_games")
    .select(`
      catalog_mappings (
        aggregator_uuid, game_name, game_type,
        figma_node_id, figma_file_key, match_confidence, synced_at,
        providers ( slug, name ),
        figma_games ( storage_url, published_at )
      )
    `)
    .eq("client_id", req.client.id)
    .eq("catalog_mappings.aggregator_uuid", req.params.game_id)
    .single();

  if (error || !data) return res.status(404).json({ error: "Game not found or not licensed" });

  const m = data.catalog_mappings;
  res.json({
    game_id:          m.aggregator_uuid,
    game_name:        m.game_name,
    provider:         m.providers?.name,
    provider_code:    providerCodes[m.providers?.slug] || null,
      provider_slug:    m.providers?.slug,
    type:             m.game_type,
    thumbnail_url:    m.figma_games?.storage_url || null,
    published_at:     m.figma_games?.published_at || null,
    match_confidence: m.match_confidence,
    ratio:            "1:1.414",
    format:           "png",
    synced_at:        m.synced_at,
  });
});


// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /admin/clients
// ============ /v1/* — versioned API for integrations ============
// Aliases /api/thumbnails into a versioned namespace + adds nested
// provider→games shape that Setantabet's integration expects.

app.get("/v1/account", requireApiKey, async (req, res) => {
  try {
    const c = req.client;
    const { data: cpRows } = await supabase
      .from("client_providers")
      .select("provider_id")
      .eq("client_id", c.id);
    const provIds = (cpRows || []).map(r => r.provider_id).filter(Boolean);
    const { data: provs } = provIds.length
      ? await supabase.from("providers").select("slug,name").in("id", provIds)
      : { data: [] };
    const { count } = await supabase
      .from("client_games")
      .select("*", { count: "exact", head: true })
      .eq("client_id", c.id);
    res.json({
      client: c.name,
      slug: c.slug,
      providers: (provs || []).map(p => ({
        slug: p.slug,
        name: p.name,
        code: (typeof providerCodes !== "undefined" && providerCodes[p.slug]) || null
      })),
      total_games: count || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/v1/games", requireApiKey, async (req, res) => {
  try {
    const c = req.client;
    const PAGE = 1000;
    let rows = [];
    let offset = 0;
    while (true) {
      let q = supabase
        .from("client_game_view")
        .select("*")
        .eq("client_id", c.id);
      if (req.query.provider) q = q.eq("provider_slug", req.query.provider);
      const { data, error } = await q.range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
      if (offset > 50000) break;
    }
    const byProv = {};
    for (const r of rows) {
      if (!r.provider_slug) continue;
      if (!byProv[r.provider_slug]) {
        byProv[r.provider_slug] = {
          slug: r.provider_slug,
          name: r.provider_name,
          code: (typeof providerCodes !== "undefined" && providerCodes[r.provider_slug]) || null,
          games: []
        };
      }
      byProv[r.provider_slug].games.push({
        id: r.slotegrator_uuid || r.catalog_mapping_id,
        provider_slug: r.provider_slug,
        name: r.game_name,
        slug: r.figma_slug || null,
        type: r.slotegrator_type || "slots",
        thumbnail_url: r.storage_url || null,
        published_at: r.published_at || null
      });
    }
    const providers = Object.values(byProv).sort((a, b) => a.slug.localeCompare(b.slug));
    res.json({
      client: c.name,
      total_providers: providers.length,
      total_games: providers.reduce((s, p) => s + p.games.length, 0),
      providers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/v1/games/:game_id", requireApiKey, async (req, res) => {
  try {
    const c = req.client;
    const { data: cmRow } = await supabase
      .from("catalog_mappings")
      .select("id, game_name, slotegrator_uuid, slotegrator_type, provider_id, figma_game_id")
      .or(`id.eq.${req.params.game_id},slotegrator_uuid.eq.${req.params.game_id}`)
      .maybeSingle();
    if (!cmRow) return res.status(404).json({ error: "game not found" });
    const { data: scope } = await supabase
      .from("client_games")
      .select("id")
      .eq("client_id", c.id)
      .eq("catalog_mapping_id", cmRow.id)
      .maybeSingle();
    if (!scope) return res.status(404).json({ error: "game not in your scope" });
    const { data: prov } = await supabase
      .from("providers").select("slug,name").eq("id", cmRow.provider_id).maybeSingle();
    const { data: fg } = cmRow.figma_game_id
      ? await supabase.from("figma_games")
          .select("slug,storage_url,published_at").eq("id", cmRow.figma_game_id).maybeSingle()
      : { data: null };
    res.json({
      id: cmRow.slotegrator_uuid || cmRow.id,
      provider_slug: prov ? prov.slug : null,
      name: cmRow.game_name,
      slug: fg ? fg.slug : null,
      type: cmRow.slotegrator_type || "slots",
      provider: prov ? {
        slug: prov.slug,
        name: prov.name,
        code: (typeof providerCodes !== "undefined" && providerCodes[prov.slug]) || null
      } : null,
      thumbnail_url: fg ? fg.storage_url : null,
      published_at: fg ? fg.published_at : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ end /v1/* ============

app.get("/v1/providers", requireApiKey, async (req, res) => {
  try {
    const c = req.client;
    const { data: cpRows } = await supabase
      .from("client_providers")
      .select("provider_id")
      .eq("client_id", c.id);
    const provIds = (cpRows || []).map(r => r.provider_id).filter(Boolean);
    const { data: provs } = provIds.length
      ? await supabase.from("providers").select("id,slug,name").in("id", provIds)
      : { data: [] };
    const PAGE = 1000;
    let rows = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_game_view")
        .select("provider_slug,storage_url")
        .eq("client_id", c.id)
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
      if (offset > 50000) break;
    }
    const counts = {};
    for (const r of rows) {
      if (!r.provider_slug) continue;
      if (!counts[r.provider_slug]) counts[r.provider_slug] = { games_count: 0, with_thumbnail: 0 };
      counts[r.provider_slug].games_count++;
      if (r.storage_url) counts[r.provider_slug].with_thumbnail++;
    }
    const out = (provs || []).map(p => ({
      slug: p.slug,
      name: p.name,
      code: (typeof providerCodes !== "undefined" && providerCodes[p.slug]) || null,
      games_count: (counts[p.slug] || {}).games_count || 0,
      with_thumbnail: (counts[p.slug] || {}).with_thumbnail || 0
    })).sort((a, b) => a.slug.localeCompare(b.slug));
    res.json({ total: out.length, providers: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/clients", requireAdmin, async (_req, res) => {
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, slug, api_key, is_active, notes, created_at")
    .order("created_at");

  // Get game counts per client
  const { data: gameCounts } = await supabase
    .from("client_games")
    .select("client_id");

  const countMap = {};
  for (const row of gameCounts || []) {
    countMap[row.client_id] = (countMap[row.client_id] || 0) + 1;
  }

  res.json({
    total: clients?.length || 0,
    clients: (clients || []).map(c => ({
      ...c,
      status:     c.is_active ? "active" : "suspended",
      game_count: countMap[c.id] || 0,
    })),
  });
});

// POST /admin/clients — create new client
app.post("/admin/clients", requireAdmin, async (req, res) => {
  const { name, slug, notes } = req.body;
  if (!name || !slug) return res.status(400).json({ error: "name and slug required" });

  const { data, error } = await supabase
    .from("clients")
    .insert({ name, slug, notes })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, client: { id: data.id, name: data.name, api_key: data.api_key } });
});

// PATCH /admin/clients/:id
app.patch("/admin/clients/:id", requireAdmin, async (req, res) => {
  const { name, notes } = req.body;
  await supabase.from("clients")
    .update({ name, notes, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ success: true });
});

// POST /admin/clients/:id/suspend
app.post("/admin/clients/:id/suspend", requireAdmin, async (req, res) => {
  await supabase.from("clients")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ success: true, status: "suspended" });
});

// POST /admin/clients/:id/reinstate
app.post("/admin/clients/:id/reinstate", requireAdmin, async (req, res) => {
  await supabase.from("clients")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ success: true, status: "active" });
});

// GET /admin/clients/:id/games — list all games assigned to a client
app.get("/admin/clients/:id/games", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("client_games")
    .select(`
      id,
      catalog_mappings (
        id, aggregator_uuid, game_name, game_type, match_confidence,
        providers ( slug, name ),
        figma_games ( storage_url )
      )
    `)
    .eq("client_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    total: data.length,
    games: data.map(row => ({
      client_game_id:   row.id,
      game_id:          row.catalog_mappings.aggregator_uuid,
      game_name:        row.catalog_mappings.game_name,
      provider:         row.catalog_mappings.providers?.name,
      type:             row.catalog_mappings.game_type,
      thumbnail_url:    row.catalog_mappings.figma_games?.storage_url || null,
      match_confidence: row.catalog_mappings.match_confidence,
    })),
  });
});

// DELETE /admin/clients/:id/games/:mapping_id — remove one game from client
app.delete("/admin/clients/:id/games/:mapping_id", requireAdmin, async (req, res) => {
  await supabase.from("client_games")
    .delete()
    .eq("client_id", req.params.id)
    .eq("catalog_mapping_id", req.params.mapping_id);
  res.json({ success: true });
});

// ── POST /admin/clients/:id/upload-games ──────────────────────────────────────
// THE MAIN WORKFLOW:
// 1. Casino operator sends you XLS of their Slotegrator games
// 2. You upload it here
// 3. API matches each game UUID to catalog_mappings
// 4. Assigns matched games to this client automatically
//
// Accepts: multipart/form-data with field "file" (XLS, XLSX, or CSV)
// Also accepts: { aggregator_slug: "slotegrator" } to filter by aggregator

app.post("/admin/clients/:id/upload-games", requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Send XLS/XLSX/CSV as 'file' field." });

  const aggregatorSlug = req.body.aggregator_slug || "slotegrator";

  try {
    // 1. Parse the XLS
    const games = parseGamesFromXLS(req.file.buffer);
    console.log(`📄 Parsed ${games.length} games from XLS for client ${req.params.id}`);

    // 2. Get the aggregator
    const { data: aggregator } = await supabase
      .from("aggregators")
      .select("id")
      .eq("slug", aggregatorSlug)
      .single();

    if (!aggregator) return res.status(404).json({ error: `Aggregator "${aggregatorSlug}" not found` });

    // 3. Extract UUIDs from the XLS
    const uuids = games.map(g => g.uuid).filter(Boolean);

    // 4. Find matching catalog_mappings for those UUIDs
    const { data: mappings } = await supabase
      .from("catalog_mappings")
      .select("id, aggregator_uuid, game_name, match_confidence")
      .eq("aggregator_id", aggregator.id)
      .in("aggregator_uuid", uuids);

    const foundUuids = new Set((mappings || []).map(m => m.aggregator_uuid));
    const notFound   = uuids.filter(u => !foundUuids.has(u));

    // 5. Assign matched games to this client (skip duplicates)
    if (mappings && mappings.length > 0) {
      const rows = mappings.map(m => ({
        client_id:          req.params.id,
        catalog_mapping_id: m.id,
      }));

      const { error } = await supabase
        .from("client_games")
        .upsert(rows, { onConflict: "client_id,catalog_mapping_id" });

      if (error) throw new Error(error.message);
    }

    console.log(`✅ Assigned ${mappings?.length || 0} games to client ${req.params.id}`);

    res.json({
      success:      true,
      total_in_xls: games.length,
      matched:      mappings?.length || 0,
      not_found:    notFound.length,
      // Return unmatched UUIDs so you can investigate
      not_found_uuids: notFound.slice(0, 20), // first 20 only
      hint: notFound.length > 0
        ? `${notFound.length} UUIDs from XLS not found in catalog. Run POST /admin/sync/${aggregatorSlug} first to pull the full catalog.`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── POST /admin/sync/:aggregator_slug ─────────────────────────────────────────
// Pull catalog from any aggregator and match to Figma thumbnails

app.post("/admin/sync/:aggregator_slug", requireAdmin, async (req, res) => {
  const { aggregator_slug } = req.params;

  try {
    // Get aggregator config from Supabase
    const { data: aggregator } = await supabase
      .from("aggregators")
      .select("id, api_url, auth_header, auth_key, provider_aliases")
      .eq("slug", aggregator_slug)
      .single();

    if (!aggregator) return res.status(404).json({ error: `Aggregator "${aggregator_slug}" not found` });

    // Fetch their catalog
    console.log(`🔄 Syncing ${aggregator_slug} catalog...`);
    const catalogRes = await fetch(aggregator.api_url, {
      headers: { [aggregator.auth_header]: aggregator.auth_key }
    });
    if (!catalogRes.ok) throw new Error(`Aggregator API error: ${catalogRes.status}`);

    const catalogData = await catalogRes.json();
    const games = Array.isArray(catalogData) ? catalogData : (catalogData.games || catalogData.data || []);
    console.log(`📦 ${games.length} games received from ${aggregator_slug}`);

    // Load all providers + Figma games
    const { data: providers } = await supabase
      .from("providers")
      .select("id, slug, figma_file_key, figma_games ( id, slug, figma_node_id, variant )");

    const providerMap = {};
    for (const p of providers || []) {
      providerMap[p.slug] = { id: p.id, fileKey: p.figma_file_key, games: p.figma_games };
    }

    // Match each game to Figma
    const rows = [];
    let matched = 0, unmatched = 0;

    for (const game of games) {
      const rawSlug = slugify(game.provider || "unknown");
      const aliases = aggregator.provider_aliases || {};
      const providerSlug = aliases[rawSlug] || rawSlug;
      const provider     = providerMap[providerSlug];
      const figmaMatch   = provider ? bestFigmaMatch(game.name, provider.games) : null;

      rows.push({
        aggregator_id:    aggregator.id,
        aggregator_uuid:  game.uuid,
        game_name:        game.name,
        provider_id:      provider?.id              || null,
        figma_game_id:    figmaMatch?.id            || null,
        figma_node_id:    figmaMatch?.figma_node_id || null,
        figma_file_key:   provider?.fileKey         || null,
        match_confidence: figmaMatch?.confidence    ?? 0,
        game_type:        game.type                 || null,
        original_image:   game.image                || null,
        image_status:     game.image_status         || null,
        synced_at:        new Date().toISOString(),
      });

      figmaMatch ? matched++ : unmatched++;
    }

    const { error } = await supabase
      .from("catalog_mappings")
      .upsert(rows, { onConflict: "aggregator_id,aggregator_uuid" });

    if (error) throw new Error(error.message);

    res.json({ success: true, aggregator: aggregator_slug, total_games: games.length, matched, unmatched });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});


// ── POST /admin/publish/:provider_slug ────────────────────────────────────────
// Export Figma frames → Supabase Storage
// All active clients get updated images automatically

app.post("/admin/publish/:provider_slug", requireAdmin, async (req, res) => {
  try {
    const { data: provider } = await supabase
      .from("providers")
      .select("id, figma_file_key, figma_games ( id, slug, figma_node_id, variant )")
      .eq("slug", req.params.provider_slug)
      .single();

    if (!provider) return res.status(404).json({ error: "Provider not found" });

    const games   = provider.figma_games || [];
    const results = { exported: 0, failed: 0, errors: [] };

    console.log(`🎨 Publishing ${games.length} games for ${req.params.provider_slug}...`);

    const BATCH_SIZE = 50;
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
      const batch = games.slice(i, i + BATCH_SIZE);
      const ids = batch.map(g => g.figma_node_id).join(",");
      let images = {};
      try {
        const r = await fetch(`https://api.figma.com/v1/images/${provider.figma_file_key}?ids=${ids}&format=png&scale=1`, { headers: { "X-Figma-Token": FIGMA_TOKEN } });
        if (!r.ok) throw new Error(`Figma API ${r.status}: ${(await r.text()).slice(0,300)}`);
        const data = await r.json();
        images = data.images || {};
      } catch (err) {
        batch.forEach(g => { results.failed++; results.errors.push({ slug: g.slug, error: err.message }); });
        continue;
      }
      await Promise.all(batch.map(async (game) => {
        try {
          const tempUrl = images[game.figma_node_id];
          if (!tempUrl) throw new Error("No image URL returned");
          const imgRes = await fetch(tempUrl);
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const publicUrl = await uploadToStorage(buffer, `${req.params.provider_slug}/${game.variant || "white"}/${game.slug}.png`);
          await supabase.from("figma_games").update({ storage_url: publicUrl, published_at: new Date().toISOString() }).eq("id", game.id);
          results.exported++;
        } catch (err) {
          results.failed++;
          results.errors.push({ slug: game.slug, error: err.message });
        }
      }));
      if (i + BATCH_SIZE < games.length) await new Promise(r => setTimeout(r, 1000));
    }

    await supabase.from("publish_log").insert({
      provider_id: provider.id,
      total_games: games.length,
      exported:    results.exported,
      failed:      results.failed,
    });

    res.json({ success: true, provider: req.params.provider_slug, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /admin/aggregators ────────────────────────────────────────────────────
app.post("/admin/figma-games/bulk", requireAdmin, async (req, res) => {
  try {
    const { provider_id, rows, variant } = req.body || {};
    const useVariant = variant || "white";
    if (!provider_id || !Array.isArray(rows)) {
      return res.status(400).json({ error: "provider_id + rows[] required" });
    }
    const records = rows.map(r => ({
      provider_id,
      slug: r.slug,
      figma_node_id: r.figma_node_id,
      variant: useVariant,
      created_at: new Date().toISOString()
    }));
    const CHUNK = 500;
    let total = 0;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("figma_games")
        .upsert(chunk, { onConflict: "provider_id,slug,variant", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      total += (data || []).length;
    }
    res.json({ inserted: total, total_submitted: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/aggregators", requireAdmin, async (_req, res) => {
  const { data } = await supabase
    .from("aggregators")
    .select("id, slug, name, api_url, auth_header");
  res.json({ total: data?.length || 0, aggregators: data });
});

// ── POST /admin/aggregators ───────────────────────────────────────────────────
app.post("/admin/aggregators", requireAdmin, async (req, res) => {
  const { slug, name, api_url, auth_header, auth_key } = req.body;
  if (!slug || !name || !api_url || !auth_header || !auth_key)
    return res.status(400).json({ error: "slug, name, api_url, auth_header, auth_key required" });

  const { data, error } = await supabase
    .from("aggregators")
    .insert({ slug, name, api_url, auth_header, auth_key })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, aggregator: data });
});


// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎰  thumbs.store API v4 — port ${PORT}`);
  console.log(`\n  CLIENT  (x-api-key)`);
  console.log(`    GET  /api/thumbnails`);
  console.log(`    GET  /api/thumbnails/:game_id`);
  console.log(`\n  ADMIN  (x-admin-key)`);
  console.log(`    GET    /admin/clients`);
  console.log(`    POST   /admin/clients`);
  console.log(`    PATCH  /admin/clients/:id`);
  console.log(`    POST   /admin/clients/:id/suspend`);
  console.log(`    POST   /admin/clients/:id/reinstate`);
  console.log(`    POST   /admin/clients/:id/upload-games  ← upload XLS here`);
  console.log(`    GET    /admin/clients/:id/games`);
  console.log(`    DELETE /admin/clients/:id/games/:mapping_id`);
  console.log(`    GET    /admin/aggregators`);
  console.log(`    POST   /admin/aggregators`);
  console.log(`    POST   /admin/sync/:aggregator_slug`);
  console.log(`    POST   /admin/publish/:provider_slug\n`);
});
