// GET /pill/api/stats — live accuracy telemetry from real-world usage.
// "Labeled" = the user saved a count (adjusted). Every save is ground truth:
// accuracy = how often the machine count matched the human's final count.
export async function onRequestGet({ env }) {
  const one = (sql) => env.DB.prepare(sql).first();
  const all = (sql) => env.DB.prepare(sql).all();

  const totals = await one(`SELECT
      COUNT(*) AS submissions,
      SUM(adjusted IS NOT NULL) AS labeled,
      SUM(adjusted IS NOT NULL AND count = adjusted) AS exact,
      SUM(adjusted IS NOT NULL AND ABS(count - adjusted) <= MAX(1, adjusted / 10)) AS within10,
      ROUND(AVG(CASE WHEN adjusted IS NOT NULL THEN ABS(count - adjusted) END), 2) AS meanAbsErr,
      SUM(adjusted IS NOT NULL AND count != adjusted AND low_confidence > 0) AS wrongFlagged,
      SUM(adjusted IS NOT NULL AND count != adjusted) AS wrongTotal
    FROM submissions`);

  const worst = (await all(`SELECT id, ts, count, adjusted, target, low_confidence, med, note
    FROM submissions
    WHERE adjusted IS NOT NULL AND count != adjusted
    ORDER BY ABS(count - adjusted) DESC, ts DESC LIMIT 15`)).results;

  const recent = (await all(`SELECT id, ts, count, adjusted, low_confidence, med
    FROM submissions ORDER BY ts DESC LIMIT 20`)).results;

  return new Response(JSON.stringify({ totals, worst, recent }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
