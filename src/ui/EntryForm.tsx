// 左栏：集装箱录入 / 编辑表单
import { useEffect, useState } from 'react';
import { DG_META, PORTS } from '../types';
import type { ContainerT, DGClass } from '../types';
import { isoCheckDigit, isoValid, mkBoxId } from '../rules';
import { useStore } from '../store';

const DG_KEYS = Object.keys(DG_META) as DGClass[];

export function EntryForm({ editing, onDone }: { editing: ContainerT | null; onDone: () => void }) {
  const { api } = useStore();
  const [id, setId] = useState('');
  const [weight, setWeight] = useState('20');
  const [dg, setDg] = useState<DGClass>('NONE');
  const [reefer, setReefer] = useState(false);
  const [port, setPort] = useState(PORTS[0].code);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      setId(editing.id);
      setWeight(String(editing.weight));
      setDg(editing.dg);
      setReefer(editing.reefer);
      setPort(editing.port);
      setErr(null);
    }
  }, [editing]);

  const idUp = id.toUpperCase().trim();
  const idOk = /^[A-Z]{4}\d{7}$/.test(idUp) && isoValid(idUp);
  const idHint = idUp.length === 11 && !idOk ? '校验位不符（ISO 6346）' : null;

  const submit = () => {
    const w = parseFloat(weight);
    if (!(w > 0 && w <= 40)) { setErr('重量需在 0–40 吨之间'); return; }
    if (editing) {
      api.editBox(editing.id, { weight: w, dg, reefer, port });
      onDone();
      return;
    }
    const e = api.addBox({ id: idUp, weight: w, dg, reefer, port });
    if (e) { setErr(e); return; }
    setId(''); setErr(null);
  };

  const genId = () => {
    const owners = ['TCLU', 'MSKU', 'CSNU', 'HLCU', 'ONEU', 'CMAU'];
    setId(mkBoxId(owners[Math.floor(Math.random() * owners.length)], Math.floor(Math.random() * 899999) + 100000));
    setErr(null);
  };

  return (
    <section className="panel">
      <h3>{editing ? `编辑 ${editing.id}` : '录入集装箱'}</h3>
      <div className="form">
        <label className="fld">
          <span>箱号（ISO 6346）</span>
          <div className="idRow">
            <input
              value={id}
              disabled={!!editing}
              onChange={e => setId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
              placeholder="TCLU1234567"
              className={idUp.length === 11 ? (idOk ? 'ok' : 'bad') : ''}
            />
            {!editing && <button type="button" className="mini" onClick={genId} title="生成合规箱号">生成</button>}
          </div>
          {idUp.length === 11 && (
            <em className={idOk ? 'hintOk' : 'hintBad'}>
              {idOk ? '✔ 校验位正确' : `${idHint}，正确校验位应为 ${isoCheckDigit(idUp.slice(0, 10))}`}
            </em>
          )}
        </label>
        <div className="fldRow">
          <label className="fld">
            <span>重量（t）</span>
            <input type="number" min="1" max="40" step="0.5" value={weight} onChange={e => setWeight(e.target.value)} />
          </label>
          <label className="fld">
            <span>卸货港（按靠港序）</span>
            <select value={port} onChange={e => setPort(e.target.value)}>
              {PORTS.map((p, i) => <option key={p.code} value={p.code}>第{i + 1}港 · {p.name}</option>)}
            </select>
          </label>
        </div>
        <label className="fld">
          <span>危险类别（IMDG）</span>
          <select value={dg} onChange={e => setDg(e.target.value as DGClass)}>
            {DG_KEYS.map(k => <option key={k} value={k}>{DG_META[k].label}</option>)}
          </select>
        </label>
        <label className="chk">
          <input type="checkbox" checked={reefer} onChange={e => setReefer(e.target.checked)} />
          <span>冷藏箱（占用冷藏插座）</span>
        </label>
        {err && <div className="err">{err}</div>}
        <div className="formBtns">
          <button className="primary" onClick={submit} disabled={!editing && !idOk}>
            {editing ? '保存修改' : '录入 → 待配池'}
          </button>
          {editing && <button className="ghost" onClick={onDone}>取消</button>}
        </div>
      </div>
    </section>
  );
}
