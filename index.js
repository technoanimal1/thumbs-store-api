/**
 * thumbs.store API
 * Manual client control — 5 clients, no Stripe yet
 *
 * CLIENT ROUTES  (x-api-key: ts_xxxx)
 *   GET  /api/thumbnails
 *   GET  /api/thumbnails/:game_id
 *   GET  /api/providers
 *   POST /api/sync
 *   POST /api/map
 *
 * ADMIN ROUTES  (x-admin-key: your_secret)
 *   GET    /admin/clients                      → see all 5 clients + status
 *   POST   /admin/clients                      → create a new client
 *   PATCH  /admin/clients/:id                  → update name, notes, figma_token
 *   POST   /admin/clients/:id/suspend          → cut off access immediately
 *   POST   /admin/clients/:id/reinstate        → restore access
 *   POST   /admin/clients/:id/providers        → grant a provider  { provider_slug }
 *   DELETE /admin/clients/:id/providers/:pid   → revoke a provider
 *   POST   /api/publish/:provider_slug         → export Figma → Supabase Storage
 */

import express from "express";
import fetch   from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────────

const SLOTEGRATOR_API = "https://api-dev.beat.gg/api/partner/catalog/games";
const SLOTEGRATOR_KEY = process.env.SLOTEGRATOR_KEY || "1ZWz8VWDPPdVszhV51jdNHv1/0ONLXKssCll3Vfg4Lo=";
const FIGMA_TOKEN     = process.env.FIGMA_TOKEN;
const ADMIN_KEY       = process.env.ADMIN_KEY || "change_this_secret";
const PORT            = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL || "https://cdwplbjjjbpqkmytlmaf.supabase.co",
  process.env.SUPABASE_KEY  // service_role key
);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Export a frame from Figma and return the image as a Buffer */
async function exportFigmaNode(fileKey, nodeId, format = "png") {
  if (!FIGMA_TOKEN) throw new Error("FIGMA_TOKEN not set");

  const res = await fetch(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=${format}&scale=2`,
    { headers: { "X-Figma-Token": FIGMA_TOKEN } }
  );
  if (!res.ok) throw new Error(`Figma API ${res.status}`);

  const data    = await res.json();
  const tempUrl = Object.values(data.images || {})[0];
  if (!tempUrl) throw new Error(`No Figma image returned for ${nodeId}`);

  const imgRes = await fetch(tempUrl);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);

  return Buffer.from(await imgRes.arrayBuffer());
}

/** Upload buffer to Supabase Storage, return permanent public URL */
async function uploadToStorage(buffer, storagePath, contentType = "image/png") {
  const { error } = await supabase.storage
    .from("thumbnails")
    .upload(storagePath, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Storage error: ${error.message}`);

  return supabase.storage.from("thumbnails").getPublicUrl(storagePath).data.publicUrl;
}

/** Match a Slotegrator game name to the best Figma slug */
function bestFigmaMatch(gameName, figmaGames) {
  const target = slugify(gameName);
  const exact  = figmaGames.find(g => g.slug === target);
  if (exact) return { ...exact, confidence: 1 };

  let best = null, bestScore = 0;
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
  return best;
}

async function getClientProviderIds(clientId) {
  const { data } = await supabase
    .from("client_providers")
    .select("provider_id")
    .eq("client_id", clientId);
  return (data || []).map(r => r.provider_id);
}

// ─── Middleware ────────────────────────────────────────────────────────────────

/** Client auth — just checks is_active. You control that flag manually. */
async function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header" });

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, name, slug, figma_token, is_active")
    .eq("api_key", apiKey)
    .single();

  if (error || !client) return res.status(401).json({ error: "Invalid API key" });

  if (!client.is_active) {
    return res.status(403).json({
      error: "Account suspended. Please contact thumbs.store.",
    });
  }

  req.client = client;
  next();
}

