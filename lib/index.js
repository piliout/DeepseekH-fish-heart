// fish-heart —— DSH 情绪记录（host 插件接线层）。
//
// 职责：把 lib/heart.js 的「硬状态情绪记录」接到 DSH 上——
//   1. HTTP 路由 /api/fish-heart/state 与 /command（供任何桥接按需读写）；
//   2. settings 命名空间 fish-heart（可热改配置）；
//   3. 事件感知（best-effort）：关键词判断被夸/被责怪/被哄/被抱。
//
// 只记录、不注入：心境由模型自己从人格卡 + 对话临场判断，本插件不替它定。
// 消息收发、人格卡、记忆、日记一律不碰——由宿主桥接 / 其它插件负责。

import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  createState, normalizeState, tick, applyEvent,
  loadState, saveState, defaultDataDir,
} from './heart.js';

export const name = 'fish-heart';
export const inject = ['connection'];

// ── 配置 schema（settings 命名空间 = entry id = fish-heart）─────────────────
// 字段必须带 .extra('volatile', true)：DSH 0.2.x 的 settings 写入只认 volatile 字段，
// 且 volatile 表示「热改不重挂载」。用 .extra 而非 .volatile()（后者只存在于 DSH 自带
// 的 schemastery，本包钉的 ^3.18.1 那份没有，见 qq-mode-console 的同类注释）。
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后不感知，数据保留').extra('volatile', true),
  perceiveFromDsh: z.boolean().default(false).description('是否直接监听 DSH 的 user/message；默认关闭，由宿主桥接通过 /command 转发消息').extra('volatile', true),
  bedtime: z.string().default('23:30').description('作息：入睡时间 HH:mm').extra('volatile', true),
  wakeAt: z.string().default('07:30').description('作息：起床时间 HH:mm').extra('volatile', true),
});

const CONFIG_DEFAULTS = {
  enabled: true, perceiveFromDsh: false,
  bedtime: '23:30', wakeAt: '07:30',
};

// ── 简单情绪感知（关键词，best-effort）──────────────────────────────────────
// 只做可证明的判断，不猜语义；命中才 applyEvent。攻击/责怪词才进 blame，避免误伤正常聊天。

const PRAISE_RE = /(真棒|厉害|好棒|好看|可爱|喜欢你|爱你|牛|强|不错|爱了|夸|太强|好家伙|绝了)/i;
const BLAME_RE = /(你他妈|废物|傻逼|煞笔|滚蛋|傻x|智障|猪脑子|去死)/i;
const COMFORT_RE = /(对不起|我错了|别生气|抱歉|抱抱|摸摸|乖|没事|不哭|心疼你)/i;
const HUG_RE = /(抱抱|摸摸|贴贴)/i;
const DISMISS_RE = /^(哦|嗯|随便|不知道|关你屁事|关我屁事)[。！？!?.…~～\s]*$/i;
// 「想听你说今天怎么样」：对方分享今天 / 今天过得怎么样的句式
const TODAY_RE = /(我今天|今天(?:有点|特别|好|挺|去|吃|上班|加班|忙|累|烦|开心|难过|遇到|做了|去了|买了|收到))/i;
const CURIOUS_RE = /(你知道吗|什么是|为什么|怎么做|教我|科普|讲一下)/;

function perceiveText(state, text, now) {
  const raw = String(text ?? '');
  // 跳过桥接注入的唤醒提示/系统块（它们带【当前时间】【当前角色】【会话令牌】），
  // 否则一整段人格卡会当成“用户消息”喂进情绪词表（实测误判成责怪）
  if (/^【当前时间】/.test(raw) || raw.includes('【当前角色】') || raw.includes('【会话令牌】')) return;
  // 再剥掉引用块 / 转发 / @昵称，避免群名片（如「娜娜闭嘴版」）或引用原文里的词误伤
  const s = raw
    .replace(/\[引用[^\]]*\]/g, ' ')
    .replace(/【转发[\s\S]*$/, ' ')
    .replace(/@[^\s，,。！？!?]+/g, ' ')
    .trim();
  if (!s) return;
  if (BLAME_RE.test(s)) { applyEvent(state, { kind: 'blame', text: s }, now); return; }
  if (HUG_RE.test(s)) { applyEvent(state, { kind: 'hug' }, now); return; }
  if (COMFORT_RE.test(s)) { applyEvent(state, { kind: 'comfort' }, now); return; }
  if (PRAISE_RE.test(s)) { applyEvent(state, { kind: 'praise' }, now); return; }
  if (TODAY_RE.test(s)) { applyEvent(state, { kind: 'wish-fulfilled', wishId: 'today' }, now); return; }
  if (CURIOUS_RE.test(s)) { applyEvent(state, { kind: 'curious' }, now); return; }
  if (DISMISS_RE.test(s)) { applyEvent(state, { kind: 'dismiss' }, now); }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && c.type === 'text' ? String(c.text ?? '') : ''))
    .join(' ');
}

