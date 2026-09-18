/* ============================================================
 * 水果人格测试 · Cloudflare Worker + D1
 * 部署后需要：
 *   1) D1 数据库绑定，变量名 DB
 *   2) 环境变量/密钥 ADMIN_PASSWORD（后台登录密码）
 * 路由：
 *   POST /api/submit  匿名提交一份测试结果
 *   POST /api/admin   后台取数（请求头 X-Admin-Password 校验）
 *   GET  /            健康检查
 * ============================================================ */

const FRUIT_IDS = new Set([
  'strawberry','watermelon','lemon','grape',
  'blueberry','mango','peach','banana'
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// 非常轻量的内存限流（同一 IP 10 秒内最多 15 次提交）
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 10_000;
  let b = buckets.get(ip);
  if (!b || now - b.start > win) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count++;
  return b.count > 15;
}

// 每个 Worker 实例第一次被访问时自动建表，免去手动执行 SQL
let tableReady = null;
function ensureTable(env) {
  if (!tableReady) {
    tableReady = env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS submissions (
         id         TEXT PRIMARY KEY,
         result     TEXT NOT NULL,
         answers    TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`
    ).run();
  }
  return tableReady;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      /* ---------- 健康检查 ---------- */
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response('fruit personality test api: ok', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      /* ---------- 自检（看数据库绑定和建表是否成功） ---------- */
      if (url.pathname === '/api/health' && request.method === 'GET') {
        try {
          await ensureTable(env);
          const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM submissions').first();
          return json({ ok: true, db: 'connected', rows: row.c });
        } catch (e) {
          return json({ ok: false, db: 'error', message: String(e.message || e) }, 500);
        }
      }

      /* ---------- 匿名提交 ---------- */
      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (rateLimited(ip)) return json({ ok: false, error: '提交太频繁，请稍后再试' }, 429);

        await ensureTable(env);
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: '数据格式错误' }, 400);
        }

        // 校验：客户端去重 id
        const id = String(body.id || '');
        if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
          return json({ ok: false, error: 'id 无效' }, 400);
        }

        // 校验：最终结果必须是 8 种水果之一
        const result = String(body.result || '');
        if (!FRUIT_IDS.has(result)) {
          return json({ ok: false, error: '结果无效' }, 400);
        }

        // 校验：答案数组，每一项都是合法水果 id
        const answers = Array.isArray(body.answers) ? body.answers : null;
        if (!answers || answers.length < 1 || answers.length > 50 ||
            answers.some(a => !FRUIT_IDS.has(String(a)))) {
          return json({ ok: false, error: '答案无效' }, 400);
        }

        const createdAt = new Date().toISOString();
        // INSERT OR IGNORE：同一客户端重复发送同一份结果不会重复计数
        await env.DB.prepare(
          `INSERT OR IGNORE INTO submissions (id, result, answers, created_at)
           VALUES (?, ?, ?, ?)`
        ).bind(id, result, JSON.stringify(answers), createdAt).run();

        const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM submissions').first();
        return json({ ok: true, total: row.c });
      }

      /* ---------- 后台取数（密码校验） ---------- */
      if (url.pathname === '/api/admin' && request.method === 'POST') {
        const password = request.headers.get('X-Admin-Password') || '';
        if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
          return json({ ok: false, error: '密码错误' }, 401);
        }

        await ensureTable(env);

        // action=delete：按 id 删除单条（后台用）
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        if (body.action === 'delete') {
          const delId = String(body.id || '');
          if (!/^[a-zA-Z0-9_-]{8,64}$/.test(delId)) {
            return json({ ok: false, error: 'id 无效' }, 400);
          }
          await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(delId).run();
          return json({ ok: true });
        }

        const records = await env.DB.prepare(
          `SELECT id, result, answers, created_at
           FROM submissions
           ORDER BY created_at DESC
           LIMIT 2000`
        ).all();

        return json({ ok: true, records: records.results });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: '服务器开小差了' }, 500);
    }
  }
};
