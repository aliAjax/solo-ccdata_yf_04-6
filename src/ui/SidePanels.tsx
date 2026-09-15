// 右栏：冲突复核 / 操作链 / 场景演练 三个页签
import { useState } from 'react';
import { RULE_META, fmtTime, portName } from '../types';
import type { Conflict } from '../types';
import { useStore } from '../store';

export function SidePanels({ onLocate }: { onLocate: (c: Conflict) => void }) {
  const [tab, setTab] = useState<'conflict' | 'log' | 'demo'>('conflict');
  const { state, api } = useStore();

  return (
    <div className="side">
      <div className="tabs">
        <button className={tab === 'conflict' ? 'active' : ''} onClick={() => setTab('conflict')}>
          冲突复核{api.conflicts.length > 0 && <em className="badge">{api.conflicts.length}</em>}
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>操作链</button>
        <button className={tab === 'demo' ? 'active' : ''} onClick={() => setTab('demo')}>场景演练</button>
      </div>

      {tab === 'conflict' && (
        <section className="panel grow">
          <div className="panelHead">
            <h3>实时全量复核</h3>
            <div className="headBtns">
              <button className="mini" onClick={api.doRecheck}>全量复核</button>
              <button className="mini" onClick={api.doFixAll} disabled={!api.conflicts.length}>一键处置</button>
            </div>
          </div>
          {api.conflicts.length === 0 ? (
            <div className="allClear">✔ 复核通过<small>隔离 / 偏心 / 供电 / 靠港 / 叠放 均无冲突</small></div>
          ) : (
            <div className="conflictList">
              {api.conflicts.map(c => (
                <div key={c.id} className={`conflict rule-${c.rule}`}>
                  <div className="cHead">
                    <span className="ruleIcon">{RULE_META[c.rule].icon}</span>
                    <b>{c.title}</b>
                  </div>
                  <p>{c.detail}</p>
                  <div className="cBoxes">
                    {c.containers.map(id => <code key={id}>{id}</code>)}
                  </div>
                  <div className="cBtns">
                    <button className="mini" onClick={() => onLocate(c)}>定位</button>
                    <button className="mini accent" onClick={() => api.doFix(c)}>自动处置</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!api.canConfirm.ok && (
            <div className="blockers">
              确认方案前须解决：{api.canConfirm.reasons.map(r => <span key={r} className="blk">{r}</span>)}
            </div>
          )}
        </section>
      )}

      {tab === 'log' && (
        <section className="panel grow">
          <div className="panelHead"><h3>操作链（持久化，刷新不丢）</h3></div>
          <div className="logList">
            {state.log.map(l => (
              <div key={l.id} className={`log kind-${l.kind}`}>
                <span className="lt">{fmtTime(l.t)}</span>
                <span className="la">{l.actor}</span>
                <span className="lk">{l.kind}</span>
                <span className="lx">{l.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'demo' && (
        <section className="panel grow">
          <div className="panelHead"><h3>场景演练</h3></div>
          <p className="hint">一键走通「录入 → 配载 → 复核 → 处置 → 确认」全流程，或单独注入某类违规核对规则引擎。</p>
          <button className="primary wide" onClick={api.runDemo} disabled={api.demoRunning}>
            {api.demoRunning ? '演示进行中…' : '▶ 一键演示全流程'}
          </button>
          {api.demoRunning && <button className="ghost wide" onClick={api.stopDemo}>停止演示</button>}
          <div className="scnGrid">
            <button onClick={() => api.runScenario('seg')}>☣ 隔离违规<small>3类↔5.1类同倍位</small></button>
            <button onClick={() => api.runScenario('list')}>⚖ 偏心超限<small>重箱集中左舷</small></button>
            <button onClick={() => api.runScenario('reefer')}>❄ 供电争抢<small>冷藏挤入Bay01</small></button>
            <button onClick={() => api.runScenario('port')}>⚓ 靠港颠倒<small>晚卸压早卸</small></button>
            <button onClick={() => api.runScenario('stack')}>▤ 叠放违规<small>重箱压轻箱</small></button>
            <button onClick={() => {
              const t = Object.values(state.containers).find(c => !c.locked);
              if (t) api.simulatePeerEdit(t.id);
            }}>⇄ 并发改箱<small>模拟对方旧版本提交</small></button>
          </div>
          <div className="hintBox">
            <b>双端协同核对</b>
            <p>再开一个浏览器标签页（即第二名配载员），两端可同时改箱：版本一致自动合并；同时改同一箱时两份修改都会保留并弹出人工裁定，绝不静默覆盖。</p>
          </div>
          <div className="hintBox">
            <b>靠港顺序</b>
            <p>{portName('SIN')} → {portName('CMB')} → {portName('JEA')} → {portName('RTM')} → {portName('HAM')}（堆内须晚卸在下、早卸在上）</p>
          </div>
        </section>
      )}
    </div>
  );
}
