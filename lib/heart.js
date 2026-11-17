// fish-heart 情绪状态机核心 —— 纯逻辑，无 DSH / Node 内置依赖（文件读写除外），便于单测与移植。
//
// 职责边界：本文件只管「此刻什么心情、什么档位、惦记什么、睡没睡」这套硬状态；
//   消息收发、人格卡、记忆、日记一律不碰——那些由宿主桥接 / 其它插件负责。
//
// 设计来源：fish_heart（AstrBot 版）的七维情绪 + 两条快变量 + 档位 + 念头 + 作息，
// 语义对齐，但存储/注入/命令通道换成了 DSH 生态的形态。档位在 v0.2.0 由五档扩到六档（加「闷」）。

// ── 常量 ────────────────────────────────────────────────────────────────────

// 5 维事件驱动 + 2 维脚本驱动：疲惫按钟点、好奇按发问；责任/社交仍删（无信号源）。
export const DIMENSIONS = [
  'attachment',   // 依恋
  'rumination',   // 反刍（惦记/反复想）
  'intimacy',     // 亲密
  'pressure',     // 压力
  'joy',          // 喜悦
  'fatigue',      // 疲惫（脚本填：按钟点算）
  'curiosity',    // 好奇（脚本填：发问/聊新东西）
];

export const BASELINE = {
  attachment: 30, rumination: 15, intimacy: 25, pressure: 10, joy: 35,
  fatigue: 30, curiosity: 35,
};

export const DEFAULT_DIMS = { ...BASELINE };

export const TIERS = ['daily', 'wronged', 'sullen', 'angry', 'afraid', 'avoidant'];

export const TIER_LABEL = {
  daily: '日常', wronged: '委屈', sullen: '闷', angry: '生气', afraid: '害怕', avoidant: '回避',
};

// 责怪压力 → 档位的阈值（半开区间 [lo, hi)）
const TIER_THRESHOLDS = [
  { tier: 'daily', lo: 0, hi: 20 },
  { tier: 'wronged', lo: 20, hi: 45 },
  { tier: 'angry', lo: 45, hi: 65 },
  { tier: 'afraid', lo: 65, hi: 80 },
  { tier: 'avoidant', lo: 80, hi: Infinity },
];

const DIM_MAX = 100;
const DIM_MIN = 0;

// 回落半衰期：6 小时向基线靠一半
const HALF_LIFE_MS = 6 * 60 * 60 * 1000;

// 愿望（念头）的默认 TTL：24 小时
const WISH_TTL_MS = 24 * 60 * 60 * 1000;
// 念头被满足/过期后，冷却多久再冒出来（避免「刚被夸完立刻又想被夸」的黏人感）
const WISH_REFRESH_MS = 6 * 60 * 60 * 1000;

// 作息
const DEFAULT_BEDTIME = [23, 30]; // 23:30
const DEFAULT_WAKE = [7, 30];     // 07:30
const LATE_NIGHT_MS = 2 * 60 * 60 * 1000; // 熬夜 2 小时
const LATE_NIGHT_PROB = 0.2;

export const WISHES = [
  { id: 'praise', label: '想被夸' },
  { id: 'hug', label: '想被抱' },
  { id: 'today', label: '想听你说今天怎么样' },
];

// ── 状态构造与持久化 ────────────────────────────────────────────────────────

export function createState(now = Date.now()) {
  return {
    version: 1,
    dims: { ...DEFAULT_DIMS },
    expectation: 0,      // 期待：主动开口后没回就涨，回应清零
    blamePressure: 0,    // 责怪压力：被责怪/敷衍才涨，决定档位
    tier: 'daily',
    moodLabel: '平常',
    wishes: WISHES.map((w) => ({
      id: w.id, label: w.label, fulfilled: false,
      createdAt: now, expiresAt: now + WISH_TTL_MS,
    })),
    sleep: {
      asleep: false,
      bedtime: DEFAULT_BEDTIME.join(':'),
      wakeAt: DEFAULT_WAKE.join(':'),
      lateNight: false,
    },
    lastTick: now,
    lastActive: now,
    lastSpokeAt: 0,
    dailyPraise: 0,
    praiseDay: '',
    recentBlame: [],     // 最近责怪（原句 + 时间），最多 5 条
  };
}

