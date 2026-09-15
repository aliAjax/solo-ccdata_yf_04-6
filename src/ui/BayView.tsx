// 船图：倍位条 + 选中倍位剖面（列×层）拖放配载
import { useState } from 'react';
import { BAYS, ROWS, TIERS, REEFER_CAP, STACK_MAX_T, lever, slotLabel } from '../types';
import type { ContainerT, SlotRef } from '../types';
import { reeferUsage, stackAt } from '../rules';
import { useStore } from '../store';
import { BoxChip } from './BoxChip';

export function BayView({
  selectedBay, onSelectBay, selectedId, conflictIds, conflictBays, onSelect,
}: {
  selectedBay: number;
  onSelectBay: (b: number) => void;
  selectedId: string | null;
  conflictIds: Set<string>;
  conflictBays: Set<number>;
  onSelect: (id: string | null) => void;
}) {
  const { state, api } = useStore();
  const [overSlot, setOverSlot] = useState<string | null>(null);
  const [overBay, setOverBay] = useState<number | null>(null);
  const usage = reeferUsage(state.containers);
  const all = Object.values(state.containers);

  const bayStats = (bay: number) => {
    const boxes = all.filter(c => c.pos?.bay === bay);
    return { n: boxes.length, w: boxes.reduce((s, c) => s + c.weight, 0) };
  };

  const dropTo = (pos: SlotRef | null, e: React.DragEvent) => {
    e.preventDefault();
    setOverSlot(null); setOverBay(null);
    const id = e.dataTransfer.getData('text/box-id');
    if (id) api.moveBox(id, pos);
  };

  /** 点击空位：若有选中箱则移动过去 */
  const clickSlot = (pos: SlotRef) => {
    if (selectedId) {
      const cur = state.containers[selectedId];
      if (cur && !cur.pos) api.moveBox(selectedId, pos);
      else if (cur && cur.pos && slotLabel(cur.pos) !== slotLabel(pos)) api.moveBox(selectedId, pos);
      onSelect(null);
    }
  };

  const firstFreeInBay = (bay: number): SlotRef | null => {
    for (let tier = 0; tier < TIERS; tier++) for (let row = 0; row < ROWS; row++) {
      if (tier > 0 && !all.some(c => c.pos?.bay === bay && c.pos.row === row && c.pos.tier === tier - 1)) continue;
      if (!all.some(c => c.pos?.bay === bay && c.pos.row === row && c.pos.tier === tier)) return { bay, row, tier };
    }
    return null;
  };

  return (
    <div className="bayWrap">
      {/* 倍位条：船体俯视 */}
      <div className="bayStrip">
        <div className="bow">◀ 船艏</div>
        {BAYS.map(bay => {
          const st = bayStats(bay);
          const over = usage[bay] > REEFER_CAP[bay];
          return (
            <button
              key={bay}
              className={[
                'bayCard',
                selectedBay === bay ? 'active' : '',
                conflictBays.has(bay) ? 'hasConflict' : '',
                overBay === bay ? 'dropOver' : '',
              ].join(' ')}
              onClick={() => onSelectBay(bay)}
              onDragOver={e => { e.preventDefault(); setOverBay(bay); }}
              onDragLeave={() => setOverBay(null)}
              onDrop={e => {
                const pos = firstFreeInBay(bay);
                if (pos) dropTo(pos, e);
                else { e.preventDefault(); setOverBay(null); }
              }}
              title={`Bay${String(bay).padStart(2, '0')} · ${st.n}箱 · ${st.w.toFixed(0)}t · 冷藏 ${usage[bay]}/${REEFER_CAP[bay]}`}
            >
              <b>Bay{String(bay).padStart(2, '0')}</b>
              <span>{st.n}箱 · {st.w.toFixed(0)}t</span>
              <span className={over ? 'rfBad' : 'rfOk'}>❄ {usage[bay]}/{REEFER_CAP[bay]}</span>
              {conflictBays.has(bay) && <i className="cDot" />}
            </button>
          );
        })}
        <div className="stern">船艉 ▶</div>
      </div>

      {/* 剖面图 */}
      <section className="panel section">
        <h3>
          Bay{String(selectedBay).padStart(2, '0')} 横剖面
          <em className="sub">左舷 ← 船体中线 → 右舷 · 层 T1(底)–T{TIERS}(顶) · 单堆限 {STACK_MAX_T}t</em>
        </h3>
        <div className="grid" style={{ ['--rows' as string]: ROWS }}>
          <div className="tierCol">
            {[...Array(TIERS)].map((_, i) => <div key={i} className="tierLbl">T{TIERS - i}</div>)}
            <div className="tierLbl" />
          </div>
          <div className="cells">
            {[...Array(TIERS)].map((_, ti) => {
              const tier = TIERS - 1 - ti;
              return [...Array(ROWS)].map((__, row) => {
                const stack = stackAt(state.containers, selectedBay, row);
                const box = stack.find(c => c.pos!.tier === tier);
                const key = `${selectedBay}|${row}|${tier}`;
                const supported = tier === 0 || stack.some(c => c.pos!.tier === tier - 1);
                if (box) {
                  return (
                    <div key={key} className="cell occupied">
                      <BoxChip
                        c={box}
                        compact
                        selected={selectedId === box.id}
                        inConflict={conflictIds.has(box.id)}
                        onClick={() => onSelect(selectedId === box.id ? null : box.id)}
                        onDragStart={e => { e.dataTransfer.setData('text/box-id', box.id); onSelect(box.id); }}
                        onDragEnd={() => onSelect(null)}
                        onLock={() => api.toggleLock(box.id)}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={key}
                    className={[
                      'cell', 'empty',
                      supported ? 'ok' : 'noSupport',
                      overSlot === key ? 'dropOver' : '',
                      selectedId && supported ? 'canDrop' : '',
                      row === ROWS / 2 - 1 ? 'portEdge' : '',
                    ].join(' ')}
                    onDragOver={e => { if (supported) { e.preventDefault(); setOverSlot(key); } }}
                    onDragLeave={() => setOverSlot(null)}
                    onDrop={e => supported && dropTo({ bay: selectedBay, row, tier }, e)}
                    onClick={() => supported && clickSlot({ bay: selectedBay, row, tier })}
                    title={supported ? `空位 ${slotLabel({ bay: selectedBay, row, tier })}` : '下方无支撑，不可放置'}
                  />
                );
              });
            })}
            {/* 堆重条 */}
            {[...Array(ROWS)].map((_, row) => {
              const w = stackAt(state.containers, selectedBay, row).reduce((s, c) => s + c.weight, 0);
              const pct = Math.min(100, (w / STACK_MAX_T) * 100);
              return (
                <div key={`w${row}`} className={`stackBar ${w > STACK_MAX_T ? 'over' : ''}`} title={`${row + 1}列 堆重 ${w.toFixed(1)}/${STACK_MAX_T}t`}>
                  <i style={{ height: `${pct}%` }} />
                  <span>{w > 0 ? w.toFixed(0) : ''}</span>
                </div>
              );
            })}
            {/* 列号 */}
            {[...Array(ROWS)].map((_, row) => (
              <div key={`r${row}`} className={`rowLbl ${lever(row) < 0 ? 'port' : 'stbd'}`}>
                {row + 1}列{row === ROWS / 2 - 1 ? ' ┃' : ''}
              </div>
            ))}
          </div>
        </div>
        <div className="legend">
          <span><i className="sw" style={{ background: '#5b7a99' }} />普通</span>
          <span><i className="sw" style={{ background: '#dc2626' }} />3类</span>
          <span><i className="sw" style={{ background: '#eab308' }} />5.1类</span>
          <span><i className="sw" style={{ background: '#c084fc' }} />6.1类</span>
          <span><i className="sw" style={{ background: '#94a3b8' }} />8类</span>
          <span><i className="sw" style={{ background: '#22c55e' }} />9类</span>
          <span>❄ 冷藏</span><span>🔒 锁位</span>
          <span className="lgConflict">◉ 涉冲突</span>
        </div>
      </section>
    </div>
  );
}
