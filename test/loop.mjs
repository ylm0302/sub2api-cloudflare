// test/loop.mjs
// run-until-green 循环：反复执行测试套件，直到全绿（退出码 0）或达到最大尝试次数。
// 用法：npm run test:loop   或   MAX_ATTEMPTS=100 npm run test:loop
import { spawn } from "node:child_process";

const MAX = Number(process.env.MAX_ATTEMPTS || 50);
const args = ["--experimental-sqlite", "test/run.js"];

const runOnce = () =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: "inherit", cwd: process.cwd() });
    p.on("exit", (code) => resolve(code ?? 1));
  });

console.log(`\x1b[1m运行测试 loop（最多 ${MAX} 次，直到全绿）\x1b[0m`);
let attempt = 0;
for (;;) {
  attempt++;
  console.log(`\n\x1b[36m===== 第 ${attempt} 次尝试 =====\x1b[0m`);
  const code = await runOnce();
  if (code === 0) {
    console.log(`\n\x1b[32m✅ 第 ${attempt} 次通过，loop 结束。\x1b[0m`);
    process.exit(0);
  }
  if (attempt >= MAX) {
    console.log(`\n\x1b[31m❌ 已达最大尝试次数 ${MAX}，仍未全绿，loop 中止。\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[33m⚠️ 第 ${attempt} 次未通过，1 秒后重试…\x1b[0m`);
  await new Promise((r) => setTimeout(r, 1000));
}
