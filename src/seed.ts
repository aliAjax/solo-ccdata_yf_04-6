// ============================================================
// 初始演示数据：一艘 6 倍位船的已配方案 + 待配池
// ============================================================
import { mkBoxId } from './rules';
import type { ContainerT, DGClass, PlanState } from './types';

let clock = 1;
const t0 = Date.now();
const tick = () => t0 + clock++;

interface SeedSpec {
  owner: string; serial: number; weight: number; dg?: DGClass;
  reefer?: boolean; port: string; pos?: [number, number, number];
}

const SPECS: SeedSpec[] = [
  // Bay01
  { owner: 'TCLU', serial: 100001, weight: 26, port: 'HAM', pos: [1, 1, 0] },
  { owner: 'TCLU', serial: 100002, weight: 22, port: 'RTM', pos: [1, 1, 1] },
  { owner: 'MSKU', serial: 200001, weight: 18, dg: '8', port: 'JEA', pos: [1, 4, 0] },
  { owner: 'MSKU', serial: 200002, weight: 12, port: 'SIN', pos: [1, 4, 1] },
  // Bay03
  { owner: 'CSNU', serial: 300001, weight: 24, port: 'HAM', pos: [3, 2, 0] },
  { owner: 'CSNU', serial: 300002, weight: 20, reefer: true, port: 'CMB', pos: [3, 2, 1] },
  { owner: 'CSNU', serial: 300003, weight: 21, port: 'RTM', pos: [3, 3, 0] },
  { owner: 'CSNU', serial: 300004, weight: 14, dg: '9', port: 'SIN', pos: [3, 3, 1] },
  { owner: 'OOCU', serial: 400001, weight: 16, dg: '3', port: 'JEA', pos: [3, 0, 0] },
  // Bay05
  { owner: 'EGLU', serial: 500001, weight: 27, port: 'HAM', pos: [5, 4, 0] },
  { owner: 'EGLU', serial: 500002, weight: 23, port: 'HAM', pos: [5, 4, 1] },
  { owner: 'EGLU', serial: 500003, weight: 15, reefer: true, port: 'RTM', pos: [5, 4, 2] },
  { owner: 'HLCU', serial: 600001, weight: 19, dg: '6.1', port: 'CMB', pos: [5, 1, 0] },
  // Bay07
  { owner: 'HLCU', serial: 600002, weight: 25, port: 'RTM', pos: [7, 2, 0] },
  { owner: 'HLCU', serial: 600003, weight: 17, port: 'SIN', pos: [7, 2, 1] },
  { owner: 'ONEU', serial: 700001, weight: 20, dg: '5.1', port: 'JEA', pos: [7, 3, 0] },
  // Bay09
  { owner: 'ONEU', serial: 700002, weight: 13, reefer: true, port: 'SIN', pos: [9, 0, 0] },
  { owner: 'CMAU', serial: 800001, weight: 22, port: 'CMB', pos: [9, 5, 0] },
  { owner: 'CMAU', serial: 800002, weight: 16, port: 'SIN', pos: [9, 5, 1] },
  // 待配池
  { owner: 'TCLU', serial: 100003, weight: 18, dg: '4.2', port: 'RTM' },
  { owner: 'MSKU', serial: 200003, weight: 11, reefer: true, port: 'SIN' },
  { owner: 'CSNU', serial: 300005, weight: 28, port: 'HAM' },
];

export function seedState(): PlanState {
  const containers: Record<string, ContainerT> = {};
  for (const s of SPECS) {
    const id = mkBoxId(s.owner, s.serial);
    containers[id] = {
      id,
      weight: s.weight,
      dg: s.dg ?? 'NONE',
      reefer: !!s.reefer,
      port: s.port,
      pos: s.pos ? { bay: s.pos[0], row: s.pos[1], tier: s.pos[2] } : null,
      locked: false,
      version: 1,
      by: '系统初始化',
      at: tick(),
    };
  }
  return {
    containers,
    resolutions: [],
    log: [{
      id: 1, t: t0, actor: '系统', kind: '系统',
      text: `已载入示范船图：在船 ${Object.values(containers).filter(c => c.pos).length} 箱，待配 ${Object.values(containers).filter(c => !c.pos).length} 箱。所有数据本地持久化，刷新不丢失。`,
    }],
    confirmed: null,
    planSeq: 1,
  };
}