/** Admin auth */
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── CLIENT ROUTES ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const { count } = await supabase
    .from("catalog_mappings")
    .select("*", { count: "exact", head: true });
  res.json({ status: "ok", total_mappings: count });
});

// GET /api/providers
app.get("/api/providers", requireApiKey, async (req, res) => {
  const ids = await getClientProviderIds(req.client.id);
  const { data } = await supabase
    .from("providers")
    .select("slug, name")
    .in("id", ids);
  res.json({ total: data.length, providers: data });
});

// GET /api/thumbnails
app.get("/api/thumbnails", requireApiKey, async (req, res) => {
  const { provider, type, matched, page = 1, limit = 50 } = req.query;
  const providerIds = await getClientProviderIds(req.client.id);

  let query = supabase
    .from("catalog_mappings")
    .select(`
      slotegrator_uuid, game_name, slotegrator_type,
      figma_node_id, match_confidence, synced_at,
      providers ( slug, name ),
      figma_games ( storage_url, published_at )
    `)
    .in("provider_id", providerIds)
    .range((Number(page) - 1) * Number(limit), Number(page) * Number(limit) - 1);

  if (type)               query = query.eq("slotegrator_type", type);
  if (matched === "true")  query = query.not("figma_node_id", "is", null);
  if (matched === "false") query = query.is("figma_node_id", null);

  if (provider) {
    const { data: p } = await supabase.from("providers").select("id").eq("slug", slugify(provider)).single();
    if (p) query = query.eq("provider_id", p.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    page: Number(page), limit: Number(limit),
    results: (data || []).map(row => ({
      game_id:          row.slotegrator_uuid,
      game_name:        row.game_name,
      provider:         row.providers?.name,
      provider_slug:    row.providers?.slug,
      type:             row.slotegrator_type,
      thumbnail_url:    row.figma_games?.storage_url || null,
      published_at:     row.figma_games?.published_at || null,
      match_confidence: row.match_confidence,
    })),
  });
});

// GET /api/thumbnails/:game_id
app.get("/api/thumbnails/:game_id", requireApiKey, async (req, res) => {
  const providerIds = await getClientProviderIds(req.client.id);

  const { data: row, error } = await supabase
    .from("catalog_mappings")
    .select(`
      slotegrator_uuid, game_name, slotegrator_type,
      figma_node_id, figma_file_key, match_confidence, synced_at,
      providers ( slug, name ),
      figma_games ( storage_url, published_at )
    `)
    .eq("slotegrator_uuid", req.params.game_id)
    .in("provider_id", providerIds)
    .single();

  if (error || !row) return res.status(404).json({ error: "Not found or not licensed" });

  res.json({
    game_id:          row.slotegrator_uuid,
    game_name:        row.game_name,
    provider:         row.providers?.name,
    provider_slug:    row.providers?.slug,
    type:             row.slotegrator_type,
    thumbnail_url:    row.figma_games?.storage_url || null,
    published_at:     row.figma_games?.published_at || null,
    match_confidence: row.match_confidence,
    ratio:            "1:1.414",
    format:           "png",
    synced_at:        row.synced_at,
  });
});

