// POST /pill/api/truth — the owner's hand-annotated ground truth for a CORPUS
// image (one dot per pill), saved straight from /pill/stamp truth mode.
// GET  /pill/api/truth?file=... — read back one image's annotation
// GET  /pill/api/truth          — list every annotation (what the maintainer pulls)
//
// Stored in the existing PHOTOS bucket under truth/ — no new binding to
// provision, so this ships without infra changes.
//
// This exists because wrong labels have cost more time than any algorithm bug:
// two shiny labels were wrong for hours and every fix aimed at them missed.
// Copy/paste round-trips were the friction; this removes them entirely.
export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json();
    const file = str(b.file, 300);
    if (!file) return json({ error: 'missing file' }, 400);
    if (!Array.isArray(b.centers)) return json({ error: 'missing centers' }, 400);
    if (b.centers.length > 2000) return json({ error: 'too many centers' }, 413);
    // centers arrive as [[x,y],...] in NATIVE image pixels
    const centers = b.centers
      .filter((c) => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]))
      .map((c) => [Math.round(+c[0] * 10) / 10, Math.round(+c[1] * 10) / 10]);
    const doc = {
      file,
      count: centers.length,
      centers,
      size: Array.isArray(b.size) ? b.size.map((n) => Math.round(+n) || 0) : null,
      expected: Number.isFinite(+b.expected) ? Math.round(+b.expected) : null,
      note: str(b.note, 1000),
      ts: Date.now(),
      ua: str(request.headers.get('user-agent'), 300),
    };
    await env.PHOTOS.put(`truth/${encodeURIComponent(file)}.json`, JSON.stringify(doc), {
      httpMetadata: { contentType: 'application/json' },
    });
    return json({ ok: true, file, count: centers.length,
      agrees: doc.expected == null ? null : doc.expected === centers.length });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const u = new URL(request.url);
    const file = u.searchParams.get('file');
    if (file) {
      const o = await env.PHOTOS.get(`truth/${encodeURIComponent(file)}.json`);
      if (!o) return json({ error: 'not found' }, 404);
      return new Response(await o.text(), { headers: { 'content-type': 'application/json' } });
    }
    const list = await env.PHOTOS.list({ prefix: 'truth/', limit: 1000 });
    const out = [];
    for (const obj of list.objects) {
      const o = await env.PHOTOS.get(obj.key);
      if (o) out.push(JSON.parse(await o.text()));
    }
    out.sort((a, b) => b.ts - a.ts);
    return json({ ok: true, n: out.length, annotations: out });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
