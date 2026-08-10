// test/d1.js
// 用 Node 内置 node:sqlite 模拟 Cloudflare D1 的接口，
// 让集成测试能在本地直接调用真实的 index.js handler，无需 wrangler/dev。
// 仅实现 index.js / relay.js 实际用到的子集：
//   db.prepare(sql).bind(...).first() / .all() / .run()
//   db.batch([stmts])
//   db.exec(sql)   —— 用于初始化建表
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 把一条 node:sqlite StatementSync 包装成 D1 风格的链式 API
function wrap(stmt) {
  const api = {
    _vals: [],
    bind(...vals) {
      api._vals = vals;
      return api;
    },
    async first(col) {
      const row = stmt.get(...api._vals);
      if (!row) return null;
      return col ? row[col] : row;
    },
    async all() {
      const rows = stmt.all(...api._vals);
      return { results: rows };
    },
    async run() {
      const r = stmt.run(...api._vals);
      return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
    },
  };
  return api;
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    _raw: db,
    prepare(sql) {
      return wrap(db.prepare(sql));
    },
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    exec(sql) {
      db.exec(sql);
    },
    // 从项目迁移文件建表
    migrate() {
      for (const f of ["0001_init.sql", "0002_accounts_v2.sql", "0003_users_groups.sql", "0004_model_limits.sql"]) {
        db.exec(readFileSync(join(__dirname, "..", "migrations", f), "utf8"));
      }
    },
  };
}