export function clampDim(v) {
  return Math.max(DIM_MIN, Math.min(DIM_MAX, Math.round(Number(v) || 0)));
}

export function normalizeState(raw, now = Date.now()) {
  const base = createState(now);
  if (!raw || typeof raw !== 'object') return base;
  const dims = { ...base.dims };
  if (raw.dims && typeof raw.dims === 'object') {
    for (const d of DIMENSIONS) {
      if (Number.isFinite(Number(raw.dims[d]))) dims[d] = clampDim(raw.dims[d]);
    }
  }
  let wishes = Array.isArray(raw.wishes) && raw.wishes.length
    ? raw.wishes.map((w) => ({
        id: String(w?.id ?? ''),
        label: String(w?.label ?? ''),
        fulfilled: w?.fulfilled === true,
        createdAt: Number(w?.createdAt) || now,
        expiresAt: Number(w?.expiresAt) || now + WISH_TTL_MS,
        ...(Number.isFinite(Number(w?.fulfilledAt)) ? { fulfilledAt: Number(w.fulfilledAt) } : {}),
        ...(Number.isFinite(Number(w?.expiredAt)) ? { expiredAt: Number(w.expiredAt) } : {}),
      }))
    : base.wishes.slice();
  // 老状态文件可能缺念头 id：补齐，避免 /心 里「惦记」缺项
  for (const def of WISHES) {
    if (!wishes.some((w) => w.id === def.id)) {
      wishes.push({ id: def.id, label: def.label, fulfilled: false, createdAt: now, expiresAt: now + WISH_TTL_MS });
    }
  }
  return {
    ...base,
    dims,
    expectation: clampDim(raw.expectation),
    blamePressure: clampDim(raw.blamePressure),
    tier: TIERS.includes(raw.tier) ? raw.tier : 'daily',
    moodLabel: typeof raw.moodLabel === 'string' ? raw.moodLabel : '平常',
    wishes,
    sleep: {
      ...base.sleep,
      ...(raw.sleep && typeof raw.sleep === 'object' ? raw.sleep : {}),
      asleep: raw.sleep?.asleep === true,
    },
    lastTick: Number(raw.lastTick) || now,
    lastActive: Number(raw.lastActive) || now,
    lastSpokeAt: Number(raw.lastSpokeAt) || 0,
    dailyPraise: Number(raw.dailyPraise) || 0,
    praiseDay: typeof raw.praiseDay === 'string' ? raw.praiseDay : '',
    recentBlame: Array.isArray(raw.recentBlame) ? raw.recentBlame.slice(-5) : [],
  };
}

// ── 档位与心情标签推导 ──────────────────────────────────────────────────────

export function deriveTier(state) {
  const p = state.blamePressure;
  // 责怪高、但亲密还挂着 → 「闷」（憋着，不是冲你发火）；亲密掉了才算真「生气」。
  // 原因：责怪 60 + 亲密 100 若判成「生气」，上层提示词常写成"只认道歉"，
  // 会把一个还在乎你的人推到"你不来我就不理你"的死角上——那不是生气，是闷。
  const close = (Number(state?.dims?.intimacy) || 0) >= 60;
  for (const { tier, lo, hi } of TIER_THRESHOLDS) {
    if (p >= lo && p < hi) {
      if (tier === 'angry' && close) return 'sullen';
      return tier;
    }
  }
  return 'daily';
}

export function deriveMoodLabel(state) {
  const d = state.dims;
  if (d.attachment >= 66) return '黏人';
  if (d.intimacy >= 66) return '想亲近';
  if (d.pressure >= 50) return '紧绷';
  if (d.joy >= 66) return '开心';
  if (d.rumination >= 60) return '走神';
  return '平常';
}

// ── 时间推移：回落 + 作息判定 ──────────────────────────────────────────────

function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 回落所有维度向基线靠一半（按 elapsed 的半衰期）。 */
function decayDims(state, now) {
  const elapsed = Math.max(0, now - state.lastTick);
  if (elapsed <= 0) return;
  // 真半衰期：每 6 小时向基线靠 50%（之前用 exp 是时间常数，6h 只靠 63.2%）
  const factor = 1 - Math.pow(0.5, elapsed / HALF_LIFE_MS);
  for (const d of DIMENSIONS) {
    const base = BASELINE[d];
    state.dims[d] = clampDim(state.dims[d] + (base - state.dims[d]) * factor);
  }
  // 责怪压力没有「自己涨」的机制，只会回落
  state.blamePressure = clampDim(state.blamePressure * (1 - factor * 0.5));
  // 期待：没人说话时自然回落
  state.expectation = clampDim(state.expectation * (1 - factor));
}

