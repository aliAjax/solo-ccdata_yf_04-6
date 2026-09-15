// ============================================================
// 自动配载 / 自动处置 / 场景注入（纯函数，便于复核与测试）
// ============================================================
import {
  BAYS, ROWS, TIERS, REEFER_CAP, STACK_MAX_T, HEAVY_TOL,
  lever, portIdx, portName, slotLabel,
} from './types';
import type { Conflict, ContainerT, SlotRef } from './types';
import { balance, emptySlots, placed, reeferUsage, slotFeasible, stackAt, validate } from './rules';

type CMap = Record<string, ContainerT>;
const clone = (cs: CMap): CMap => Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, { ...v, pos: v.pos ? { ...v.pos } : null }]));

function bump(c: ContainerT, actor: string): ContainerT {
  return { ...c, version: c.version + 1, by: actor, at: Date.now() };
}

function put(cs: CMap, id: string, pos: SlotRef | null, actor: string) {
  cs[id] = bump({ ...cs[id], pos }, actor);
}

/** 堆内整理：自下而上按 卸港晚→早、重→轻 排序（满足靠港先后与重不压轻） */
function tidyStack(cs: CMap, bay: number, row: number, actor: string) {
  const stack = stackAt(cs, bay, row);
  if (stack.length < 2 || stack.some(c => c.locked)) return;
  const sorted = [...stack].sort((a, b) => portIdx(b.port) - portIdx(a.port) || b.weight - a.weight);
  sorted.forEach((c, i) => { if (c.pos!.tier !== i) put(cs, c.id, { bay, row, tier: i }, actor); });
}

// ---------------- 批量重排（尊重锁位） ----------------
export function rearrange(src: CMap, actor: string): { containers: CMap; text: string } {
  const cs = clone(src);
  const lockedPlaced = placed(cs).filter(c => c.locked);
  const moving = Object.values(cs).filter(c => !c.locked);
  for (const c of moving) cs[c.id] = { ...cs[c.id], pos: null };

  // 已占船位（锁位箱）+ 动态占用表
  const occ = new Set(lockedPlaced.map(c => `${c.pos!.bay}|${c.pos!.row}|${c.pos!.tier}`));
  const stackW = new Map<string, number>();
  for (const c of lockedPlaced) {
    const k = `${c.pos!.bay}|${c.pos!.row}`;
    stackW.set(k, (stackW.get(k) ?? 0) + c.weight);
  }
  const reeferUsed: Record<number, number> = {};
  for (const b of BAYS) reeferUsed[b] = lockedPlaced.filter(c => c.reefer && c.pos!.bay === b).length;

  // 放置顺序：冷藏优先（插座稀缺），再按重量降序
  const queue = [...moving].sort((a, b) => Number(b.reefer) - Number(a.reefer) || b.weight - a.weight);
  // 船位扫描顺序：层自底向上，列自中线向两舷
  const rowOrder = [2, 3, 1, 4, 0, 5];
  let moment = lockedPlaced.reduce((s, c) => s + c.weight * lever(c.pos!.row), 0);
  let placedN = 0, pooled = 0;

  for (const box of queue) {
    let best: SlotRef | null = null;
    let bestScore = Infinity;
    for (const bay of BAYS) {
      if (box.reefer && reeferUsed[bay] >= REEFER_CAP[bay]) continue;
      for (const row of rowOrder) for (let tier = 0; tier < TIERS; tier++) {
        const key = `${bay}|${row}|${tier}`;
        if (occ.has(key)) continue;
        if (tier > 0 && !occ.has(`${bay}|${row}|${tier - 1}`)) continue; // 下方须有支撑
        const w = (stackW.get(`${bay}|${row}`) ?? 0) + box.weight;
        if (w > STACK_MAX_T) continue;
        const slot = { bay, row, tier };
        if (!slotFeasible(cs, box, slot)) continue; // 隔离硬约束
        // 软约束评分：偏心矩最小化 + 靠港顺序（下方箱卸港应不早于本箱）
        const below = tier > 0 ? Object.values(cs).find(c => c.pos && c.pos.bay === bay && c.pos.row === row && c.pos.tier === tier - 1) : null;
        const portPenalty = below && portIdx(box.port) > portIdx(below.port) ? 1000 : 0;
        const heavyPenalty = below && box.weight > below.weight + HEAVY_TOL ? 500 : 0;
        const score = Math.abs(moment + box.weight * lever(row)) + portPenalty + heavyPenalty;
        if (score < bestScore) { bestScore = score; best = slot; }
      }
    }
    if (best) {
      put(cs, box.id, best, actor);
      occ.add(`${best.bay}|${best.row}|${best.tier}`);
      stackW.set(`${best.bay}|${best.row}`, (stackW.get(`${best.bay}|${best.row}`) ?? 0) + box.weight);
      if (box.reefer) reeferUsed[best.bay]++;
      moment += box.weight * lever(best.row);
      placedN++;
    } else {
      pooled++; // 无合规船位，留待配池
    }
  }
  // 每堆整理一遍（靠港先后 + 重不压轻）
  for (const bay of BAYS) for (let row = 0; row < ROWS; row++) tidyStack(cs, bay, row, actor);
  return { containers: cs, text: `批量重排完成：${placedN} 箱上船${pooled ? `，${pooled} 箱无合规船位留待配池` : ''}，锁位箱未动` };
}

