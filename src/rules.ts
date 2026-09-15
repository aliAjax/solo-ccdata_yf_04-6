// ============================================================
// 规则引擎：隔离 / 偏心 / 冷藏供电 / 靠港先后 / 叠放
// validate() 为全量复核入口，任何移箱、锁位、重排后都必须重跑
// ============================================================
import {
  BAYS, ROWS, TIERS, REEFER_CAP, STACK_MAX_T, HEAVY_TOL, LIST_LIMIT,
  DG_META, RULE_META, lever, portIdx, portName, slotLabel,
} from './types';
import type { Conflict, ContainerT, DGClass, SlotRef } from './types';

// ---------------- ISO 6346 箱号校验 ----------------
const ISO_VALS = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
const charVal = (ch: string) => (/\d/.test(ch) ? +ch : ISO_VALS[ch.charCodeAt(0) - 65]);

export function isoCheckDigit(head10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += charVal(head10[i]) * 2 ** i;
  const r = sum % 11;
  return r === 10 ? 0 : r;
}
export function isoValid(id: string): boolean {
  if (!/^[A-Z]{4}\d{7}$/.test(id)) return false;
  return isoCheckDigit(id.slice(0, 10)) === +id[10];
}
export function mkBoxId(owner: string, serial: number): string {
  const head = owner.toUpperCase().padEnd(4, 'X').slice(0, 4) + String(serial).padStart(6, '0');
  return head + isoCheckDigit(head);
}

// ---------------- 危险品隔离表（IMDG 简化） ----------------
// 0 允许相邻 / 1 远离(不得同堆或紧邻) / 2 隔离(不得同倍位) / 3 严禁(不得相邻倍位)
const SEG_PAIRS: [DGClass, DGClass, number][] = [
  ['1', '1', 3], ['1', '2.1', 3], ['1', '3', 3], ['1', '4.2', 3],
  ['1', '5.1', 3], ['1', '6.1', 3], ['1', '8', 3], ['1', '9', 3],
  ['3', '5.1', 2], ['4.2', '5.1', 2],
  ['2.1', '3', 1], ['3', '4.2', 1], ['3', '8', 1],
  ['5.1', '8', 1], ['6.1', '8', 1], ['2.1', '5.1', 1],
];
const SEG_MAP = new Map<string, number>();
for (const [a, b, lv] of SEG_PAIRS) SEG_MAP.set([a, b].sort().join('|'), lv);

export const segRequired = (a: DGClass, b: DGClass): number =>
  a === 'NONE' || b === 'NONE' ? 0 : (SEG_MAP.get([a, b].sort().join('|')) ?? 0);

const SEG_LEVEL_TEXT = ['', '远离（不得同堆或紧邻）', '隔离（不得同倍位）', '严禁（不得相邻倍位）'];

/** 两箱实际间距是否满足隔离等级 */
function segViolated(a: SlotRef, b: SlotRef, level: number): boolean {
  const bayDist = Math.abs(BAYS.indexOf(a.bay) - BAYS.indexOf(b.bay));
  if (level === 3) return bayDist <= 1;
  if (level === 2) return bayDist === 0;
  // level 1：同倍位内 同堆 或 相邻格（列距≤1 且 层距≤1）
  if (bayDist !== 0) return false;
  const rowD = Math.abs(a.row - b.row);
  const tierD = Math.abs(a.tier - b.tier);
  return rowD <= 1 && tierD <= 1;
}

// ---------------- 工具 ----------------
export const placed = (cs: Record<string, ContainerT>) =>
  Object.values(cs).filter(c => c.pos) as (ContainerT & { pos: SlotRef })[];

export function stackAt(cs: Record<string, ContainerT>, bay: number, row: number) {
  return placed(cs).filter(c => c.pos.bay === bay && c.pos.row === row)
    .sort((a, b) => a.pos.tier - b.pos.tier);
}