// POST /api/sync
app.post("/api/sync", requireApiKey, async (req, res) => {
  try {
    const catalogRes = await fetch(SLOTEGRATOR_API, { headers: { "x-p-key": SLOTEGRATOR_KEY } });
    if (!catalogRes.ok) throw new Error(`Slotegrator error: ${catalogRes.status}`);

    const catalogData = await catalogRes.json();
    const games = Array.isArray(catalogData) ? catalogData : (catalogData.games || catalogData.data || []);

    const { data: providers } = await supabase
      .from("providers")
      .select("id, slug, figma_file_key, figma_games ( id, slug, figma_node_id )");

    const providerMap = {};
    for (const p of providers || []) {
      providerMap[p.slug] = { id: p.id, fileKey: p.figma_file_key, games: p.figma_games };
    }

    const rows = [];
    let matched = 0, unmatched = 0;

    for (const game of games) {
      const providerSlug = slugify(game.provider || "unknown");
      const provider     = providerMap[providerSlug];
      const figmaMatch   = provider ? bestFigmaMatch(game.name, provider.games) : null;

      rows.push({
        slotegrator_uuid: game.uuid,
        game_name:        game.name,
        provider_id:      provider?.id              || null,
        figma_game_id:    figmaMatch?.id            || null,
        figma_node_id:    figmaMatch?.figma_node_id || null,
        figma_file_key:   provider?.fileKey         || null,
        match_confidence: figmaMatch?.confidence    ?? 0,
        slotegrator_type: game.type                 || null,
        original_image:   game.image                || null,
        image_status:     game.image_status         || null,
        synced_at:        new Date().toISOString(),
      });

      figmaMatch ? matched++ : unmatched++;
    }

    const { error } = await supabase
      .from("catalog_mappings")
      .upsert(rows, { onConflict: "slotegrator_uuid" });

    if (error) throw new Error(error.message);
    res.json({ success: true, total_games: games.length, matched, unmatched });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/map — manually fix one mapping
app.post("/api/map", requireApiKey, async (req, res) => {
  const { game_id, figma_slug, provider_slug } = req.body;
  if (!game_id || !figma_slug || !provider_slug)
    return res.status(400).json({ error: "game_id, figma_slug, provider_slug required" });

  const providerIds = await getClientProviderIds(req.client.id);
  const { data: provider } = await supabase.from("providers")
    .select("id, figma_file_key").eq("slug", provider_slug).single();

  if (!provider || !providerIds.includes(provider.id))
    return res.status(403).json({ error: "Provider not licensed for this client" });

  const { data: fg } = await supabase.from("figma_games")
    .select("id, figma_node_id")
    .eq("provider_id", provider.id)
    .eq("slug", figma_slug)
    .single();

  if (!fg) return res.status(404).json({ error: `"${figma_slug}" not found` });

  await supabase.from("catalog_mappings").update({
    figma_game_id: fg.id,
    figma_node_id: fg.figma_node_id,
    figma_file_key: provider.figma_file_key,
    match_confidence: 1,
    synced_at: new Date().toISOString(),
  }).eq("slotegrator_uuid", game_id);

  res.json({ success: true, game_id, mapped_to: figma_slug });
});


// ─── PUBLISH ───────────────────────────────────────────────────────────────────
// POST /api/publish/:provider_slug
// You trigger this manually after updating designs in Figma.
// Exports every frame → stores in Supabase → all active clients get updates instantly.

app.post("/api/publish/:provider_slug", requireAdmin, async (req, res) => {
  const { provider_slug } = req.params;

  try {
    const { data: provider } = await supabase
      .from("providers")
      .select("id, figma_file_key, figma_games ( id, slug, figma_node_id )")
      .eq("slug", provider_slug)
      .single();

    if (!provider) return res.status(404).json({ error: "Provider not found" });

    const games   = provider.figma_games || [];
    const results = { exported: 0, failed: 0, errors: [] };

    console.log(`🎨 Publishing ${games.length} games for ${provider_slug}...`);

    // Batch in groups of 5 to respect Figma rate limits
    for (let i = 0; i < games.length; i += 5) {
      const batch = games.slice(i, i + 5);

      await Promise.all(batch.map(async (game) => {
        try {
          const buffer     = await exportFigmaNode(provider.figma_file_key, game.figma_node_id);
          const publicUrl  = await uploadToStorage(buffer, `${provider_slug}/${game.slug}.png`);

          await supabase.from("figma_games").update({
            storage_url:  publicUrl,
            published_at: new Date().toISOString(),
          }).eq("id", game.id);

          console.log(`  ✅ ${game.slug}`);
          results.exported++;
        } catch (err) {
          console.error(`  ❌ ${game.slug}: ${err.message}`);
          results.failed++;
          results.errors.push({ slug: game.slug, error: err.message });
        }
      }));

      // 1s pause between batches
      if (i + 5 < games.length) await new Promise(r => setTimeout(r, 1000));
    }

    await supabase.from("publish_log").insert({
      provider_id:  provider.id,
      total_games:  games.length,
      exported:     results.exported,
      failed:       results.failed,
    });

    res.json({ success: true, provider: provider_slug, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /admin/clients — your full client dashboard
app.get("/admin/clients", requireAdmin, async (_req, res) => {
  const { data: clients } = await supabase
    .from("clients")
    .select(`
      id, name, slug, api_key, is_active, notes, created_at, updated_at,
      client_providers ( provider_id, providers ( slug, name ) )
    `)
    .order("created_at", { ascending: true });

  const result = (clients || []).map(c => ({
    id:         c.id,
    name:       c.name,
    slug:       c.slug,
    api_key:    c.api_key,
    status:     c.is_active ? "active" : "suspended",
    notes:      c.notes,
    providers:  c.client_providers?.map(cp => cp.providers) || [],
    created_at: c.created_at,
  }));

  res.json({ total: result.length, clients: result });
});

// POST /admin/clients — add a new client
app.post("/admin/clients", requireAdmin, async (req, res) => {
  const { name, slug, notes, figma_token } = req.body;
  if (!name || !slug) return res.status(400).json({ error: "name and slug required" });

  const { data, error } = await supabase
    .from("clients")
    .insert({ name, slug, notes, figma_token })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, client: { id: data.id, name: data.name, api_key: data.api_key } });
});

// PATCH /admin/clients/:id — update notes, name, figma_token
app.patch("/admin/clients/:id", requireAdmin, async (req, res) => {
  const { name, notes, figma_token } = req.body;
  const { error } = await supabase
    .from("clients")
    .update({ name, notes, figma_token, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /admin/clients/:id/suspend — cut access immediately
app.post("/admin/clients/:id/suspend", requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from("clients")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, status: "suspended" });
});

// POST /admin/clients/:id/reinstate — restore access
app.post("/admin/clients/:id/reinstate", requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from("clients")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, status: "active" });
});

// POST /admin/clients/:id/providers — grant a provider
app.post("/admin/clients/:id/providers", requireAdmin, async (req, res) => {
  const { provider_slug } = req.body;
  const { data: p } = await supabase.from("providers").select("id, name").eq("slug", provider_slug).single();
  if (!p) return res.status(404).json({ error: "Provider not found" });

  const { error } = await supabase.from("client_providers")
    .insert({ client_id: req.params.id, provider_id: p.id });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, granted: p.name });
});

// DELETE /admin/clients/:id/providers/:pid — revoke a provider
app.delete("/admin/clients/:id/providers/:pid", requireAdmin, async (req, res) => {
  await supabase.from("client_providers")
    .delete()
    .eq("client_id", req.params.id)
    .eq("provider_id", req.params.pid);

  res.json({ success: true, revoked: true });
});


// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎰  thumbs.store API — port ${PORT}`);
  console.log(`\n  CLIENT  (x-api-key: ts_xxxx)`);
  console.log(`    GET  /api/providers`);
  console.log(`    GET  /api/thumbnails`);
  console.log(`    GET  /api/thumbnails/:game_id`);
  console.log(`    POST /api/sync`);
  console.log(`    POST /api/map`);
  console.log(`\n  ADMIN  (x-admin-key: your_secret)`);
  console.log(`    GET    /admin/clients`);
  console.log(`    POST   /admin/clients`);
  console.log(`    PATCH  /admin/clients/:id`);
  console.log(`    POST   /admin/clients/:id/suspend`);
  console.log(`    POST   /admin/clients/:id/reinstate`);
  console.log(`    POST   /admin/clients/:id/providers`);
  console.log(`    DELETE /admin/clients/:id/providers/:pid`);
  console.log(`    POST   /api/publish/:provider_slug\n`);
});
