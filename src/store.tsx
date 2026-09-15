// ============================================================
// 状态层：方案状态 + 本地持久化 + 双配载员同步（BroadcastChannel）
// 并发规则：任何改箱操作携带 baseVersion，版本不符即保留双方版本
// 并生成待裁定项，绝不静默覆盖。
// ============================================================
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import { PORTS, slotLabel } from './types';
import type { Conflict, ContainerT, DGClass, LogEntry, PlanState, SlotRef } from './types';
import { isoValid, mkBoxId, validate } from './rules';
import { seedState } from './seed';
import { fixAll, fixOne, injectScenario, rearrange } from './auto';
import type { ScenarioKey } from './auto';

const LS_KEY = 'dgsp.v1.state';
const ACTOR_KEY = 'dgsp.v1.actor';
const CH_NAME = 'dgsp.v1.sync';
const TAB_ID = Math.random().toString(36).slice(2, 10);

// ---------------- Reducer ----------------
type Action =
  | { type: 'add'; c: ContainerT; actor: string }
  | { type: 'apply'; next: ContainerT; baseVersion: number; actor: string; kind: string; logText: string; recheck?: boolean }
  | { type: 'remove'; id: string; baseVersion: number; actor: string }
  | { type: 'snapshot'; containers: Record<string, ContainerT>; actor: string; note: string; recheck?: boolean }
  | { type: 'resolve'; next: ContainerT; actor: string }
  | { type: 'confirm'; actor: string }
  | { type: 'log'; actor: string; kind: string; text: string }
  | { type: 'reset'; state: PlanState; actor: string };

let logSeq = 0;
const entry = (actor: string, kind: string, text: string): LogEntry => ({ id: ++logSeq, t: Date.now(), actor, kind, text });

function pushLog(s: PlanState, e: LogEntry): PlanState {
  return { ...s, log: [e, ...s.log].slice(0, 300) };
}

/** 变更类操作统一处理：确认失效 + planSeq 递增 */
function touch(s: PlanState): PlanState {
  return { ...s, confirmed: null, planSeq: s.planSeq + 1 };
}

/** 移箱/锁位/重排后自动全量复核并写入操作链 */
function autoRecheck(s: PlanState, actor: string): PlanState {
  const n = validate(s.containers).length;
  return pushLog(s, entry(actor, '复核', n ? `全量复核：发现 ${n} 项未解除冲突，方案不可确认` : '全量复核通过：无冲突'));
}

