// ============================================================
// 领域模型：危险品集装箱配载台
// ============================================================

/** 危险类别（IMDG 简化），NONE = 普通货 */
export type DGClass = 'NONE' | '1' | '2.1' | '3' | '4.2' | '5.1' | '6.1' | '8' | '9';

/** 船位坐标：倍位 / 列（0..5，0-2 左舷 3-5 右舷）/ 层（0 底 .. 3 顶） */
export interface SlotRef {
  bay: number;
  row: number;
  tier: number;
}

/** 集装箱。version 用于并发改箱的乐观并发控制 */
export interface ContainerT {
  id: string;          // 箱号 ISO 6346，如 TCLU1234567
  weight: number;      // 吨
  dg: DGClass;
  reefer: boolean;     // 冷藏需求
  port: string;        // 卸货港代码
  pos: SlotRef | null; // null = 待配池
  locked: boolean;     // 锁位：批量重排/自动处置不得移动
  version: number;
  by: string;          // 最后修改人
  at: number;          // 最后修改时间
}

/** 一份待裁定的并发冲突：本地版本 vs 对方版本，两份都保留，人工裁定前不覆盖 */
export interface Resolution {
  containerId: string;
  local: ContainerT;
  remote: ContainerT;
  remoteBy: string;
  at: number;
}

export type RuleKey = 'SEG' | 'LIST' | 'REEFER' | 'PORT' | 'STACK';

/** 一条复核冲突：指明涉及集装箱与触发规则 */
export interface Conflict {
  id: string;
  rule: RuleKey;
  title: string;
  containers: string[];
  detail: string;
  bay?: number;
}

export interface LogEntry {
  id: number;
  t: number;
  actor: string;
  kind: string; // 录入/改箱/移箱/锁位/重排/复核/处置/裁定/确认/同步/演示/系统
  text: string;
}

export interface PlanState {
  containers: Record<string, ContainerT>;
  resolutions: Resolution[];
  log: LogEntry[];
  confirmed: { by: string; at: number } | null;
  planSeq: number;
}

// ---------------- 船舶与规则常量 ----------------

export const BAYS = [1, 3, 5, 7, 9, 11];          // 倍位号（奇数命名）
export const ROWS = 6;                             // 每倍位列数，0-2 左舷 / 3-5 右舷
export const TIERS = 4;                            // 层数，0 为舱面最底层
export const REEFER_CAP: Record<number, number> = { 1: 2, 3: 4, 5: 4, 7: 4, 9: 4, 11: 2 };
export const STACK_MAX_T = 100;                    // 单堆总重上限（t）
export const HEAVY_TOL = 5;                        // 重不压轻容差（t）
export const LIST_LIMIT = 60;                      // 左右偏心矩上限（t·列）

/** 靠港先后：装港上海，卸港按靠港顺序 */
export const PORTS = [
  { code: 'SIN', name: '新加坡' },
  { code: 'CMB', name: '科伦坡' },
  { code: 'JEA', name: '杰贝阿里' },
  { code: 'RTM', name: '鹿特丹' },
  { code: 'HAM', name: '汉堡' },
];
export const portIdx = (code: string) => Math.max(0, PORTS.findIndex(p => p.code === code));
export const portName = (code: string) => PORTS.find(p => p.code === code)?.name ?? code;

export const DG_META: Record<DGClass, { label: string; short: string; color: string }> = {
  NONE: { label: '普通货', short: '普', color: '#5b7a99' },
  '1': { label: '1类 爆炸品', short: '1', color: '#f97316' },
  '2.1': { label: '2.1类 易燃气体', short: '2.1', color: '#ef4444' },
  '3': { label: '3类 易燃液体', short: '3', color: '#dc2626' },
  '4.2': { label: '4.2类 易自燃', short: '4.2', color: '#f59e0b' },
  '5.1': { label: '5.1类 氧化剂', short: '5.1', color: '#eab308' },
  '6.1': { label: '6.1类 毒性物质', short: '6.1', color: '#c084fc' },
  '8': { label: '8类 腐蚀性', short: '8', color: '#94a3b8' },
  '9': { label: '9类 杂项(锂电)', short: '9', color: '#22c55e' },
};

export const RULE_META: Record<RuleKey, { name: string; icon: string }> = {
  SEG: { name: '危险品隔离', icon: '☣' },
  LIST: { name: '左右偏心', icon: '⚖' },
  REEFER: { name: '冷藏供电', icon: '❄' },
  PORT: { name: '靠港先后', icon: '⚓' },
  STACK: { name: '叠放限制', icon: '▤' },
};

/** 列号 → 偏心杠杆（列距中线） */
export const lever = (row: number) => row - (ROWS - 1) / 2;
export const isPort = (row: number) => row < ROWS / 2; // 左舷

export const slotLabel = (s: SlotRef | null) =>
  s ? `Bay${String(s.bay).padStart(2, '0')}-${s.row + 1}列-T${s.tier + 1}` : '待配池';

export const fmtTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
