// GET /pill/api/photo/<id> — stream the submitted photo from R2 by submission id.
// Public (ids are unguessable UUIDs); long cache since photos are immutable.
export async function onRequestGet({ params, env }) {
  const id = String(params.id || '').replace(/\.jpg$/i, '');
  if (!id) return new Response('missing id', { status: 400 });

  const row = await env.DB.prepare('SELECT r2_key FROM submissions WHERE id = ?')
    .bind(id).first();
  if (!row || !row.r2_key) return new Response('not found', { status: 404 });

  const obj = await env.PHOTOS.get(row.r2_key);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  });
}