// ── 公开视图（HTTP /state 返回，避免把内部字段全抖出去）──────────────────────
function publicView(state) {
  const { dims, expectation, blamePressure, tier, moodLabel, wishes, sleep } = state;
  return {
    tier,
    tierLabel: { daily: '日常', wronged: '委屈', angry: '生气', afraid: '害怕', avoidant: '回避' }[tier] ?? tier,
    moodLabel,
    dims,
    expectation,
    blamePressure,
    wishes: wishes.map((w) => ({ id: w.id, label: w.label, fulfilled: w.fulfilled })),
    sleep: { asleep: sleep.asleep, bedtime: sleep.bedtime, wakeAt: sleep.wakeAt, lateNight: sleep.lateNight },
    recentBlameCount: (state.recentBlame ?? []).length,
  };
}

// ── 装配 ────────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const cfg = { ...CONFIG_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const dataDir = defaultDataDir();
  const stateFile = path.join(dataDir, 'state.json');

  let state;
  try {
    state = loadState(stateFile);
  } catch (error) {
    ctx.logger?.warn?.('fish-heart: 状态读取失败，从零开始', error?.message ?? error);
    state = createState();
  }

  // settings 里的作息热更新：每次 tick 前同步进 state，settleSleep 才能读到
  const syncSleepCfg = () => {
    if (typeof cfg.bedtime === 'string' && cfg.bedtime) state.sleep.bedtime = cfg.bedtime;
    if (typeof cfg.wakeAt === 'string' && cfg.wakeAt) state.sleep.wakeAt = cfg.wakeAt;
  };
  const tickNow = (now = Date.now()) => {
    syncSleepCfg();
    tick(state, now);
  };

  const persist = () => {
    try { saveState(stateFile, state); } catch (error) {
      ctx.logger?.warn?.('fish-heart: 状态写入失败', error?.message ?? error);
    }
  };

  // 1) 命令直连接口（供宿主桥接按需读写状态 / 喂感知）
  ctx.inject(['connection'], (c) => {
    const conn = c.get('connection');
    if (!conn || typeof conn.fetch?.register !== 'function') return;

    c.effect(() => conn.fetch.register({
      path: '/api/fish-heart/state',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try { tickNow(Date.now()); } catch {}
        return Response.json({ ok: true, value: publicView(state) }, { headers: { 'cache-control': 'no-store' } });
      },
    }));

    c.effect(() => conn.fetch.register({
      path: '/api/fish-heart/command',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (req) => {
        const body = await req.json().catch(() => ({}));
        const action = String(body?.action ?? '');
        const now = Date.now();
        switch (action) {
          case 'status':
            try { tickNow(now); } catch {}
            return Response.json({ ok: true, value: publicView(state) });
          case 'calm':
            state.blamePressure = 0;
            state.tier = 'daily';
            state.recentBlame = [];
            try { tickNow(now); } catch {}
            persist();
            return Response.json({ ok: true, value: publicView(state) });
          case 'reset':
            state = createState(now);
            persist();
            return Response.json({ ok: true, value: publicView(state) });
          case 'tick':
            try { tickNow(now); } catch {}
            persist();
            return Response.json({ ok: true, value: publicView(state) });
          case 'perceive': {
            const text = String(body?.text ?? '');
            if (!text.trim()) return Response.json({ ok: false, error: 'text 不能为空' }, { status: 400 });
            perceive(text);
            return Response.json({ ok: true, value: publicView(state) });
          }
          case 'event': {
            const kind = String(body?.kind ?? '');
            if (['praise', 'blame', 'comfort', 'hug', 'ignore', 'dismiss', 'curious', 'wish-fulfilled'].includes(kind)) {
              applyEvent(state, { kind, text: body?.text }, now);
              try { tickNow(now); } catch {}
              persist();
              return Response.json({ ok: true, value: publicView(state) });
            }
            return Response.json({ ok: false, error: `未知事件类型：${kind}` }, { status: 400 });
          }
          default:
            return Response.json({ ok: false, error: `未知命令：${action}` }, { status: 400 });
        }
      },
    }));
  });

  // 2) 事件感知（best-effort）：被夸/被责怪/被哄/被抱
  const perceive = (text) => {
    if (cfg.enabled === false) return;
    if (!text) return;
    const before = JSON.stringify(state);
    perceiveText(state, text, Date.now());
    if (JSON.stringify(state) !== before) {
      try { tickNow(Date.now()); } catch {}
      persist();
    }
  };

  try {
    ctx.on('agent/created', ({ agent }) => {
      const actx = agent?.ctx;
      if (!actx || typeof actx.on !== 'function') return;
      actx.on('session/event', (session, event) => {
        try {
          if (!cfg.perceiveFromDsh) return; // 默认不监听：由宿主桥接通过 /command 转发消息
          // dsh-mnemon 实测：session/event 回调是 (session, event) 两个参数；
          // user/message 的 event.data 就是消息体（含 source/content），别当 payload 包一层。
          if (!event || event.type !== 'user/message') return;
          const source = event.data?.source;
          if (source && source.kind && source.kind !== 'user') return; // 跳过 skill/system 等非用户消息
          perceive(extractText(event.data?.content));
        } catch {}
      });
    });
  } catch {}

  ctx.logger?.info?.('fish-heart: 已装配；数据目录', dataDir);
}
