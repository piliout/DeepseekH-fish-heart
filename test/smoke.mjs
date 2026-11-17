// fish-heart 逻辑自测（无需安装 DSH，直接 node 跑 heart.js 纯函数）。
// 用法：node test/smoke.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createState, normalizeState, tick, applyEvent, deriveTier,
  saveState, loadState, clampDim,
} from '../lib/heart.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + '  ->  ' + e.message);
  }
}

console.log('fish-heart smoke test\n');

check('createState 七维 + 三念头 + daily 档', () => {
  const s = createState();
  assert.equal(Object.keys(s.dims).length, 7);
  assert.equal(typeof s.dims.curiosity, 'number');
  assert.equal(typeof s.dims.fatigue, 'number');
  assert.equal(s.tier, 'daily');
  assert.equal(s.wishes.length, 3);
  assert.equal(s.expectation, 0);
  assert.equal(s.blamePressure, 0);
});

check('praise 提升喜悦与依恋', () => {
  const s = createState();
  const j0 = s.dims.joy;
  applyEvent(s, { kind: 'praise' });
  assert.ok(s.dims.joy > j0);
  assert.ok(s.dims.attachment > 30);
});

check('praise 满足「想被夸」念头', () => {
  const s = createState();
  applyEvent(s, { kind: 'praise' });
  const w = s.wishes.find((x) => x.id === 'praise');
  assert.equal(w.fulfilled, true);
});

check('wish-fulfilled 满足「想听你说今天怎么样」念头', () => {
  const s = createState();
  applyEvent(s, { kind: 'wish-fulfilled', wishId: 'today' });
  const w = s.wishes.find((x) => x.id === 'today');
  assert.equal(w.fulfilled, true);
});

check('念头满足 6 小时后重新冒出来', () => {
  const t0 = 1_700_000_000_000;
  const s = createState(t0);
  applyEvent(s, { kind: 'praise' }, t0);
  assert.equal(s.wishes.find((x) => x.id === 'praise').fulfilled, true);
  tick(s, t0 + 6 * 60 * 60 * 1000 + 1000);
  const w = s.wishes.find((x) => x.id === 'praise');
  assert.equal(w.fulfilled, false);
  assert.ok(w.expiresAt > t0 + 6 * 60 * 60 * 1000);
});

check('curious 事件提升好奇', () => {
  const s = createState();
  const c0 = s.dims.curiosity;
  applyEvent(s, { kind: 'curious' });
  assert.ok(s.dims.curiosity > c0);
});

check('tick 夜里疲惫升高', () => {
  const s = createState();
  const night = new Date(2026, 10, 15, 23, 0, 0).getTime();
  for (let i = 0; i < 12; i += 1) tick(s, night + i * 60 * 1000);
  assert.ok(s.dims.fatigue > 60, '夜里疲惫应 > 60，实际 ' + s.dims.fatigue);
});

check('blame 涨责怪压力并升档', () => {
  const s = createState();
  applyEvent(s, { kind: 'blame', text: '你他妈别恶心人' });
  applyEvent(s, { kind: 'blame', text: '滚' });
  applyEvent(s, { kind: 'blame', text: '废物' });
  tick(s, Date.now());
  assert.ok(s.blamePressure > 0);
  assert.ok(s.tier !== 'daily', 'tier 应为非 daily，实际 ' + s.tier);
  assert.ok(s.recentBlame.length > 0);
});

check('comfort 清除责怪回日常', () => {
  const s = createState();
  s.blamePressure = 60;
  applyEvent(s, { kind: 'comfort' });
  assert.ok(s.blamePressure < 60);
});

check('hug 满足「想被抱」念头', () => {
  const s = createState();
  applyEvent(s, { kind: 'hug' });
  const hugWish = s.wishes.find((w) => w.id === 'hug');
  assert.equal(hugWish.fulfilled, true);
  assert.ok(s.dims.intimacy > 25);
});

check('tick 6 小时后向基线回落一半', () => {
  const s = createState();
  s.dims.joy = 90;
  const t0 = s.lastTick;
  tick(s, t0 + 6 * 3600 * 1000);
  assert.ok(s.dims.joy < 90, '应回落');
  assert.ok(s.dims.joy > 35, '回落一半应仍高于基线');
});

check('deriveTier 阈值映射正确', () => {
  const s = createState();
  s.blamePressure = 10; assert.equal(deriveTier(s), 'daily');
  s.blamePressure = 30; assert.equal(deriveTier(s), 'wronged');
  s.blamePressure = 55; assert.equal(deriveTier(s), 'angry');
  s.blamePressure = 70; assert.equal(deriveTier(s), 'afraid');
  s.blamePressure = 85; assert.equal(deriveTier(s), 'avoidant');
});

check('deriveTier 45–65 按亲密分叉：亲密≥60 判闷，掉了才是生气', () => {
  const s = createState();
  s.blamePressure = 55;
  s.dims.intimacy = 100; assert.equal(deriveTier(s), 'sullen');  // 责怪高但还亲近 → 闷
  s.dims.intimacy = 60;  assert.equal(deriveTier(s), 'sullen');  // 边界含等号
  s.dims.intimacy = 59;  assert.equal(deriveTier(s), 'angry');   // 亲密掉了 → 真生气
  s.dims.intimacy = 20;  assert.equal(deriveTier(s), 'angry');
  // 分叉只在 45–65 生效，别的档位不受亲密影响
  s.dims.intimacy = 100;
  s.blamePressure = 30; assert.equal(deriveTier(s), 'wronged');
  s.blamePressure = 70; assert.equal(deriveTier(s), 'afraid');
  s.blamePressure = 85; assert.equal(deriveTier(s), 'avoidant');
});

check('hug 也降责怪压力（抱一下该消点气）', () => {
  const s = createState();
  s.blamePressure = 20;
  applyEvent(s, { kind: 'hug' });
  assert.equal(s.blamePressure, 10, 'hug 应降 10，实际 ' + s.blamePressure);
  // 抱到底也不会变成负数
  for (let i = 0; i < 5; i += 1) applyEvent(s, { kind: 'hug' });
  assert.equal(s.blamePressure, 0);
});

check('comfort 降得比 hug 多（正式道歉 > 单纯抱抱）', () => {
  const a = createState(); a.blamePressure = 60;
  applyEvent(a, { kind: 'comfort' });
  const b = createState(); b.blamePressure = 60;
  applyEvent(b, { kind: 'hug' });
  assert.ok(a.blamePressure < b.blamePressure,
    '道歉后 ' + a.blamePressure + ' 应低于抱抱后 ' + b.blamePressure);
});

check('持久化往返一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-heart-'));
  const f = path.join(dir, 'state.json');
  const s = createState();
  s.dims.joy = 88;
  s.blamePressure = 33;
  saveState(f, s);
  const s2 = loadState(f);
  assert.equal(s2.dims.joy, 88);
  assert.equal(s2.blamePressure, 33);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('损坏文件 load 抛错（不静默覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-heart-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, '{ not json');
  let threw = false;
  try { loadState(f); } catch { threw = true; }
  assert.ok(threw, '损坏文件应抛错');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('clampDim 夹在 0-100', () => {
  assert.equal(clampDim(150), 100);
  assert.equal(clampDim(-5), 0);
  assert.equal(clampDim(42.6), 43);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