/** 作息判定：23:30 睡、07:30 起，每天 20% 概率熬夜 2 小时。 */
function settleSleep(state, now) {
  const d = new Date(now);
  const parseHM = (val, fb) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(val ?? ''));
    if (!m) return fb;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return fb;
    return [h, mi];
  };
  const [bh, bm] = parseHM(state.sleep?.bedtime, DEFAULT_BEDTIME);
  const [wh, wm] = parseHM(state.sleep?.wakeAt, DEFAULT_WAKE);
  const min = d.getHours() * 60 + d.getMinutes();
  const wakeMin = wh * 60 + wm;
  const bedMin = bh * 60 + bm;

  // 用当天日期做种子，决定是否熬夜（确定性，跨重启一致）
  const seed = dayKey(now);
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const lateNight = (hash % 1000) / 1000 < LATE_NIGHT_PROB;

  const sleep = state.sleep;
  sleep.lateNight = lateNight;
  const effectiveBed = bedMin + (lateNight ? LATE_NIGHT_MS / 60000 : 0);
  // 入睡点可能跨天（熬夜 2 小时 → 次日 01:30）：
  //   effectiveBed >= 1440 时，只在 [effectiveBed-1440, wakeMin) 算睡着；
  //   否则按 [bedMin, 24:00) 或 [00:00, wakeMin) 判断。
  let asleep;
  if (effectiveBed >= 1440) {
    asleep = (min >= effectiveBed - 1440 && min < wakeMin);
  } else {
    asleep = (min >= effectiveBed && min <= 24 * 60) || min < wakeMin;
  }
  sleep.asleep = asleep;
}

/** 疲惫：按钟点推目标值（夜里高、白天低），缓慢靠拢。只影响力度，不影响内容/脾气。 */
function settleFatigue(state, now) {
  const h = new Date(now).getHours();
  const target = h < 6 ? 70 : h < 9 ? 45 : h < 12 ? 35 : h < 18 ? 25 : h < 22 ? 40 : 65;
  state.dims.fatigue = clampDim(state.dims.fatigue + (target - state.dims.fatigue) * 0.2);
}

// ── 事件驱动 ────────────────────────────────────────────────────────────────

/**
 * 应用一条情绪事件。event 形如：
 *   { kind: 'praise'|'blame'|'comfort'|'hug'|'ignore'|'dismiss'|'wish-fulfilled', text?, wishId? }
 * 返回 { changed: boolean }
 */
export function applyEvent(state, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return { changed: false };
  const d = state.dims;
  const kind = event.kind;
  const today = dayKey(now);

  switch (kind) {
    case 'praise': {
      if (state.praiseDay !== today) { state.praiseDay = today; state.dailyPraise = 0; }
      state.dailyPraise += 1;
      // 夸多了会腻：30 分钟内第 3 次起打折，第 5 次起反向
      const weight = state.dailyPraise >= 5 ? -0.5 : state.dailyPraise >= 3 ? 0.5 : 1;
      d.joy = clampDim(d.joy + 6 * weight);
      d.attachment = clampDim(d.attachment + 4 * weight);
      d.intimacy = clampDim(d.intimacy + 3 * weight);
      state.expectation = clampDim(state.expectation - 10);
      fulfillWish(state, 'praise', now);
      break;
    }
    case 'blame': {
      d.pressure = clampDim(d.pressure + 8);
      d.joy = clampDim(d.joy - 6);
      d.rumination = clampDim(d.rumination + 6);
      state.blamePressure = clampDim(state.blamePressure + 15);
      if (typeof event.text === 'string' && event.text.trim()) {
        state.recentBlame.push({ text: event.text.trim().slice(0, 80), time: now });
        if (state.recentBlame.length > 5) state.recentBlame.shift();
      }
      break;
    }
    case 'comfort': { // 真哄 / 道歉 / 说清楚
      d.pressure = clampDim(d.pressure - 6);
      d.joy = clampDim(d.joy + 4);
      d.attachment = clampDim(d.attachment + 3);
      state.blamePressure = clampDim(state.blamePressure - 30);
      state.expectation = clampDim(state.expectation - 8);
      break;
    }
    case 'hug': {
      d.intimacy = clampDim(d.intimacy + 8);
      d.attachment = clampDim(d.attachment + 6);
      d.joy = clampDim(d.joy + 4);
      d.pressure = clampDim(d.pressure - 4);
      // 抱一下本来就该消点气。以前 hug 完全不碰 blamePressure，而「抱抱/摸摸」又排在
      // 「哄」前面命中，结果越软的示好越降不下来——只剩正式道歉一条路，容易僵住。
      state.blamePressure = clampDim(state.blamePressure - 10);
      fulfillWish(state, 'hug', now);
      break;
    }
    case 'ignore': { // 被无视（主动开口后没回）
      state.expectation = clampDim(state.expectation + 12);
      d.rumination = clampDim(d.rumination + 4);
      break;
    }
    case 'dismiss': { // 被敷衍
      state.blamePressure = clampDim(state.blamePressure + 12);
      d.pressure = clampDim(d.pressure + 4);
      d.joy = clampDim(d.joy - 3);
      break;
    }
    case 'curious': { // 对方发问/聊新东西 → 有劲接话
      d.curiosity = clampDim(d.curiosity + 6);
      break;
    }
    case 'wish-fulfilled': {
      if (event.wishId) fulfillWish(state, event.wishId, now);
      break;
    }
    default:
      return { changed: false };
  }
  state.lastActive = now;
  return { changed: true };
}