export function reducer(s: PlanState, a: Action): PlanState {
  switch (a.type) {
    case 'add': {
      if (s.containers[a.c.id]) {
        // 同箱号已存在：保留两份，提示人工裁定
        return pushLog({ ...s, resolutions: [...s.resolutions.filter(r => r.containerId !== a.c.id), { containerId: a.c.id, local: s.containers[a.c.id], remote: a.c, remoteBy: a.actor, at: Date.now() }] }, entry(a.actor, '裁定', `并发录入同箱号 ${a.c.id}：本地与对方版本均已保留，待人工裁定`));
      }
      let n = touch(s);
      n = { ...n, containers: { ...n.containers, [a.c.id]: a.c } };
      return pushLog(n, entry(a.actor, '录入', `录入集装箱 ${a.c.id}（${a.c.weight}t${a.c.reefer ? '·冷藏' : ''}）→ 待配池`));
    }
    case 'apply': {
      const cur = s.containers[a.next.id];
      if (!cur) return s;
      if (cur.version !== a.baseVersion) {
        // 并发冲突：本地与对方版本都保留，等待人工裁定
        const res = { containerId: cur.id, local: cur, remote: a.next, remoteBy: a.actor, at: Date.now() };
        let n = { ...s, resolutions: [...s.resolutions.filter(r => r.containerId !== cur.id), res] };
        return pushLog(n, entry(a.actor, '裁定', `并发改箱：${cur.id} 本地版本(v${cur.version})与 ${a.actor} 版本(v${a.next.version})冲突，两份修改均已保留，待人工裁定`));
      }
      let n = touch(s);
      n = { ...n, containers: { ...n.containers, [a.next.id]: a.next } };
      n = pushLog(n, entry(a.actor, a.kind, a.logText));
      return a.recheck ? autoRecheck(n, a.actor) : n;
    }
    case 'remove': {
      const cur = s.containers[a.id];
      if (!cur) return s;
      if (cur.version !== a.baseVersion) {
        return pushLog(s, entry(a.actor, '系统', `删除 ${a.id} 未执行：该箱刚被另一方修改（v${cur.version}），请先处理待裁定项`));
      }
      let n = touch(s);
      const cs = { ...n.containers };
      delete cs[a.id];
      n = { ...n, containers: cs, resolutions: n.resolutions.filter(r => r.containerId !== a.id) };
      return pushLog(n, entry(a.actor, '改箱', `删除集装箱 ${a.id}`));
    }
    case 'snapshot': {
      // 批量更新（重排/处置/对方快照）：逐箱按版本合并，本地更新版本更高则保留为待裁定
      const cs = { ...s.containers };
      let resolutions = s.resolutions;
      for (const inc of Object.values(a.containers)) {
        const local = cs[inc.id];
        if (!local || inc.version > local.version) {
          cs[inc.id] = inc;
          resolutions = resolutions.filter(r => r.containerId !== inc.id);
        } else if (inc.version < local.version) {
          resolutions = [...resolutions.filter(r => r.containerId !== inc.id), { containerId: inc.id, local, remote: inc, remoteBy: a.actor, at: Date.now() }];
        }
      }
      let n = touch({ ...s, containers: cs, resolutions });
      n = pushLog(n, entry(a.actor, '重排', a.note));
      return a.recheck ? autoRecheck(n, a.actor) : n;
    }
    case 'resolve': {
      const cur = s.containers[a.next.id];
      if (cur && a.next.version < cur.version) {
        return pushLog({ ...s, resolutions: [...s.resolutions.filter(r => r.containerId !== a.next.id), { containerId: a.next.id, local: cur, remote: a.next, remoteBy: a.actor, at: Date.now() }] }, entry(a.actor, '裁定', `并发裁定版本过期：${a.next.id} 已有更新版本，仍待人工裁定`));
      }
      let n = touch(s);
      n = { ...n, containers: { ...n.containers, [a.next.id]: a.next }, resolutions: n.resolutions.filter(r => r.containerId !== a.next.id) };
      return pushLog(n, entry(a.actor, '裁定', `人工裁定 ${a.next.id}：采用合并版本(v${a.next.version})，双方修改已归并`));
    }
    case 'confirm': {
      const conflicts = validate(s.containers);
      const unplaced = Object.values(s.containers).filter(c => !c.pos).length;
      if (conflicts.length || s.resolutions.length || unplaced) {
        return pushLog(s, entry(a.actor, '确认', `确认被拒绝：${conflicts.length} 项冲突 / ${s.resolutions.length} 项待裁定 / ${unplaced} 箱待配`));
      }
      return pushLog({ ...s, confirmed: { by: a.actor, at: Date.now() } }, entry(a.actor, '确认', `方案已确认生效（在船 ${Object.keys(s.containers).length} 箱，复核零冲突）`));
    }
    case 'log':
      return pushLog(s, entry(a.actor, a.kind, a.text));
    case 'reset':
      return pushLog(a.state, entry(a.actor, '系统', '方案已重置为初始示范船图'));
    default:
      return s;
  }
}

// ---------------- 持久化 ----------------
function loadState(): PlanState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as PlanState;
      if (p && p.containers && p.log) {
        logSeq = Math.max(0, ...p.log.map(l => l.id)) + 1;
        return p;
      }
    }
  } catch { /* 损坏则回退初始 */ }
  return seedState();
}

// ---------------- 同步消息 ----------------
type Op =
  | { kind: 'add'; c: ContainerT }
  | { kind: 'apply'; next: ContainerT; baseVersion: number; opKind: string; logText: string }
  | { kind: 'remove'; id: string; baseVersion: number }
  | { kind: 'snapshot'; containers: Record<string, ContainerT>; note: string }
  | { kind: 'resolve'; next: ContainerT }
  | { kind: 'confirm' }
  | { kind: 'reset'; state: PlanState };

interface Envelope { src: string; actor: string; op: Op }
interface Presence { src: string; actor: string; at: number }

// ---------------- Context ----------------
export interface BoxDraft { id: string; weight: number; dg: DGClass; reefer: boolean; port: string }