// ---------------- 单条冲突自动处置 ----------------
export function fixOne(src: CMap, conflict: Conflict, actor: string): { containers: CMap; text: string } | null {
  const cs = clone(src);
  const mover = (ids: string[]) => ids.map(id => cs[id]).filter(Boolean).find(c => !c.locked);

  const findSlot = (box: ContainerT, preferBay?: number): SlotRef | null => {
    const usage = reeferUsage(cs);
    const bays = [...BAYS].sort((a, b) =>
      (preferBay === undefined ? 0 : Math.abs(BAYS.indexOf(a) - BAYS.indexOf(preferBay)) - Math.abs(BAYS.indexOf(b) - BAYS.indexOf(preferBay))));
    for (const bay of bays) {
      if (box.reefer && usage[bay] >= REEFER_CAP[bay]) continue;
      for (const row of [2, 3, 1, 4, 0, 5]) for (let tier = 0; tier < TIERS; tier++) {
        const slot = { bay, row, tier };
        if (Object.values(cs).some(c => c.pos && c.pos.bay === bay && c.pos.row === row && c.pos.tier === tier)) continue;
        if (slotFeasible(cs, box, slot)) return slot;
      }
    }
    return null;
  };

  switch (conflict.rule) {
    case 'SEG': {
      const m = mover(conflict.containers);
      if (!m) return null;
      const other = cs[conflict.containers.find(id => id !== m.id)!];
      const slot = findSlot(m);
      if (slot) { put(cs, m.id, slot, actor); return { containers: cs, text: `隔离处置：${m.id} 移至 ${slotLabel(slot)}，与 ${other.id} 满足隔离间距` }; }
      put(cs, m.id, null, actor);
      return { containers: cs, text: `隔离处置：${m.id} 暂无合规船位，已移回待配池` };
    }
    case 'LIST': {
      const { moment } = balance(cs);
      const heavyLeft = moment < 0;
      const cands = placed(cs)
        .filter(c => !c.locked && (heavyLeft ? c.pos.row < ROWS / 2 : c.pos.row >= ROWS / 2))
        .sort((a, b) => Math.abs(b.weight * lever(b.pos.row)) - Math.abs(a.weight * lever(a.pos.row)));
      for (const c of cands) {
        const mirror = ROWS - 1 - c.pos.row;
        for (let tier = 0; tier < TIERS; tier++) {
          const slot = { bay: c.pos.bay, row: mirror, tier };
          if (Object.values(cs).some(x => x.pos && x.pos.bay === slot.bay && x.pos.row === slot.row && x.pos.tier === tier)) continue;
          if (slotFeasible(cs, c, slot)) {
            put(cs, c.id, slot, actor);
            return { containers: cs, text: `偏心处置：${c.id}（${c.weight}t）自${heavyLeft ? '左' : '右'}舷移至镜像列 ${slotLabel(slot)}` };
          }
        }
      }
      return null;
    }
    case 'REEFER': {
      const bay = conflict.bay!;
      const m = placed(cs).filter(c => c.reefer && c.pos.bay === bay && !c.locked)[0];
      if (!m) return null;
      const slot = findSlot(m, bay);
      if (slot) { put(cs, m.id, slot, actor); return { containers: cs, text: `供电处置：冷藏箱 ${m.id} 自 Bay${String(bay).padStart(2, '0')} 分流至 ${slotLabel(slot)}` }; }
      put(cs, m.id, null, actor);
      return { containers: cs, text: `供电处置：${m.id} 无可用冷藏插座，已移回待配池` };
    }
    case 'PORT': {
      const [above] = conflict.containers;
      const a = cs[above];
      if (!a?.pos) return null;
      const stack = stackAt(cs, a.pos.bay, a.pos.row);
      if (stack.some(c => c.locked)) {
        if (a.locked) return null;
        put(cs, a.id, null, actor);
        return { containers: cs, text: `靠港处置：堆内含锁位箱，${a.id} 移回待配池待人工调整` };
      }
      tidyStack(cs, a.pos.bay, a.pos.row, actor);
      return { containers: cs, text: `靠港处置：Bay${String(a.pos.bay).padStart(2, '0')}-${a.pos.row + 1}列 已按卸港顺序重排（晚卸在下）` };
    }
    case 'STACK': {
      if (conflict.id.startsWith('STACK:W:')) {
        const [, , bayS, rowS] = conflict.id.split(':');
        const stack = stackAt(cs, +bayS, +rowS);
        const top = [...stack].reverse().find(c => !c.locked);
        if (!top) return null;
        put(cs, top.id, null, actor);
        return { containers: cs, text: `叠放处置：堆重超限，顶箱 ${top.id} 移回待配池` };
      }
      if (conflict.id.startsWith('STACK:EXP:')) {
        const exp = cs[conflict.containers[0]];
        if (!exp?.pos || exp.locked) return null;
        const stack = stackAt(cs, exp.pos.bay, exp.pos.row);
        const top = stack[stack.length - 1];
        if (top.locked) return null;
        const t = exp.pos.tier;
        put(cs, exp.id, { ...exp.pos, tier: top.pos!.tier }, actor);
        put(cs, top.id, { ...top.pos!, tier: t }, actor);
        return { containers: cs, text: `叠放处置：爆炸品 ${exp.id} 与顶箱 ${top.id} 互换，已置堆顶` };
      }
      // 重压轻：两者均未锁则互换，否则上箱回池
      const [above, below] = conflict.containers.map(id => cs[id]);
      if (!above?.pos || !below?.pos) return null;
      if (!above.locked && !below.locked) {
        const t = above.pos.tier;
        put(cs, above.id, { ...above.pos, tier: below.pos.tier }, actor);
        put(cs, below.id, { ...below.pos, tier: t }, actor);
        return { containers: cs, text: `叠放处置：${above.id} 与 ${below.id} 上下互换，重箱在下` };
      }
      if (above.locked) return null;
      put(cs, above.id, null, actor);
      return { containers: cs, text: `叠放处置：${above.id} 移回待配池（下方箱已锁位）` };
    }
  }
}

