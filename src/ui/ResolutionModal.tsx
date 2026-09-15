// 并发改箱人工裁定弹窗：两份修改并排，逐字段取舍，绝不静默覆盖
import { useMemo, useState } from 'react';
import { DG_META, fmtTime, portName, slotLabel } from '../types';
import type { ContainerT, Resolution } from '../types';
import { useStore } from '../store';

type FieldKey = 'weight' | 'dg' | 'reefer' | 'port' | 'pos' | 'locked';

const FIELDS: { key: FieldKey; label: string; fmt: (c: ContainerT) => string }[] = [
  { key: 'weight', label: '重量', fmt: c => `${c.weight} t` },
  { key: 'dg', label: '危险类别', fmt: c => DG_META[c.dg].label },
  { key: 'reefer', label: '冷藏需求', fmt: c => (c.reefer ? '需要 ❄' : '不需要') },
  { key: 'port', label: '卸货港', fmt: c => portName(c.port) },
  { key: 'pos', label: '配载位置', fmt: c => slotLabel(c.pos) },
  { key: 'locked', label: '锁位', fmt: c => (c.locked ? '🔒 已锁' : '未锁') },
];

const same = (a: ContainerT, b: ContainerT, k: FieldKey) => {
  if (k === 'pos') return slotLabel(a.pos) === slotLabel(b.pos);
  return a[k] === b[k];
};

function ResolutionItem({ r, index, total }: { r: Resolution; index: number; total: number }) {
  const { api } = useStore();
  // 每个字段选择 'local' 或 'remote'
  const [pick, setPick] = useState<Record<FieldKey, 'local' | 'remote'>>(() => {
    const init = {} as Record<FieldKey, 'local' | 'remote'>;
    for (const f of FIELDS) init[f.key] = same(r.local, r.remote, f.key) ? 'local' : 'local';
    return init;
  });

  const merged: ContainerT = useMemo(() => {
    const m = { ...r.local };
    for (const f of FIELDS) {
      const src = pick[f.key] === 'local' ? r.local : r.remote;
      if (f.key === 'pos') m.pos = src.pos ? { ...src.pos } : null;
      else (m as Record<string, unknown>)[f.key] = src[f.key];
    }
    return m;
  }, [r, pick]);

  const setAll = (side: 'local' | 'remote') => {
    const next = {} as Record<FieldKey, 'local' | 'remote'>;
    for (const f of FIELDS) next[f.key] = side;
    setPick(next);
  };

  return (
    <div className="resItem">
      <div className="resHead">
        <b>⇄ 并发改箱待裁定 · {r.containerId}</b>
        <span>第 {index + 1}/{total} 项</span>
      </div>
      <p className="resSub">
        本方与 {r.remoteBy} 几乎同时修改了该箱，两份修改均已保留。请逐字段取舍后应用裁定，系统不会静默覆盖任何一方。
      </p>
      <table className="resTable">
        <thead>
          <tr>
            <th>字段</th>
            <th>本方版本（v{r.local.version} · {r.local.by} · {fmtTime(r.local.at)}）</th>
            <th>对方版本（v{r.remote.version} · {r.remoteBy} · {fmtTime(r.remote.at)}）</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map(f => {
            const diff = !same(r.local, r.remote, f.key);
            return (
              <tr key={f.key} className={diff ? 'diff' : ''}>
                <td>{f.label}{diff && <i className="diffDot" title="双方不一致" />}</td>
                {(['local', 'remote'] as const).map(side => {
                  const c = side === 'local' ? r.local : r.remote;
                  return (
                    <td
                      key={side}
                      className={`pick ${pick[f.key] === side ? 'chosen' : ''}`}
                      onClick={() => setPick(p => ({ ...p, [f.key]: side }))}
                    >
                      {f.fmt(c)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="resBtns">
        <button className="mini" onClick={() => setAll('local')}>全用本方</button>
        <button className="mini" onClick={() => setAll('remote')}>全用对方</button>
        <button className="primary" onClick={() => api.resolveBox(r.containerId, merged)}>
          应用裁定（生成 v{Math.max(r.local.version, r.remote.version) + 1}）
        </button>
      </div>
    </div>
  );
}

export function ResolutionModal() {
  const { state } = useStore();
  if (!state.resolutions.length) return null;
  return (
    <div className="modalMask">
      <div className="modal">
        {state.resolutions.map((r, i) => (
          <ResolutionItem key={r.containerId} r={r} index={i} total={state.resolutions.length} />
        ))}
      </div>
    </div>
  );
}