interface Api {
  actor: string;
  setActor: (a: string) => void;
  peers: Presence[];
  conflicts: Conflict[];
  canConfirm: { ok: boolean; reasons: string[] };
  demoRunning: boolean;
  addBox: (d: BoxDraft) => string | null;
  editBox: (id: string, patch: Partial<ContainerT>) => void;
  moveBox: (id: string, pos: SlotRef | null) => void;
  toggleLock: (id: string) => void;
  removeBox: (id: string) => void;
  doRearrange: () => void;
  doFix: (c: Conflict) => void;
  doFixAll: () => void;
  doRecheck: () => void;
  doConfirm: () => void;
  doReset: () => void;
  resolveBox: (id: string, merged: ContainerT) => void;
  runScenario: (k: ScenarioKey) => void;
  simulatePeerEdit: (id: string) => void;
  runDemo: () => void;
  stopDemo: () => void;
}

const StoreCtx = createContext<{ state: PlanState; api: Api } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);
  const [actor, setActorState] = useState(() => sessionStorage.getItem(ACTOR_KEY) || '王工');
  const [peers, setPeers] = useState<Presence[]>([]);
  const [demoRunning, setDemoRunning] = useState(false);
  const ref = useRef(state);
  const chRef = useRef<BroadcastChannel | null>(null);
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { ref.current = state; }, [state]);

  // 持久化：方案与操作链刷新后仍在
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* 存储满则忽略 */ }
  }, [state]);

  const send = useCallback((op: Op) => {
    chRef.current?.postMessage({ src: TAB_ID, actor, op } satisfies Envelope);
  }, [actor]);

  // 双端同步通道 + 在线状态
  useEffect(() => {
    const ch = new BroadcastChannel(CH_NAME);
    chRef.current = ch;
    const hello = () => ch.postMessage({ src: TAB_ID, actor, at: Date.now(), presence: true });
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.src === TAB_ID) return;
      if (m.presence) {
        setPeers(ps => [...ps.filter(p => p.src !== m.src), { src: m.src, actor: m.actor, at: Date.now() }]);
        if (m.ask) hello();
        return;
      }
      const env = m as Envelope;
      const who = env.actor;
      switch (env.op.kind) {
        case 'add': dispatch({ type: 'add', c: env.op.c, actor: who }); break;
        case 'apply': dispatch({ type: 'apply', next: env.op.next, baseVersion: env.op.baseVersion, actor: who, kind: env.op.opKind, logText: env.op.logText, recheck: true }); break;
        case 'remove': dispatch({ type: 'remove', id: env.op.id, baseVersion: env.op.baseVersion, actor: who }); break;
        case 'snapshot': dispatch({ type: 'snapshot', containers: env.op.containers, actor: who, note: env.op.note, recheck: true }); break;
        case 'resolve': dispatch({ type: 'resolve', next: env.op.next, actor: who }); break;
        case 'confirm': dispatch({ type: 'confirm', actor: who }); break;
        case 'reset': dispatch({ type: 'reset', state: env.op.state, actor: who }); break;
      }
    };
    hello();
    const hb = setInterval(() => {
      hello();
      setPeers(ps => ps.filter(p => Date.now() - p.at < 10000));
    }, 4000);
    return () => { clearInterval(hb); ch.close(); chRef.current = null; };
  }, [actor]);

  const setActor = useCallback((a: string) => {
    sessionStorage.setItem(ACTOR_KEY, a);
    setActorState(a);
  }, []);

  // ---------------- 高层操作 ----------------
  const applyBox = useCallback((next: ContainerT, baseVersion: number, kind: string, logText: string, recheck = true) => {
    dispatch({ type: 'apply', next, baseVersion, actor, kind, logText, recheck });
    send({ kind: 'apply', next, baseVersion, opKind: kind, logText });
  }, [actor, send]);

  const api = useMemo<Api>(() => {
    const st = () => ref.current;

    const addBox = (d: BoxDraft): string | null => {
      const id = d.id.toUpperCase().trim();
      if (!isoValid(id)) return '箱号不符合 ISO 6346 或校验位错误';
      if (st().containers[id]) return '该箱号已存在';
      if (!(d.weight > 0 && d.weight <= 40)) return '重量需在 0–40 吨之间';
      if (!PORTS.some(p => p.code === d.port)) return '请选择卸货港';
      const c: ContainerT = { id, weight: d.weight, dg: d.dg, reefer: d.reefer, port: d.port, pos: null, locked: false, version: 1, by: actor, at: Date.now() };
      dispatch({ type: 'add', c, actor });
      send({ kind: 'add', c });
      return null;
    };

    const editBox = (id: string, patch: Partial<ContainerT>) => {
      const cur = st().containers[id];
      if (!cur) return;
      const next: ContainerT = { ...cur, ...patch, id: cur.id, version: cur.version + 1, by: actor, at: Date.now() };
      applyBox(next, cur.version, '改箱', `修改 ${id}：${Object.keys(patch).join('/')} 已更新`);
    };

    const moveBox = (id: string, pos: SlotRef | null) => {
      const cur = st().containers[id];
      if (!cur) return;
      if (cur.locked) {
        dispatch({ type: 'log', actor, kind: '系统', text: `${id} 已锁位，需先解锁才能移动` });
        return;
      }
      const next: ContainerT = { ...cur, pos, version: cur.version + 1, by: actor, at: Date.now() };
      applyBox(next, cur.version, '移箱', `移箱 ${id}：${slotLabel(cur.pos)} → ${slotLabel(pos)}`);
    };

    const toggleLock = (id: string) => {
      const cur = st().containers[id];
      if (!cur) return;
      const next: ContainerT = { ...cur, locked: !cur.locked, version: cur.version + 1, by: actor, at: Date.now() };
      applyBox(next, cur.version, '锁位', `${next.locked ? '锁位' : '解锁'} ${id}（${slotLabel(cur.pos)}）`);
    };

    const removeBox = (id: string) => {
      const cur = st().containers[id];
      if (!cur) return;
      dispatch({ type: 'remove', id, baseVersion: cur.version, actor });
      send({ kind: 'remove', id, baseVersion: cur.version });
    };

    const applySnapshot = (containers: Record<string, ContainerT>, note: string) => {
      dispatch({ type: 'snapshot', containers, actor, note, recheck: true });
      send({ kind: 'snapshot', containers, note });
    };

    const doRearrange = () => {
      const r = rearrange(st().containers, actor);
      applySnapshot(r.containers, r.text);
    };

    const doFix = (c: Conflict) => {
      const r = fixOne(st().containers, c, actor);
      if (r) applySnapshot(r.containers, `处置「${c.title}」：${r.text}`);
      else dispatch({ type: 'log', actor, kind: '处置', text: `「${c.title}」涉及锁位箱，无法自动处置，请人工移箱` });
    };

    const doFixAll = () => {
      const r = fixAll(st().containers, actor);
      if (!r.steps.length) {
        dispatch({ type: 'log', actor, kind: '处置', text: '没有可自动处置的冲突' });
        return;
      }
      applySnapshot(r.containers, `一键处置 ${r.steps.length} 步${r.remaining ? `，仍余 ${r.remaining} 项需人工处理` : '，全部冲突已解除'}`);
    };

    const doRecheck = () => {
      const n = validate(st().containers).length;
      dispatch({ type: 'log', actor, kind: '复核', text: n ? `手动全量复核：${n} 项未解除冲突` : '手动全量复核通过：无冲突' });
    };

    const doConfirm = () => {
      dispatch({ type: 'confirm', actor });
      if (!validate(st().containers).length && !st().resolutions.length && !Object.values(st().containers).some(c => !c.pos)) {
        send({ kind: 'confirm' });
      }
    };

    const doReset = () => {
      const fresh = seedState();
      dispatch({ type: 'reset', state: fresh, actor });
      send({ kind: 'reset', state: fresh });
    };

    const resolveBox = (id: string, merged: ContainerT) => {
      const r = st().resolutions.find(x => x.containerId === id);
      const base = Math.max(r?.local.version ?? 0, r?.remote.version ?? 0, st().containers[id]?.version ?? 0);
      const next: ContainerT = { ...merged, id, version: base + 1, by: actor, at: Date.now() };
      dispatch({ type: 'resolve', next, actor });
      send({ kind: 'resolve', next });
    };

    const runScenario = (k: ScenarioKey) => {
      const r = injectScenario(st().containers, k, actor);
      if (r) applySnapshot(r.containers, r.text);
      else dispatch({ type: 'log', actor, kind: '演示', text: '场景注入失败：缺少合适的箱或船位' });
    };

    /** 模拟另一配载员基于过期版本改箱 → 触发待裁定（不静默覆盖） */
    const simulatePeerEdit = (id: string) => {
      const cur = st().containers[id];
      if (!cur) return;
      const peer = actor === '王工' ? '李工' : '王工';
      const staleBase = Math.max(1, cur.version - 1);
      const remote: ContainerT = {
        ...cur,
        weight: +(cur.weight * (cur.weight > 15 ? 0.85 : 1.2)).toFixed(1),
        port: PORTS[(PORTS.findIndex(p => p.code === cur.port) + 1) % PORTS.length].code,
        reefer: !cur.reefer,
        version: staleBase + 1,
        by: peer,
        at: Date.now(),
      };
      dispatch({ type: 'log', actor: peer, kind: '同步', text: `${peer} 基于旧版本(v${staleBase})提交了对 ${id} 的修改` });
      setTimeout(() => {
        dispatch({ type: 'apply', next: remote, baseVersion: staleBase, actor: peer, kind: '改箱', logText: `${peer} 修改 ${id}` });
      }, 350);
    };

    return {
      actor, setActor, peers, demoRunning,
      conflicts: validate(state.containers),
      canConfirm: (() => {
        const reasons: string[] = [];
        const n = validate(state.containers).length;
        if (n) reasons.push(`${n} 项冲突未解除`);
        if (state.resolutions.length) reasons.push(`${state.resolutions.length} 项并发修改待裁定`);
        const u = Object.values(state.containers).filter(c => !c.pos).length;
        if (u) reasons.push(`${u} 箱仍在待配池`);
        return { ok: !reasons.length, reasons };
      })(),
      addBox, editBox, moveBox, toggleLock, removeBox,
      doRearrange, doFix, doFixAll, doRecheck, doConfirm, doReset,
      resolveBox, runScenario, simulatePeerEdit,
      runDemo: () => { /* 在下方 runDemo 实现中替换 */ },
      stopDemo: () => { /* 同上 */ },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, actor, peers, demoRunning, applyBox, send, setActor]);

  // ---------------- 一键演示：录入→配载→复核→处置→确认 ----------------
  const demoToken = useRef(0);
  const runDemo = useCallback(() => {
    if (demoRunning) return;
    setDemoRunning(true);
    const token = ++demoToken.current;
    const s = () => ref.current;
    const log = (text: string) => dispatch({ type: 'log', actor, kind: '演示', text: `【演示】${text}` });
    const snap = (containers: Record<string, ContainerT>, note: string) => {
      dispatch({ type: 'snapshot', containers, actor, note, recheck: true });
      send({ kind: 'snapshot', containers, note });
    };
    const serial = Date.now() % 900000 + 100000;
    const steps: { label: string; run: () => void }[] = [
      {
        label: '录入新箱', run: () => {
          const mk = (owner: string, ser: number, weight: number, dg: DGClass, reefer: boolean, port: string): ContainerT => ({
            id: mkBoxId(owner, ser), weight, dg, reefer, port, pos: null, locked: false, version: 1, by: actor, at: Date.now(),
          });
          for (const c of [mk('DEMU', serial, 22, '5.1', false, 'RTM'), mk('DEMU', serial + 1, 15, 'NONE', true, 'SIN')]) {
            dispatch({ type: 'add', c, actor });
            send({ kind: 'add', c });
          }
          log('录入 2 只新箱（5.1类氧化剂 + 冷藏箱）进入待配池');
        },
      },
      {
        label: '批量配载', run: () => {
          const r = rearrange(s().containers, actor);
          snap(r.containers, `批量重排：${r.text}`);
          log('对待配池与未锁箱执行批量重排');
        },
      },
      {
        label: '全量复核', run: () => {
          const n = validate(s().containers).length;
          log(`全量复核完成：${n ? `发现 ${n} 项冲突` : '无冲突'}`);
        },
      },
      {
        label: '注入隔离违规', run: () => {
          const r = injectScenario(s().containers, 'seg', actor);
          if (r) snap(r.containers, r.text);
          log('已注入隔离违规场景（3类 ↔ 5.1类 同倍位）');
        },
      },
      {
        label: '处置隔离冲突', run: () => {
          const r = fixAll(s().containers, actor);
          snap(r.containers, `自动处置隔离冲突：${r.steps.join('；') || '无'}`);
        },
      },
      {
        label: '注入偏心超限', run: () => {
          const r = injectScenario(s().containers, 'list', actor);
          if (r) snap(r.containers, r.text);
          log('已注入偏心超限场景（重箱集中左舷）');
        },
      },
      {
        label: '处置偏心超限', run: () => {
          const r = fixAll(s().containers, actor);
          snap(r.containers, `自动处置偏心：${r.steps.join('；') || '无'}`);
        },
      },
      {
        label: '注入供电争抢', run: () => {
          const r = injectScenario(s().containers, 'reefer', actor);
          if (r) snap(r.containers, r.text);
          log('已注入冷藏供电争抢场景（冷藏箱挤入 Bay01）');
        },
      },
      {
        label: '处置供电争抢', run: () => {
          const r = fixAll(s().containers, actor);
          snap(r.containers, `自动分流冷藏箱：${r.steps.join('；') || '无'}`);
        },
      },
      {
        label: '并发改箱', run: () => {
          const target = Object.values(s().containers).find(c => !c.locked);
          if (!target) return;
          // 本方先改（版本+1），对方基于旧版本再改 → 冲突
          const local: ContainerT = { ...target, weight: +(target.weight + 2).toFixed(1), version: target.version + 1, by: actor, at: Date.now() };
          dispatch({ type: 'apply', next: local, baseVersion: target.version, actor, kind: '改箱', logText: `【演示】本方修改 ${target.id} 重量` });
          send({ kind: 'apply', next: local, baseVersion: target.version, opKind: '改箱', logText: `修改 ${target.id}` });
          const peer = actor === '王工' ? '李工' : '王工';
          const remote: ContainerT = { ...target, weight: +(target.weight - 3).toFixed(1), port: PORTS[0].code, version: target.version + 1, by: peer, at: Date.now() };
          setTimeout(() => {
            if (demoToken.current !== token) return;
            dispatch({ type: 'apply', next: remote, baseVersion: target.version, actor: peer, kind: '改箱', logText: `${peer} 并发修改 ${target.id}` });
            log(`并发改箱：本方与 ${peer} 同时修改 ${target.id}，两份版本均已保留，待人工裁定`);
          }, 400);
        },
      },
      {
        label: '人工裁定', run: () => {
          const r = s().resolutions[0];
          if (!r) { log('无待裁定项'); return; }
          const merged: ContainerT = { ...r.local, version: Math.max(r.local.version, r.remote.version) + 1, by: actor, at: Date.now() };
          dispatch({ type: 'resolve', next: merged, actor });
          send({ kind: 'resolve', next: merged });
          log(`裁定 ${r.containerId}：演示采用本方版本（实际操作中由人工在裁定窗口逐字段选择）`);
        },
      },
      {
        label: '终检与确认', run: () => {
          const fixed = fixAll(s().containers, actor);
          if (fixed.steps.length) snap(fixed.containers, `确认前终检处置：${fixed.steps.join('；')}`);
          const r2 = rearrange(fixed.containers, actor);
          snap(r2.containers, '确认前最终重排（含待配池）');
          setTimeout(() => {
            if (demoToken.current !== token) return;
            const n = validate(s().containers).length;
            if (!n && !s().resolutions.length && !Object.values(s().containers).some(c => !c.pos)) {
              dispatch({ type: 'confirm', actor });
              send({ kind: 'confirm' });
              log('复核零冲突、无待裁定、无待配箱 —— 方案已确认 ✔');
            } else {
              log(`终检未通过：${n} 项冲突 / ${s().resolutions.length} 项待裁定，请人工处理后确认`);
            }
          }, 500);
        },
      },
    ];
    let i = 0;
    const tickStep = () => {
      if (demoToken.current !== token) return;
      if (i >= steps.length) { setDemoRunning(false); log('演示流程结束'); return; }
      const step = steps[i++];
      log(`第${i}步 · ${step.label}`);
      step.run();
      demoTimer.current = setTimeout(tickStep, 1500);
    };
    tickStep();
  }, [actor, demoRunning, send]);

  const stopDemo = useCallback(() => {
    demoToken.current++;
    if (demoTimer.current) clearTimeout(demoTimer.current);
    setDemoRunning(false);
  }, []);

  // 把演示函数挂到 api（useMemo 中占位，这里用 ref 修正）
  const apiFinal = useMemo<Api>(() => ({ ...api, runDemo, stopDemo }), [api, runDemo, stopDemo]);

  useEffect(() => () => { if (demoTimer.current) clearTimeout(demoTimer.current); }, []);

  return <StoreCtx.Provider value={{ state, api: apiFinal }}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