/** 一键处置：循环处置直至无冲突或达到上限 */
export function fixAll(src: CMap, actor: string): { containers: CMap; steps: string[]; remaining: number } {
  let cs = clone(src);
  const steps: string[] = [];
  for (let i = 0; i < 25; i++) {
    const conflicts = validate(cs);
    if (!conflicts.length) break;
    const r = fixOne(cs, conflicts[0], actor);
    if (!r) break;
    cs = r.containers;
    steps.push(r.text);
  }
  return { containers: cs, steps, remaining: validate(cs).length };
}

// ---------------- 场景注入（用于核对各类冲突） ----------------
export type ScenarioKey = 'seg' | 'list' | 'reefer' | 'port' | 'stack';

export function injectScenario(src: CMap, key: ScenarioKey, actor: string): { containers: CMap; text: string } | null {
  const cs = clone(src);
  const byId = (pred: (c: ContainerT) => boolean) => Object.values(cs).find(pred);

  if (key === 'seg') {
    const dg3 = byId(c => c.dg === '3' && !!c.pos && !c.locked);
    const dg51 = byId(c => c.dg === '5.1' && !c.locked);
    if (!dg3 || !dg51) return null;
    // 把 5.1 搬到 3 类同倍位相邻列，触发「隔离：不得同倍位」
    const target: SlotRef = { bay: dg3.pos!.bay, row: Math.min(dg3.pos!.row + 1, ROWS - 1), tier: 0 };
    if (Object.values(cs).some(c => c.pos && c.pos.bay === target.bay && c.pos.row === target.row && c.pos.tier === target.tier)) {
      target.row = Math.max(dg3.pos!.row - 1, 0);
    }
    put(cs, dg51.id, target, actor);
    return { containers: cs, text: `场景注入·隔离违规：${dg51.id}（5.1类）移至 ${slotLabel(target)}，与 ${dg3.id}（3类）同倍位相邻` };
  }
  if (key === 'list') {
    // 把三只最重的未锁箱集中搬到左舷外列，制造偏心超限
    const heavies = placed(cs).filter(c => !c.locked).sort((a, b) => b.weight - a.weight).slice(0, 3);
    const leftSlots = emptySlots(cs).filter(s => s.row <= 1 && s.tier <= 1)
      .filter(s => s.tier === 0 || Object.values(cs).some(c => c.pos && c.pos.bay === s.bay && c.pos.row === s.row && c.pos.tier === s.tier - 1));
    heavies.forEach((c, i) => { if (leftSlots[i]) put(cs, c.id, leftSlots[i], actor); });
    return { containers: cs, text: `场景注入·偏心超限：${heavies.map(c => c.id).join('、')} 集中调至左舷外列` };
  }
  if (key === 'reefer') {
    // 全部冷藏箱集中到 Bay01（插座仅 2 个）
    const reefers = Object.values(cs).filter(c => c.reefer && !c.locked);
    const slots: SlotRef[] = [{ bay: 1, row: 0, tier: 0 }, { bay: 1, row: 2, tier: 0 }, { bay: 1, row: 3, tier: 0 }, { bay: 1, row: 5, tier: 0 }];
    let n = 0;
    for (const r of reefers) {
      const free = slots.find(s => !Object.values(cs).some(c => c.pos && c.pos.bay === s.bay && c.pos.row === s.row && c.pos.tier === s.tier));
      if (!free) break;
      put(cs, r.id, free, actor); n++;
    }
    return { containers: cs, text: `场景注入·供电争抢：${n} 台冷藏箱集中到 Bay01（插座上限 ${REEFER_CAP[1]}）` };
  }
  if (key === 'port') {
    // 找一个两层堆，上下互换制造「晚卸压早卸」
    for (const bay of BAYS) for (let row = 0; row < ROWS; row++) {
      const stack = stackAt(cs, bay, row);
      if (stack.length >= 2 && stack.every(c => !c.locked)) {
        const b0 = stack[0], b1 = stack[1];
        if (portIdx(b0.port) > portIdx(b1.port)) {
          put(cs, b0.id, { bay, row, tier: 1 }, actor);
          put(cs, b1.id, { bay, row, tier: 0 }, actor);
          return { containers: cs, text: `场景注入·靠港颠倒：${b1.id}（${portName(b1.port)}）被压到 ${b0.id}（${portName(b0.port)}）之下` };
        }
      }
    }
    return null;
  }
  // stack：把最重的待配/未锁箱压到最轻堆顶，触发重压轻
  const heavy = Object.values(cs).filter(c => !c.locked).sort((a, b) => b.weight - a.weight)[0];
  if (!heavy) return null;
  let lightest: ContainerT | null = null;
  for (const bay of BAYS) for (let row = 0; row < ROWS; row++) {
    const st = stackAt(cs, bay, row);
    if (st.length && st.length < TIERS && st.every(c => !c.locked)) {
      const top = st[st.length - 1];
      if (!lightest || top.weight < lightest.weight) lightest = top;
    }
  }
  if (!lightest || heavy.id === lightest.id) return null;
  const t: SlotRef = { bay: lightest.pos!.bay, row: lightest.pos!.row, tier: lightest.pos!.tier + 1 };
  put(cs, heavy.id, t, actor);
  return { containers: cs, text: `场景注入·叠放违规：${heavy.id}（${heavy.weight}t）压上 ${lightest.id}（${lightest.weight}t）堆顶` };
}