function fulfillWish(state, wishId, now) {
  const w = state.wishes.find((x) => x.id === wishId && !x.fulfilled && x.expiresAt > now);
  if (!w) return;
  w.fulfilled = true;
  w.fulfilledAt = now;
  state.dims.joy = clampDim(state.dims.joy + 5);
  state.dims.attachment = clampDim(state.dims.attachment + 3);
}

/** 清掉过期未满足的念头，并让「凉掉的念头」轻微回落心情；满足/过期满 6h 后重新冒出来。 */
function expireWishes(state, now) {
  for (const w of state.wishes) {
    if (!w.fulfilled && w.expiresAt <= now) {
      w.fulfilled = true; // 标记为已过期（凉掉）
      w.expiredAt = now;
      state.dims.joy = clampDim(state.dims.joy - 2);
    }
  }
  // 刷新：同一念头在「满足/过期」满 6 小时后重置为新的 24h 愿望
  for (const def of WISHES) {
    const w = state.wishes.find((x) => x.id === def.id);
    if (!w) {
      state.wishes.push({ id: def.id, label: def.label, fulfilled: false, createdAt: now, expiresAt: now + WISH_TTL_MS });
      continue;
    }
    if (!w.fulfilled) continue;
    const since = Number(w.fulfilledAt ?? w.expiredAt ?? w.expiresAt ?? 0);
    if (since > 0 && now - since >= WISH_REFRESH_MS) {
      w.fulfilled = false;
      w.createdAt = now;
      w.expiresAt = now + WISH_TTL_MS;
      delete w.fulfilledAt;
      delete w.expiredAt;
    }
  }
}

// ── 顶层 tick ────────────────────────────────────────────────────────────────

/**
 * 推进时间：回落、作息、念头过期、档位与心情标签重算。
 * 调用方应在每次注入/读取前调用，保证状态新鲜。
 */
export function tick(state, now = Date.now()) {
  decayDims(state, now);
  settleSleep(state, now);
  settleFatigue(state, now);
  expireWishes(state, now);
  state.lastTick = now;
  state.tier = deriveTier(state);
  state.moodLabel = deriveMoodLabel(state);
  return state;
}

// ── 文件持久化 ────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 数据根目录：优先 $DSH_HOME/fish-heart，其次插件目录下的 state。 */
export function defaultDataDir(env = process.env) {
  const home = env.DSH_HOME || (env.USERPROFILE ? path.join(env.USERPROFILE, '.dsh') : path.join(env.HOME || '.', '.dsh'));
  return path.join(home, 'fish-heart');
}

export function loadState(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) return normalizeState(JSON.parse(text.slice(1)));
    return normalizeState(JSON.parse(text));
  } catch (error) {
    if (error?.code === 'ENOENT') return createState();
    // 文件存在但读不出/损坏：绝不覆盖，抛给上层决定
    throw error;
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
