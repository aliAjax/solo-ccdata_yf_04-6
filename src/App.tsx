// 配载台主界面
import { useMemo, useState } from 'react';
import { StoreProvider, useStore } from './store';
import type { Conflict, ContainerT } from './types';
import { Header } from './ui/Header';
import { EntryForm } from './ui/EntryForm';
import { Pool } from './ui/Pool';
import { BayView } from './ui/BayView';
import { SidePanels } from './ui/SidePanels';
import { ResolutionModal } from './ui/ResolutionModal';
import { BAYS } from './types';

function Layout() {
  const { state, api } = useStore();
  const [selectedBay, setSelectedBay] = useState(BAYS[1]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ContainerT | null>(null);

  const { conflictIds, conflictBays } = useMemo(() => {
    const ids = new Set<string>();
    const bays = new Set<number>();
    for (const c of api.conflicts) {
      c.containers.forEach(id => ids.add(id));
      if (c.bay !== undefined) bays.add(c.bay);
      c.containers.forEach(id => {
        const b = state.containers[id]?.pos?.bay;
        if (b !== undefined) bays.add(b);
      });
    }
    return { conflictIds: ids, conflictBays: bays };
  }, [api.conflicts, state.containers]);

  const poolBoxes = useMemo(
    () => Object.values(state.containers).filter(c => !c.pos).sort((a, b) => a.id.localeCompare(b.id)),
    [state.containers],
  );

  const locate = (c: Conflict) => {
    const first = c.containers[0];
    const box = first ? state.containers[first] : null;
    if (box?.pos) setSelectedBay(box.pos.bay);
    else if (c.bay !== undefined) setSelectedBay(c.bay);
    if (first) setSelectedId(first);
  };

  return (
    <div className="app">
      <Header />
      <main className="main">
        <div className="leftCol">
          <EntryForm editing={editing} onDone={() => setEditing(null)} />
          <Pool
            boxes={poolBoxes}
            selectedId={selectedId}
            conflictIds={conflictIds}
            onSelect={setSelectedId}
            onEdit={c => setEditing(c)}
            onDropToPool={id => api.moveBox(id, null)}
          />
        </div>
        <BayView
          selectedBay={selectedBay}
          onSelectBay={setSelectedBay}
          selectedId={selectedId}
          conflictIds={conflictIds}
          conflictBays={conflictBays}
          onSelect={setSelectedId}
        />
        <SidePanels onLocate={locate} />
      </main>
      <footer className="foot">
        方案与操作链已本地持久化（localStorage），刷新自动恢复 · 移箱 / 锁位 / 批量重排后自动全量复核 · 存在未解除冲突或待裁定项时无法确认方案
      </footer>
      <ResolutionModal />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  );
}
