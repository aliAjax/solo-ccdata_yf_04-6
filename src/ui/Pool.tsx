// 待配池：未上船的箱，可拖入船图或点击选中后点船位
import { useState } from 'react';
import { portName } from '../types';
import type { ContainerT } from '../types';
import { useStore } from '../store';
import { BoxChip } from './BoxChip';

export function Pool({
  boxes, selectedId, conflictIds, onSelect, onEdit, onDropToPool,
}: {
  boxes: ContainerT[];
  selectedId: string | null;
  conflictIds: Set<string>;
  onSelect: (id: string | null) => void;
  onEdit: (c: ContainerT) => void;
  onDropToPool: (id: string) => void;
}) {
  const { api } = useStore();
  const [over, setOver] = useState(false);

  return (
    <section
      className={`panel pool ${over ? 'dropOver' : ''}`}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault(); setOver(false);
        const id = e.dataTransfer.getData('text/box-id');
        if (id) onDropToPool(id);
      }}
    >
      <h3>待配池 <em className="count">{boxes.length}</em></h3>
      {boxes.length === 0 && <p className="empty">全部集装箱已上船 ✔</p>}
      <div className="poolList">
        {boxes.map(c => (
          <div key={c.id} className="poolItem">
            <BoxChip
              c={c}
              selected={selectedId === c.id}
              inConflict={conflictIds.has(c.id)}
              onClick={() => onSelect(selectedId === c.id ? null : c.id)}
              onDragStart={e => { e.dataTransfer.setData('text/box-id', c.id); onSelect(c.id); }}
              onDragEnd={() => onSelect(null)}
            />
            <div className="poolMeta">
              <span>{portName(c.port)}</span>
              <button className="mini" onClick={() => onEdit(c)}>编辑</button>
              <button className="mini danger" onClick={() => { if (confirm(`删除 ${c.id}？`)) api.removeBox(c.id); }}>删</button>
            </div>
          </div>
        ))}
      </div>
      <p className="hint">拖动箱到右侧船位完成配载；或点击选中后点目标空位。拖回此面板即卸下。</p>
    </section>
  );
}
