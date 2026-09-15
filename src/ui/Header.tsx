// 顶栏：船况总览 + 配载员身份 + 确认方案
import { BAYS, REEFER_CAP, LIST_LIMIT, fmtTime } from '../types';
import { balance, placed, reeferUsage } from '../rules';
import { useStore } from '../store';

export function Header() {
  const { state, api } = useStore();
  const all = Object.values(state.containers);
  const onBoard = placed(state.containers).length;
  const pool = all.length - onBoard;
  const { left, right, moment } = balance(state.containers);
  const usage = reeferUsage(state.containers);
  const reeferUsed = Object.values(usage).reduce((a, b) => a + b, 0);
  const reeferCap = BAYS.reduce((s, b) => s + REEFER_CAP[b], 0);
  const listOver = Math.abs(moment) > LIST_LIMIT;
  const nConflict = api.conflicts.length;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">⚓</div>
        <div>
          <h1>危险品集装箱配载台</h1>
          <small>MV 远洋轮 · 上海港装船 · 航次 26E</small>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><small>在船 / 待配</small><b>{onBoard} <em>/ {pool}</em></b></div>
        <div className="stat"><small>左右舷重量</small><b>{left.toFixed(0)}t <em>⚖</em> {right.toFixed(0)}t</b></div>
        <div className={`stat ${listOver ? 'bad' : ''}`}><small>偏心矩(限±{LIST_LIMIT})</small><b>{moment > 0 ? '+' : ''}{moment.toFixed(1)}</b></div>
        <div className={`stat ${reeferUsed > reeferCap ? 'bad' : ''}`}><small>冷藏插座</small><b>{reeferUsed}<em>/{reeferCap}</em></b></div>
        <div className={`stat ${nConflict ? 'bad pulse' : 'ok'}`}><small>未解除冲突</small><b>{nConflict || '✔'}</b></div>
        {state.resolutions.length > 0 && (
          <div className="stat bad pulse"><small>待人工裁定</small><b>{state.resolutions.length}</b></div>
        )}
      </div>

      <div className="topActions">
        <div className="who">
          <label>配载员</label>
          <select value={api.actor} onChange={e => api.setActor(e.target.value)}>
            <option>王工</option>
            <option>李工</option>
          </select>
          <div className="peers" title="在线配载员（开第二个标签页即可双端协同）">
            <span className="dot" />{api.actor}
            {api.peers.map(p => <span key={p.src} className="peer"><span className="dot" />{p.actor}</span>)}
          </div>
        </div>
        {state.confirmed
          ? <div className="confirmedSeal" title={`${state.confirmed.by} 于 ${fmtTime(state.confirmed.at)} 确认`}>✔ 方案已确认<small>{state.confirmed.by} · {fmtTime(state.confirmed.at)}</small></div>
          : (
            <button
              className="primary confirmBtn"
              disabled={!api.canConfirm.ok}
              title={api.canConfirm.ok ? '复核零冲突，可确认方案' : api.canConfirm.reasons.join('；')}
              onClick={api.doConfirm}
            >确认方案</button>
          )}
        <button className="ghost" onClick={() => { if (confirm('重置为初始示范船图？当前方案与操作链将被覆盖。')) api.doReset(); }}>重置</button>
      </div>
    </header>
  );
}