export function balance(cs: Record<string, ContainerT>) {
  let left = 0, right = 0, moment = 0;
  for (const c of placed(cs)) {
    if (c.pos.row < ROWS / 2) left += c.weight; else right += c.weight;
    moment += c.weight * lever(c.pos.row);
  }
  return { left, right, moment };
}

export function reeferUsage(cs: Record<string, ContainerT>) {
  const usage: Record<number, number> = {};
  for (const b of BAYS) usage[b] = 0;
  for (const c of placed(cs)) if (c.reefer) usage[c.pos.bay]++;
  return usage;
}

export function emptySlots(cs: Record<string, ContainerT>): SlotRef[] {
  const occ = new Set(placed(cs).map(c => `${c.pos.bay}|${c.pos.row}|${c.pos.tier}`));
  const out: SlotRef[] = [];
  for (const bay of BAYS) for (let row = 0; row < ROWS; row++) for (let tier = 0; tier < TIERS; tier++) {
    if (!occ.has(`${bay}|${row}|${tier}`)) out.push({ bay, row, tier });
  }
  return out;
}

/** 该箱放入此船位是否满足：层位连续（下方有箱或在底层）+ 与已配箱的隔离 */
export function slotFeasible(cs: Record<string, ContainerT>, box: ContainerT, slot: SlotRef): boolean {
  if (slot.tier > 0 && !placed(cs).some(c => c.pos.bay === slot.bay && c.pos.row === slot.row && c.pos.tier === slot.tier - 1)) return false;
  for (const other of placed(cs)) {
    if (other.id === box.id) continue;
    const lv = segRequired(box.dg, other.dg);
    if (lv > 0 && segViolated(slot, other.pos, lv)) return false;
  }
  return true;
}

