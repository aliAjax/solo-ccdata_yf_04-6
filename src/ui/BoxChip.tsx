// 集装箱标签（箱号/类别/冷藏/锁位/冲突高亮），待配池与船图共用
import { DG_META, portName, slotLabel } from '../types';
import type { ContainerT } from '../types';

export function BoxChip({
  c, selected, inConflict, compact, onClick, onDragStart, onDragEnd, onLock,
}: {
  c: ContainerT;
  selected?: boolean;
  inConflict?: boolean;
  compact?: boolean;
  onClick?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onLock?: () => void;
}) {
  const meta = DG_META[c.dg];
  return (
    <div
      className={[
        'chip',
        selected ? 'sel' : '',
        inConflict ? 'conflict' : '',
        c.locked ? 'locked' : '',
        compact ? 'compact' : '',
      ].join(' ')}
      style={{ ['--dg' as string]: meta.color }}
      draggable={!c.locked}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={e => { e.stopPropagation(); onClick?.(); }}
      title={`${c.id}\n${c.weight}t · ${meta.label}${c.reefer ? ' · 冷藏' : ''}\n卸 ${portName(c.port)} · ${slotLabel(c.pos)}\nv${c.version} · ${c.by}${c.locked ? '\n🔒 已锁位' : ''}`}
    >
      <span className="dgNo">{meta.short}</span>
      <span className="cid">{c.id.slice(4)}</span>
      <span className="cw">{c.weight}t</span>
      {c.reefer && <span className="rf">❄</span>}
      {c.locked && <span className="lk">🔒</span>}
      {onLock && (
        <button
          className="lockBtn"
          title={c.locked ? '解锁' : '锁位（重排/处置不动）'}
          onClick={e => { e.stopPropagation(); onLock(); }}
        >{c.locked ? '🔓' : '🔒'}</button>
      )}
    </div>
  );
}
