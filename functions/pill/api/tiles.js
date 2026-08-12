// POST /pill/api/tiles — the owner's per-tile pill marks from /pill/tiles.
// GET  /pill/api/tiles — read them all back (what the maintainer pulls).
//
// Tiles instead of whole images: the owner's time is the scarce resource, so
// they are only ever asked about the crops the algorithm is actually unsure
// about. Each record carries the source rect, so marks map straight back to
// native pixels and can be merged into testdata/centers/*.json.
//
// Stored in the existing PHOTOS bucket under tiles/ — no new binding.
export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json();
    if (!Array.isArray(b.tiles) || !b.tiles.length) return json({ error: 'no tiles' }, 400);
    if (b.tiles.length > 400) return json({ error: 'too many tiles' }, 413);
    const stamp = Date.now();
    const clean = b.tiles.slice(0, 400).map((t) => ({
      file: str(t.file, 300),
      rect: Array.isArray(t.rect) ? t.rect.slice(0, 4).map((n) => Math.round(+n) || 0) : null,
      centers: (Array.isArray(t.centers) ? t.centers : [])
        .filter((c) => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]))
        .slice(0, 500)
        .map((c) => [Math.round(+c[0] * 10) / 10, Math.round(+c[1] * 10) / 10]),
      why: str(t.why, 400),
    })).filter((t) => t.file && t.centers.length);
    if (!clean.length) return json({ error: 'no usable marks' }, 400);
    await env.PHOTOS.put(`tiles/${stamp}.json`, JSON.stringify({
      ts: stamp, n: clean.length, tiles: clean,
      ua: str(request.headers.get('user-agent'), 300),
    }), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, saved: clean.length,
      pills: clean.reduce((n, t) => n + t.centers.length, 0) });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export async function onRequestGet({ env }) {
  try {
    const list = await env.PHOTOS.list({ prefix: 'tiles/', limit: 1000 });
    const out = [];
    for (const obj of list.objects) {
      const o = await env.PHOTOS.get(obj.key);
      if (o) out.push(JSON.parse(await o.text()));
    }
    out.sort((a, b) => b.ts - a.ts);
    return json({ ok: true, n: out.length, batches: out });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