// ---------------- 全量复核 ----------------
export function validate(cs: Record<string, ContainerT>): Conflict[] {
  const out: Conflict[] = [];
  const boxes = placed(cs);

  // 1) 危险品隔离
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const lv = segRequired(a.dg, b.dg);
    if (lv > 0 && segViolated(a.pos, b.pos, lv)) {
      out.push({
        id: `SEG:${[a.id, b.id].sort().join('+')}`,
        rule: 'SEG',
        title: `隔离冲突：${a.id} 与 ${b.id}`,
        containers: [a.id, b.id],
        bay: a.pos.bay,
        detail: `${a.id}（${DG_META[a.dg].label}，${slotLabel(a.pos)}）与 ${b.id}（${DG_META[b.dg].label}，${slotLabel(b.pos)}）距离过近。触发规则【${RULE_META.SEG.name}】：${DG_META[a.dg].short}类 ↔ ${DG_META[b.dg].short}类 要求「${SEG_LEVEL_TEXT[lv]}」。`,
      });
    }
  }

  // 2) 左右偏心
  const { left, right, moment } = balance(cs);
  if (Math.abs(moment) > LIST_LIMIT) {
    const heavyLeft = moment < 0;
    const contrib = boxes
      .filter(c => (heavyLeft ? c.pos.row < ROWS / 2 : c.pos.row >= ROWS / 2))
      .sort((x, y) => Math.abs(y.weight * lever(y.pos.row)) - Math.abs(x.weight * lever(x.pos.row)))
      .slice(0, 4);
    out.push({
      id: 'LIST:ship',
      rule: 'LIST',
      title: `偏心超限：${heavyLeft ? '左' : '右'}舷偏重 ${Math.abs(moment).toFixed(1)} t·列`,
      containers: contrib.map(c => c.id),
      detail: `左舷 ${left.toFixed(1)}t / 右舷 ${right.toFixed(1)}t，偏心矩 ${moment.toFixed(1)} t·列，超过上限 ±${LIST_LIMIT}。触发规则【${RULE_META.LIST.name}】。主要贡献箱：${contrib.map(c => `${c.id}(${c.weight}t@${slotLabel(c.pos)})`).join('、')}。`,
    });
  }

  // 3) 冷藏供电上限
  const usage = reeferUsage(cs);
  for (const bay of BAYS) {
    const cap = REEFER_CAP[bay];
    if (usage[bay] > cap) {
      const reefers = boxes.filter(c => c.reefer && c.pos.bay === bay);
      out.push({
        id: `REEFER:${bay}`,
        rule: 'REEFER',
        title: `冷藏供电超载：Bay${String(bay).padStart(2, '0')} ${usage[bay]}/${cap}`,
        containers: reefers.map(c => c.id),
        bay,
        detail: `Bay${String(bay).padStart(2, '0')} 冷藏插座 ${cap} 个，已接 ${usage[bay]} 台冷藏箱：${reefers.map(c => c.id).join('、')}。触发规则【${RULE_META.REEFER.name}】：单倍位冷藏箱不得超过插座上限。`,
      });
    }
  }

  // 4) 靠港先后（先卸的箱不得被后卸的箱压住）
  for (const bay of BAYS) for (let row = 0; row < ROWS; row++) {
    const stack = stackAt(cs, bay, row);
    for (let t = 0; t + 1 < stack.length; t++) {
      const below = stack[t], above = stack[t + 1];
      if (portIdx(above.port) > portIdx(below.port)) {
        out.push({
          id: `PORT:${above.id}+${below.id}`,
          rule: 'PORT',
          title: `靠港顺序颠倒：${above.id} 压住 ${below.id}`,
          containers: [above.id, below.id],
          bay,
          detail: `${above.id}（卸 ${portName(above.port)}·第${portIdx(above.port) + 1}港）压在 ${below.id}（卸 ${portName(below.port)}·第${portIdx(below.port) + 1}港）之上，到 ${portName(below.port)} 须翻箱。触发规则【${RULE_META.PORT.name}】：堆内自下而上卸港顺序不得递增。`,
        });
      }
    }
  }

  // 5) 叠放限制
  for (const bay of BAYS) for (let row = 0; row < ROWS; row++) {
    const stack = stackAt(cs, bay, row);
    if (!stack.length) continue;
    const total = stack.reduce((s, c) => s + c.weight, 0);
    if (total > STACK_MAX_T) {
      out.push({
        id: `STACK:W:${bay}:${row}`,
        rule: 'STACK',
        title: `堆重超限：Bay${String(bay).padStart(2, '0')}-${row + 1}列 ${total.toFixed(1)}t`,
        containers: stack.map(c => c.id),
        bay,
        detail: `该堆累计 ${total.toFixed(1)}t，超过单堆上限 ${STACK_MAX_T}t。触发规则【${RULE_META.STACK.name}】：单堆总重 ≤ ${STACK_MAX_T}t。堆内箱：${stack.map(c => `${c.id}(${c.weight}t)`).join('、')}。`,
      });
    }
    for (let t = 0; t + 1 < stack.length; t++) {
      const below = stack[t], above = stack[t + 1];
      if (above.weight > below.weight + HEAVY_TOL) {
        out.push({
          id: `STACK:HL:${above.id}+${below.id}`,
          rule: 'STACK',
          title: `重箱压轻箱：${above.id} 压 ${below.id}`,
          containers: [above.id, below.id],
          bay,
          detail: `${above.id}（${above.weight}t）比下方 ${below.id}（${below.weight}t）重 ${(above.weight - below.weight).toFixed(1)}t，超过容差 ${HEAVY_TOL}t。触发规则【${RULE_META.STACK.name}】：上箱重量 ≤ 下箱 + ${HEAVY_TOL}t。`,
        });
      }
    }
    // 1类爆炸品必须位于堆顶（便于应急抛弃）
    const top = stack[stack.length - 1];
    for (const c of stack) {
      if (c.dg === '1' && c.id !== top.id) {
        out.push({
          id: `STACK:EXP:${c.id}`,
          rule: 'STACK',
          title: `爆炸品未置顶层：${c.id}`,
          containers: [c.id, top.id],
          bay,
          detail: `${c.id}（1类 爆炸品）被 ${top.id} 压在 ${slotLabel(c.pos)}。触发规则【${RULE_META.STACK.name}】：1类爆炸品必须位于所在堆最顶层。`,
        });
      }
    }
  }
  return out;
}
