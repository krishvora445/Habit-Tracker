import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

/* ===== backend ===== */
const API_BASE = import.meta.env.VITE_API_BASE || "https://habit-tracker-backend-sigma.vercel.app";

const STUDY_BLOCKS = [
  { key: "Study Block 1", hours: 3.5, window: "3:00–6:30 PM" },
  { key: "Study Block 2", hours: 2.5, window: "7:00–9:30 PM" },
  { key: "Study Block 3", hours: 0.5, window: "10:30–11:00 PM" },
];
const STUDY_TOTAL = STUDY_BLOCKS.reduce((s, b) => s + b.hours, 0);
const OTHER_HABITS = [
  "Drink 2L water ", "Eat healthy meals", "Exercise 1 hours", "Journal & self-reflect ",
  "No porn/alcohol", "Plan tomorrow's tasks", "Read 30 minutes", "Sleep 7 hours",
  "Social media ≤ 20min",
];
const ALL_HABITS = [...OTHER_HABITS, ...STUDY_BLOCKS.map(b => b.key)];
const SHORT = {
  "Drink 2L water ": "Water 2L", "Eat healthy meals": "Eat well", "Exercise 1 hours": "Exercise 1h",
  "Journal & self-reflect ": "Journal", "No porn/alcohol": "Stay clean", "Plan tomorrow's tasks": "Plan tmrw",
  "Read 30 minutes": "Read 30m", "Sleep 7 hours": "Sleep 7h", "Social media ≤ 20min": "Social ≤20m",
};
const CONFIG = { WEEKEND_TARGET_CAP: 12, TOTAL_DEBT_CEILING: 20, GRACE_HOURS: 12, SESSION_CAP_H: 6 };
const INTRO_WORDS = ["CONFIDENCE", "EVIDENCE", "SKILL", "DISCIPLINE", "ACCOUNTABILITY", "ENVIRONMENT"];

const iso = d => { const x=new Date(d); x.setHours(0,0,0,0); const o=x.getTimezoneOffset(); return new Date(x.getTime()-o*60000).toISOString().slice(0,10); };
const parseISO = s => { const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); };
const isDebtDay = d => { const w=d.getDay(); return w>=1&&w<=5; };
const isWeekend = d => { const w=d.getDay(); return w===0||w===6; };
const weekStart = d => { const x=new Date(d); const s=(x.getDay()+6)%7; x.setDate(x.getDate()-s); x.setHours(0,0,0,0); return x; };
const weekKey = d => iso(weekStart(d));
const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const freezeTime = dd => { const f=new Date(dd); f.setDate(f.getDate()+1); f.setHours(CONFIG.GRACE_HOURS,0,0,0); return f; };
const isPastFreeze = (dd, now=new Date()) => now >= freezeTime(dd);
const fmtH = h => (Number.isInteger(h)? h : h.toFixed(1)) + "h";

const LS = "discipline-ledger-v3";
const loadState = () => { try { const r=localStorage.getItem(LS); if(r) return JSON.parse(r); } catch(e){} return null; };
function emptyState(){ return { days:{}, makeup:{}, signal:[], monthlyTasks:[], winPct:75 }; }

function missedForDay(dayISO,habits){ const d=parseISO(dayISO); if(!isDebtDay(d))return 0;
  return STUDY_BLOCKS.reduce((s,b)=>s+(habits[b.key]?0:b.hours),0); }
function weekSummary(state,ref){
  const start=weekStart(ref); const days=[];
  for(let i=0;i<5;i++){ const d=addDays(start,i); const k=iso(d); const e=state.days[k]; let missed=null;
    if(e){ if(e.frozen||isPastFreeze(d)) missed=missedForDay(k,e.habits); }
    else if(isPastFreeze(d)) missed=STUDY_BLOCKS.reduce((s,b)=>s+b.hours,0);
    days.push({date:k,missed}); }
  const raw=days.reduce((s,x)=>s+(x.missed||0),0);
  const debt=Math.min(raw,CONFIG.TOTAL_DEBT_CEILING);
  const wk=weekKey(ref); const madeUp=(state.makeup[wk]||[]).reduce((s,m)=>s+m.hours,0);
  const remaining=Math.max(0,debt-madeUp);
  return { days,raw,debt,madeUp,remaining,
    weekendTarget:Math.min(remaining,CONFIG.WEEKEND_TARGET_CAP),
    cleared:remaining===0&&debt>0, pending:days.filter(x=>x.missed===null).map(x=>x.date) };
}
const dayPct = habits => Math.round(ALL_HABITS.filter(h=>habits[h]).length/ALL_HABITS.length*100);
const habitPct = habits => Math.round(OTHER_HABITS.filter(h=>habits[h]).length/OTHER_HABITS.length*100);
const studyPct = habits => Math.round(STUDY_BLOCKS.filter(b=>habits[b.key]).length/STUDY_BLOCKS.length*100);

/* ===== API ===== */
async function apiPull(){
  const r=await fetch(`${API_BASE}/api/pull`,{headers:{"Accept":"application/json"}});
  if(!r.ok) throw new Error("pull failed "+r.status);
  const j=await r.json(); if(j.error) throw new Error(j.error);
  return j;
}
async function apiPush(changes){
  const r=await fetch(`${API_BASE}/api/push`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({changes})});
  if(!r.ok) throw new Error("push failed "+r.status);
  return r.json();
}
// push a single change and return its per-change result {ok,pageId,error}
async function apiPushOne(change){
  const j=await apiPush([change]);
  const res=j.results&&j.results[0];
  if(!res||!res.ok) throw new Error((res&&res.error)||"push failed");
  return res;
}
// merge pull payload -> local state shape
function mergePull(prev,pull){
  const days={...prev.days}; const pageIds={...(prev._pageIds||{})};
  (pull.entries||[]).forEach(e=>{ if(!e.date) return;
    days[e.date]={date:e.date,notes:e.notes||"",habits:{...Object.fromEntries(ALL_HABITS.map(h=>[h,false])),...e.habits},
      frozen: e.missedStudyHours!=null || isPastFreeze(parseISO(e.date))};
    pageIds[e.date]=e.pageId; });
  const signal=(pull.signal||[]).map(s=>({id:s.pageId,text:s.text||"",done:s.done,pageId:s.pageId}));
  const monthlyTasks=(pull.monthlyTasks||[]).map(t=>({id:t.pageId,text:t.text||"",done:t.done,pageId:t.pageId}));
  return {...prev,days,signal,monthlyTasks,_pageIds:pageIds};
}

/* ===== intro (morphing text) ===== */
function Intro({ onDone }){
  const [wi,setWi]=useState(0); const [fading,setFading]=useState(false); const timers=useRef([]);
  useEffect(()=>{
    const base=1050, ratio=0.8; const hold=i=>Math.max(360,Math.round(base*Math.pow(ratio,i)));
    let i=wi; const t=setTimeout(()=>{
      if(i>=INTRO_WORDS.length-1){ setFading(true); const t2=setTimeout(onDone,1000); timers.current.push(t2); }
      else setWi(i+1);
    },hold(i)); timers.current.push(t);
    return ()=>{ timers.current.forEach(clearTimeout); timers.current=[]; };
  },[wi,onDone]);
  const prev=wi>0?INTRO_WORDS[wi-1]:"";
  return (
    <div onClick={onDone} style={{position:"fixed",inset:0,background:"var(--bg)",display:"grid",placeItems:"center",zIndex:50,cursor:"pointer",opacity:fading?0:1,transition:"opacity 1.1s ease",pointerEvents:fading?"none":"auto"}}>
      <svg style={{position:"absolute",width:0,height:0}} aria-hidden="true"><defs><filter id="morph-goo"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 42 -14"/></filter></defs></svg>
      <div style={{textAlign:"center"}}>
        <div style={{position:"relative",filter:"url(#morph-goo)",minHeight:"1.2em",display:"grid",placeItems:"center"}}>
          <span key={"out"+wi} className="morphword out" style={MORPH_STYLE}>{prev}</span>
          <span key={"in"+wi} className="morphword in" style={MORPH_STYLE}>{INTRO_WORDS[wi]}</span>
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:11,letterSpacing:4,textTransform:"uppercase",color:"var(--muted-fg)",marginTop:24}}>tap to skip</div>
      </div>
    </div>
  );
}
const MORPH_STYLE = { gridArea:"1/1", fontFamily:"var(--mono)", fontSize:"clamp(26px,6vw,58px)", fontWeight:700, letterSpacing:"0.18em", color:"var(--fg)", textTransform:"uppercase" };

/* ===== reveal wrapper (blur-in, staggered) ===== */
function Reveal({children,delay=0,show}){
  const [on,setOn]=useState(false);
  useEffect(()=>{ if(!show)return; const t=setTimeout(()=>setOn(true),delay); return ()=>clearTimeout(t); },[show,delay]);
  return <div style={{opacity:on?1:0,filter:on?"blur(0px)":"blur(12px)",transform:on?"translateY(0)":"translateY(8px)",transition:"opacity .5s ease, filter .5s ease, transform .5s ease"}}>{children}</div>;
}

/* ===== root ===== */
export default function HabitTracker(){
  const [state,setState]=useState(()=> loadState() || emptyState());
  const [intro,setIntro]=useState(true);
  const [revealed,setRevealed]=useState(false);
  const [tab,setTab]=useState("today");
  const [viewDate,setViewDate]=useState(()=>iso(new Date()));
  const [dark,setDark]=useState(true);
  const [sync,setSync]=useState({loading:true,error:null,pushing:false,lastPull:null});
  const [dirty,setDirty]=useState({}); // date -> true (habit/notes changed locally)
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false));
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(()=>{ try{localStorage.setItem(LS,JSON.stringify(state));}catch(e){} },[state]);

  // auto-pull on mount
  const doPull=useCallback(async()=>{
    setSync(s=>({...s,loading:true,error:null}));
    try{ const p=await apiPull(); setState(prev=>mergePull(prev,p)); setSync(s=>({...s,loading:false,lastPull:new Date().toISOString()})); setDirty({}); }
    catch(e){ setSync(s=>({...s,loading:false,error:e.message})); }
  },[]);
  useEffect(()=>{ doPull(); },[doPull]);

  // lazy freeze
  useEffect(()=>{ setState(s=>{ const days={...s.days}; let ch=false;
    Object.keys(days).forEach(k=>{ const d=parseISO(k); if(!days[k].frozen&&isDebtDay(d)&&isPastFreeze(d)){ days[k]={...days[k],frozen:true}; ch=true; } });
    return ch?{...s,days}:s; }); },[sync.lastPull]);

  const today=iso(new Date());
  const cur=state.days[viewDate]||{date:viewDate,notes:"",habits:Object.fromEntries(ALL_HABITS.map(h=>[h,false])),frozen:false};
  const winPct=state.winPct??75;
  const setHabit=(h,v)=>{ setState(s=>{ const e=s.days[viewDate]||{date:viewDate,notes:"",habits:Object.fromEntries(ALL_HABITS.map(x=>[x,false])),frozen:false};
    return {...s,days:{...s.days,[viewDate]:{...e,habits:{...e.habits,[h]:v}}}}; }); setDirty(d=>({...d,[viewDate]:true})); };
  const summary=useMemo(()=>weekSummary(state,parseISO(viewDate)),[state,viewDate]);

  const dirtyDates=Object.keys(dirty).filter(k=>dirty[k]);
  const doPush=async()=>{
    if(!dirtyDates.length) return;
    setSync(s=>({...s,pushing:true,error:null}));
    try{
      const changes=dirtyDates.map(date=>{ const e=state.days[date]; const pageId=(state._pageIds||{})[date];
        const fields={}; ALL_HABITS.forEach(h=>{ fields[h]=!!e.habits[h]; }); if(e.notes) fields["Notes"]=e.notes;
        return pageId?{db:"habits",pageId,fields}:{db:"habits",create:true,fields:{...fields,Date:date}}; });
      await apiPush(changes); setDirty({}); await doPull();
      setSync(s=>({...s,pushing:false}));
    }catch(e){ setSync(s=>({...s,pushing:false,error:e.message})); }
  };

  /* ---- Signal Space + Monthly Tasks: persist to Notion immediately ---- */
  // Each mutation optimistically updates local state, then writes to Notion in
  // the background. Creates reconcile the temp id with the real Notion pageId so
  // subsequent toggles/deletes target the right row — the data now survives reload.
  const listApi = useMemo(()=>{
    const titleProp = { signal:"Priority", monthlyTasks:"Task" };
    const flag = err => setSync(s=>({...s,error:err}));

    const add = key => async text => {
      text = text.trim(); if(!text) return;
      const tempId = "tmp-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
      setState(s=>({...s,[key]:[...s[key],{id:tempId,text,done:false,pageId:null,saving:true}]}));
      try{
        const res = await apiPushOne({db:key,create:true,fields:{[titleProp[key]]:text,Done:false}});
        setState(s=>({...s,[key]:s[key].map(x=>x.id===tempId?{...x,id:res.pageId,pageId:res.pageId,saving:false}:x)}));
      }catch(e){
        setState(s=>({...s,[key]:s[key].map(x=>x.id===tempId?{...x,saving:false,error:true}:x)}));
        flag(e.message);
      }
    };
    const update = key => async (item,patch) => {
      setState(s=>({...s,[key]:s[key].map(x=>x.id===item.id?{...x,...patch}:x)}));
      if(!item.pageId) return; // still creating; the create already carries current text/done
      try{
        const fields={};
        if(patch.text!=null) fields[titleProp[key]]=patch.text.trim();
        if(patch.done!=null) fields.Done=patch.done;
        if(Object.keys(fields).length) await apiPushOne({db:key,pageId:item.pageId,fields});
      }catch(e){ flag(e.message); }
    };
    const remove = key => async item => {
      setState(s=>({...s,[key]:s[key].filter(x=>x.id!==item.id)}));
      if(!item.pageId) return; // never persisted, nothing to archive
      try{ await apiPushOne({db:key,pageId:item.pageId,archive:true}); }
      catch(e){ flag(e.message); }
    };
    const forKey = key => ({ add:add(key), update:update(key), remove:remove(key) });
    return { signal:forKey("signal"), tasks:forKey("monthlyTasks") };
  },[]);

  return (
    <div className="dl" data-theme={dark?"dark":"light"} style={THEME}>
      <style>{CSS}</style>
      {intro && <Intro onDone={()=>{setIntro(false);setTimeout(()=>setRevealed(true),60);}}/>}
      <div style={{minHeight:"100vh",background:"var(--bg)",color:"var(--fg)",fontFamily:"var(--sans)",fontSize:14,lineHeight:1.45}}>

        <Reveal show={revealed} delay={0}>
          <header className="hdr">
            <div className="hdr-title">
              <span className="eyebrow">Personal Ledger</span>
              <h1>The Discipline Ledger</h1>
            </div>
            <div className="hdr-actions">
              <button className="btn ghost" onClick={doPull} disabled={sync.loading} title="Pull from Notion">
                <span style={{fontSize:13}}>↓</span> {sync.loading?"Syncing":"Pull"}
              </button>
              <button className="btn primary" onClick={doPush} disabled={sync.pushing||dirtyDates.length===0} title="Push changes to Notion">
                <span style={{fontSize:13}}>↑</span> {sync.pushing?"Pushing":"Push"}
                {dirtyDates.length>0 && <span className="count">{dirtyDates.length}</span>}
              </button>
              <button className="icon-btn" onClick={()=>setDark(d=>!d)} title="Toggle theme">{dark?"☾":"☀"}</button>
              <button className="icon-btn" onClick={toggleFullscreen} title="Toggle fullscreen">
                {isFullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 15 15" fill="none"><path d="M1.5 5.5H5.5V1.5M13.5 5.5H9.5V1.5M1.5 9.5H5.5V13.5M13.5 9.5H9.5V13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 15 15" fill="none"><path d="M5.5 1.5H1.5V5.5M9.5 1.5H13.5V5.5M5.5 13.5H1.5V9.5M9.5 13.5H13.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            </div>
            <nav className="tabs">
              {[["today","Today"],["week","Reckoning"],["month","Record"],["settings","Settings"]].map(([id,l])=>(
                <button key={id} onClick={()=>setTab(id)} className={"tab"+(tab===id?" on":"")}>{l}</button>
              ))}
            </nav>
          </header>
        </Reveal>

        <main className="main">
          {sync.error && <Reveal show={revealed} delay={120}><div className="note" style={{marginBottom:16}}>⚠ {sync.error} — <button className="linkbtn" onClick={doPull}>retry</button></div></Reveal>}

          {tab==="today" && <Today cur={cur} setHabit={setHabit} viewDate={viewDate} setViewDate={setViewDate} today={today} summary={summary} state={state} listApi={listApi} winPct={winPct} loading={sync.loading} revealed={revealed}/>}
          {tab==="week" && <Reveal show={revealed} delay={120}><Week summary={summary} state={state} setState={setState} viewDate={viewDate} setViewDate={setViewDate}/></Reveal>}
          {tab==="month" && <Reveal show={revealed} delay={120}><Month state={state} viewDate={viewDate} setViewDate={setViewDate} setTab={setTab} winPct={winPct}/></Reveal>}
          {tab==="settings" && <Reveal show={revealed} delay={120}><Settings state={state} setState={setState} winPct={winPct} sync={sync} onPull={doPull}/></Reveal>}
        </main>
      </div>
    </div>
  );
}

/* ===== skeleton ===== */
function Skel({h=16,w="100%",r=8,style}){ return <div className="skel" style={{height:h,width:w,borderRadius:r,...style}}/>; }
function CardSkeleton(){
  return (
    <div className="card">
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}><Skel w={140} h={20}/><Skel w={50} h={28}/></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>{[0,1,2].map(i=><Skel key={i} h={82} r={12}/>)}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:10,justifyContent:"center"}}>{Array.from({length:9}).map((_,i)=><Skel key={i} h={40} w={120} r={11}/>)}</div>
    </div>
  );
}

/* ===== TODAY ===== */
function Today({cur,setHabit,viewDate,setViewDate,today,summary,state,listApi,winPct,loading,revealed}){
  const d=parseISO(viewDate);
  const pct=dayPct(cur.habits); const isWin=pct>winPct;
  const studyDone=STUDY_BLOCKS.reduce((s,b)=>s+(cur.habits[b.key]?b.hours:0),0);
  const studyMissed=STUDY_BLOCKS.reduce((s,b)=>s+(cur.habits[b.key]?0:b.hours),0);
  const frozen=cur.frozen||isPastFreeze(d);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:18}}>
      <Reveal show={revealed} delay={120}>
        <div className="lists-grid">
          <SignalSpace items={state.signal} api={listApi.signal}/>
          <MonthTasks items={state.monthlyTasks} api={listApi.tasks}/>
        </div>
      </Reveal>

      <Reveal show={revealed} delay={200}>
        {loading ? <CardSkeleton/> : (
        <section className="card">
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
            <DateNav viewDate={viewDate} setViewDate={setViewDate} today={today}/>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:30,fontWeight:800,letterSpacing:"-.02em",lineHeight:1}}>{pct}<span style={{fontSize:15,color:"var(--muted-fg)",fontWeight:600}}>%</span></div>
              <div className="eyebrow" style={{marginTop:5}}>{isWin?"◆ win day":"of the day"}</div>
            </div>
          </div>

          <div className="study">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <span className="eyebrow">Study Ledger · {isDebtDay(d)?"weekday":"free day"}</span>
              <span style={{fontSize:12.5,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>{fmtH(studyDone)} / {fmtH(STUDY_TOTAL)}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
              {STUDY_BLOCKS.map(b=>{ const on=cur.habits[b.key];
                return (
                  <button key={b.key} onClick={()=>setHabit(b.key,!on)} className={"block"+(on?" on":"")}>
                    <div style={{fontSize:19,fontWeight:700,fontVariantNumeric:"tabular-nums"}}>{fmtH(b.hours)}</div>
                    <div className="block-sub" style={{fontSize:12,marginTop:4}}>{b.window}</div>
                    <div className="block-note" style={{fontSize:11,letterSpacing:".06em",marginTop:8,fontWeight:600}}>{on?"✓ LOGGED":"tap to log"}</div>
                  </button>
                ); })}
            </div>
            {isDebtDay(d)&&studyMissed>0 &&
              <div style={{marginTop:14,fontSize:12,display:"flex",justifyContent:"space-between",color:"var(--muted-fg)"}}>
                <span>{frozen?"frozen · owed this week":"if unlogged by noon tomorrow"}</span>
                <span style={{fontWeight:600,color:"var(--fg)",fontVariantNumeric:"tabular-nums"}}>+{fmtH(studyMissed)}</span>
              </div>}
          </div>

          <div style={{marginTop:22}}>
            <div className="eyebrow" style={{textAlign:"center",marginBottom:14}}>Daily Habits</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:10,justifyContent:"center"}}>
              {OTHER_HABITS.map(h=>{ const on=cur.habits[h];
                return (
                  <button key={h} onClick={()=>setHabit(h,!on)} className={"habit"+(on?" on":"")}>
                    <span className={"dot"+(on?" on":"")}>{on?"✓":""}</span>
                    <span>{SHORT[h]}</span>
                  </button>
                ); })}
            </div>
          </div>

          <WeekStrip summary={summary} viewDate={viewDate} setViewDate={setViewDate}/>
        </section>)}
      </Reveal>

      <Reveal show={revealed} delay={280}>
        {loading ? <div className="card"><Skel w={140} h={18} style={{marginBottom:16}}/><Skel h={230} r={12}/></div> : <TrendChart state={state} anchor={viewDate} winPct={winPct}/>}
      </Reveal>
    </div>
  );
}

/* ===== Signal Space (3 independent slots, synced to Notion) ===== */
function SignalSpace({items,api}){
  return (
    <section className="card pad">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span className="eyebrow">Signal Space</span>
        <span style={{fontSize:12,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>{items.length}/3</span>
      </div>
      <p className="card-sub">Your top 3 priorities right now.</p>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[0,1,2].map(i=>{ const it=items[i];
          return (
            <div key={it?it.id:"empty-"+i} className="signal-row">
              <span className="signal-n">{i+1}</span>
              {it ? (
                <>
                  <button className={"dot sm"+(it.done?" on":"")} onClick={()=>api.update(it,{done:!it.done})} title="toggle done">{it.done?"✓":""}</button>
                  <span style={{flex:1,fontSize:13.5,textDecoration:it.done?"line-through":"none",color:it.done?"var(--muted-fg)":"var(--fg)",opacity:it.saving?.55:1}}>{it.text}</span>
                  {it.error && <span title="not saved" style={{color:"var(--destructive)",fontSize:12}}>!</span>}
                  <button className="x" onClick={()=>api.remove(it)}>×</button>
                </>
              ) : (
                <SignalInput onAdd={api.add}/>
              )}
            </div>
          ); })}
      </div>
    </section>
  );
}
// Own draft state per empty slot → typing in one box never leaks into another.
function SignalInput({onAdd}){
  const [v,setV]=useState("");
  const commit=()=>{ if(v.trim()){ onAdd(v.trim()); setV(""); } };
  return (
    <input value={v} onChange={e=>setV(e.target.value)} onKeyDown={e=>e.key==="Enter"&&commit()} onBlur={commit}
      placeholder="Add priority…" className="inp" style={{flex:1}}/>
  );
}

/* ===== This Month (monthly tasks, synced to Notion) ===== */
function MonthTasks({items,api}){
  const [txt,setTxt]=useState("");
  const add=()=>{ if(txt.trim()){ api.add(txt.trim()); setTxt(""); } };
  const done=items.filter(x=>x.done).length;
  return (
    <section className="card pad">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span className="eyebrow">This Month</span>
        <span style={{fontSize:12,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>{done}/{items.length}</span>
      </div>
      <p className="card-sub">Tasks to finish this month.</p>
      <div style={{display:"flex",gap:10}}>
        <input value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Add task…" className="inp" style={{flex:1}}/>
        <button className="add-btn" onClick={add}>+</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:14,maxHeight:200,overflowY:"auto"}}>
        {items.map(it=>(
          <div key={it.id} className="task-row" style={{opacity:it.saving?.6:1}}>
            <button className={"dot sm"+(it.done?" on":"")} onClick={()=>api.update(it,{done:!it.done})}>{it.done?"✓":""}</button>
            <span style={{flex:1,fontSize:13.5,textDecoration:it.done?"line-through":"none",color:it.done?"var(--muted-fg)":"var(--fg)"}}>{it.text}</span>
            {it.error && <span title="not saved" style={{color:"var(--destructive)",fontSize:12}}>!</span>}
            <button className="x" onClick={()=>api.remove(it)}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ===== recharts area chart ===== */
function TrendChart({state,anchor,winPct}){
  const [range,setRange]=useState(30);
  const data=useMemo(()=>{ const arr=[]; const end=parseISO(anchor);
    for(let i=range-1;i>=0;i--){ const d=addDays(end,-i); const k=iso(d); const e=state.days[k];
      arr.push({date:k, habits:e?habitPct(e.habits):0, study:e?studyPct(e.habits):0, has:!!e}); }
    return arr; },[state,anchor,range]);
  const logged=data.filter(p=>p.has);
  const avg=logged.length?Math.round(logged.reduce((a,b)=>a+(b.habits+b.study)/2,0)/logged.length):0;
  const strokeStudy="var(--fg)", strokeHabit="var(--muted-fg)";
  return (
    <section className="card">
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
        <div><div className="eyebrow">Consistency Trend</div><div style={{fontSize:13,color:"var(--muted-fg)",marginTop:6}}>Habits vs study, last {range} days</div></div>
        <div className="seg">
          {[7,30,90].map(r=><button key={r} className={"seg-btn"+(range===r?" on":"")} onClick={()=>setRange(r)}>{r}d</button>)}
        </div>
      </div>
      <div style={{display:"flex",gap:20,marginTop:14,fontSize:12,color:"var(--muted-fg)"}}>
        <span style={{display:"inline-flex",alignItems:"center",gap:7}}><span style={{width:14,height:3,borderRadius:2,background:strokeStudy}}/>Study</span>
        <span style={{display:"inline-flex",alignItems:"center",gap:7}}><span style={{width:14,height:3,borderRadius:2,background:strokeHabit}}/>Habits</span>
        <span style={{marginLeft:"auto"}}>avg <b style={{color:"var(--fg)"}}>{avg}%</b></span>
      </div>
      <div style={{width:"100%",height:250,marginTop:8}}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{top:10,right:8,left:-18,bottom:0}}>
            <defs>
              <linearGradient id="fillStudy" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={strokeStudy} stopOpacity={0.28}/><stop offset="100%" stopColor={strokeStudy} stopOpacity={0}/></linearGradient>
              <linearGradient id="fillHabits" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={strokeHabit} stopOpacity={0.18}/><stop offset="100%" stopColor={strokeHabit} stopOpacity={0}/></linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border-soft)"/>
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28}
              tick={{fill:"var(--muted-fg)",fontFamily:"var(--mono)",fontSize:10}}
              tickFormatter={v=>parseISO(v).toLocaleDateString("en-US",{month:"short",day:"numeric"})}/>
            <YAxis domain={[0,100]} tickLine={false} axisLine={false} width={34}
              tick={{fill:"var(--muted-fg)",fontFamily:"var(--mono)",fontSize:10}}/>
            <Tooltip contentStyle={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,fontFamily:"var(--mono)",fontSize:12,color:"var(--fg)"}}
              labelFormatter={v=>parseISO(v).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}
              formatter={(val,name)=>[val+"%", name==="habits"?"Habits":"Study"]}/>
            <Area dataKey="habits" type="natural" stroke={strokeHabit} strokeWidth={2} fill="url(#fillHabits)"/>
            <Area dataKey="study" type="natural" stroke={strokeStudy} strokeWidth={2.4} fill="url(#fillStudy)"/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function WeekStrip({summary,viewDate,setViewDate}){
  return (
    <div style={{marginTop:24}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <span className="eyebrow">This Week</span>
        <span style={{fontSize:12,color:"var(--muted-fg)"}}>{summary.remaining>0?fmtH(summary.remaining)+" owed":summary.debt>0?"cleared ◆":"no debt"}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10}}>
        {Array.from({length:7}).map((_,i)=>{ const d=addDays(weekStart(parseISO(viewDate)),i); const k=iso(d);
          const row=summary.days.find(x=>x.date===k); const wknd=isWeekend(d); const sel=k===viewDate;
          let label=""; if(wknd)label="pay"; else if(row)label=row.missed===null?"·":row.missed===0?"✓":"+"+row.missed;
          return (<button key={k} onClick={()=>setViewDate(k)} className={"day"+(sel?" sel":"")}>
            <div style={{fontSize:10,letterSpacing:".1em",color:"var(--muted-fg)",fontWeight:600}}>{d.toLocaleDateString(undefined,{weekday:"short"})[0]}</div>
            <div style={{fontSize:16,fontWeight:700,marginTop:5,fontVariantNumeric:"tabular-nums"}}>{d.getDate()}</div>
            <div style={{fontSize:11,marginTop:4,color:"var(--muted-fg)",minHeight:13}}>{label}</div>
          </button>); })}
      </div>
    </div>
  );
}

/* ===== WEEK ===== */
function Week({summary,state,setState,viewDate,setViewDate}){
  const wk=weekKey(parseISO(viewDate)); const sessions=state.makeup[wk]||[];
  const [manual,setManual]=useState(""); const [running,setRunning]=useState(null); const [now,setNow]=useState(Date.now()); const t=useRef();
  useEffect(()=>{ if(running){ t.current=setInterval(()=>setNow(Date.now()),200); return ()=>clearInterval(t.current);} },[running]);
  const addSession=(hours,source)=>{ hours=Math.min(hours,CONFIG.SESSION_CAP_H); if(hours<=0)return;
    setState(s=>({...s,makeup:{...s.makeup,[wk]:[...(s.makeup[wk]||[]),{id:Date.now(),hours:Math.round(hours*100)/100,source,at:new Date().toISOString()}]}})); };
  const rm=id=>setState(s=>({...s,makeup:{...s.makeup,[wk]:(s.makeup[wk]||[]).filter(x=>x.id!==id)}}));
  const elapsed=running?(now-running)/3600000:0;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:18}}>
      <section className="card">
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
          <h2 className="h2">The Reckoning</h2>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button className="icon-btn sm" onClick={()=>setViewDate(iso(addDays(parseISO(viewDate),-7)))}>‹</button>
            <button className="chip" onClick={()=>setViewDate(iso(new Date()))}>this week</button>
            <button className="icon-btn sm" onClick={()=>setViewDate(iso(addDays(parseISO(viewDate),7)))}>›</button>
          </div>
        </div>
        <p style={{textAlign:"center",margin:"16px 0 20px",fontSize:12.5,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>{iso(weekStart(parseISO(viewDate)))} → {iso(addDays(weekStart(parseISO(viewDate)),6))} · debt Mon–Fri, paid Sat–Sun</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:14}}>
          <Stat label="Owed" value={fmtH(summary.debt)}/><Stat label="Paid back" value={fmtH(summary.madeUp)}/><Stat label={summary.cleared?"Status":"Remaining"} value={summary.cleared?"CLEAR ◆":fmtH(summary.remaining)}/>
        </div>
        {summary.raw>CONFIG.TOTAL_DEBT_CEILING && <Note>Raw {fmtH(summary.raw)} capped at {fmtH(CONFIG.TOTAL_DEBT_CEILING)} to stay payable.</Note>}
        {summary.pending.length>0 && <Note>{summary.pending.length} weekday(s) not yet frozen.</Note>}
        <Ledger rows={summary.days}/>
        {summary.remaining>0 &&
          <div style={{marginTop:18}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--muted-fg)"}}><span>weekend target</span><span style={{color:"var(--fg)",fontWeight:600}}>{fmtH(summary.weekendTarget)}</span></div>
            <div className="barwrap"><div className="bar" style={{width:(summary.debt>0?Math.min(100,summary.madeUp/summary.debt*100):0)+"%"}}/></div>
          </div>}
        {summary.cleared && <div className="clear">◆ Debt paid in full. The week is settled.</div>}
      </section>
      <section className="card">
        <div className="eyebrow" style={{textAlign:"center",marginBottom:18}}>Make-up Time</div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:18,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:18}}>
            <div style={{fontSize:34,fontWeight:700,fontVariantNumeric:"tabular-nums",minWidth:130,color:running?"var(--fg)":"var(--muted-fg)"}}>{fmtClock(elapsed)}</div>
            {!running ? <button className="btn primary lg" onClick={()=>{setRunning(Date.now());setNow(Date.now());}}>▶ Start stopwatch</button>
              : <><button className="btn primary lg" onClick={()=>{addSession(elapsed,"stopwatch");setRunning(null);}}>■ Stop &amp; log</button><button className="btn ghost lg" onClick={()=>setRunning(null)}>discard</button></>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <input value={manual} onChange={e=>setManual(e.target.value)} inputMode="decimal" placeholder="1.5" className="inp" style={{width:66,textAlign:"center"}}/>
            <button className="btn primary" onClick={()=>{const h=parseFloat(manual);if(h>0){addSession(h,"manual");setManual("");}}}>+ log</button>
          </div>
        </div>
        {running && <div style={{fontSize:11,color:"var(--muted-fg)",marginTop:8}}>auto-caps at {CONFIG.SESSION_CAP_H}h</div>}
        {sessions.length>0 && <div style={{marginTop:14}}>{sessions.map(s=>(
          <div key={s.id} className="sessrow"><span style={{color:"var(--muted-fg)"}}>{new Date(s.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}<span className="badge">{s.source}</span></span>
          <span style={{display:"flex",gap:12,alignItems:"center"}}><b>{fmtH(s.hours)}</b><button className="x" onClick={()=>rm(s.id)}>×</button></span></div>
        ))}</div>}
      </section>
    </div>
  );
}
function Ledger({rows}){
  return (<div className="ledger">
    <div className="lhead"><span>Weekday</span><span className="c">Missed</span><span className="r">Status</span></div>
    {rows.map((r)=>{ const d=parseISO(r.date);
      return (<div key={r.date} className="lrow">
        <span><strong>{d.toLocaleDateString(undefined,{weekday:"short"})}</strong> <span style={{color:"var(--muted-fg)",marginLeft:6}}>{r.date.slice(5)}</span></span>
        <span className="c" style={{color:"var(--muted-fg)"}}>{r.missed===null?"—":r.missed===0?"0":"+"+fmtH(r.missed)}</span>
        <span className="r">{r.missed===null?<span style={{color:"var(--muted-fg)",fontSize:12.5}}>pending</span>:r.missed===0?<span className="pill">✓ full</span>:<span style={{color:"var(--muted-fg)",fontSize:12.5}}>owed</span>}</span>
      </div>); })}
  </div>);
}

/* ===== MONTH ===== */
function Month({state,viewDate,setViewDate,setTab,winPct}){
  const [cur,setCur]=useState(()=>{ const d=parseISO(viewDate); return new Date(d.getFullYear(),d.getMonth(),1); });
  const y=cur.getFullYear(),m=cur.getMonth();
  const days=new Date(y,m+1,0).getDate(), lead=(new Date(y,m,1).getDay()+6)%7;
  const cells=[]; for(let i=0;i<lead;i++)cells.push(null); for(let d=1;d<=days;d++)cells.push(d);
  const pcts=[]; for(let d=1;d<=days;d++){ const e=state.days[iso(new Date(y,m,d))]; if(e){const p=dayPct(e.habits); if(p>0)pcts.push(p);} }
  const avg=pcts.length?Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length):0;
  let wins=0; for(let d=1;d<=days;d++){ const e=state.days[iso(new Date(y,m,d))]; if(e&&dayPct(e.habits)>winPct)wins++; }
  const todayISO=iso(new Date());
  return (
    <section className="card">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
        <h2 className="h2">The Record</h2>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button className="icon-btn sm" onClick={()=>setCur(new Date(y,m-1,1))}>‹</button>
          <span className="chip" style={{fontVariantNumeric:"tabular-nums"}}>{cur.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</span>
          <button className="icon-btn sm" onClick={()=>setCur(new Date(y,m+1,1))}>›</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:14,marginTop:20}}>
        <Stat label="Monthly average" value={avg+"%"}/><Stat label="Win days ◆" value={String(wins)}/><Stat label="Days logged" value={String(pcts.length)}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8,marginTop:24}}>
        {["M","T","W","T","F","S","S"].map((d,i)=><div key={i} style={{textAlign:"center",fontSize:10.5,letterSpacing:".08em",color:"var(--muted-fg)",fontWeight:600,paddingBottom:4}}>{d}</div>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:"clamp(6px,0.8vw,12px)",marginTop:6}}>
        {cells.map((d,i)=>{ if(d==null)return <div key={i} style={{aspectRatio:"1/1"}}/>;
          const k=iso(new Date(y,m,d)); const e=state.days[k]; const p=e?dayPct(e.habits):null; const sel=k===viewDate; const isToday=k===todayISO;
          const c=heatCell(p);
          return (<button key={i} onClick={()=>{setViewDate(k);setTab("today");}} title={p!=null?p+"%":"no entry"} className="mcell"
            style={{background:c.bg,color:c.fg,boxShadow:sel?"0 0 0 2px var(--ring)":isToday?"0 0 0 2px var(--fg)":"none"}}>
            {d}{p!=null&&p>winPct && <span style={{position:"absolute",top:3,left:5,fontSize:8}}>◆</span>}</button>); })}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:20,fontSize:11,color:"var(--muted-fg)"}}>
        <span>less</span>{[null,20,45,70,95].map((p,i)=>{ const c=heatCell(p===null?0:p); return <span key={i} style={{width:16,height:16,borderRadius:5,background:c.bg,border:"1px solid var(--border-soft)"}}/>; })}<span>more</span>
      </div>
    </section>
  );
}
// heatmap cell color by daily % (0..100 or null) — mirrors the design's heat ramp.
function heatCell(p){
  if(p==null||p===0) return { bg:"var(--muted)", fg:"var(--muted-fg)" };
  const lvl = p>80?4 : p>60?3 : p>40?2 : 1;
  const bg = ["var(--muted)","hsl(240 4% 30%)","hsl(240 4% 50%)","hsl(240 4% 73%)","hsl(0 0% 92%)"][lvl];
  const fg = lvl>=2 ? "hsl(240 10% 8%)" : "var(--fg)";
  return { bg, fg };
}

/* ===== SETTINGS ===== */
function Settings({state,setState,winPct,sync,onPull}){
  const setWin=v=>setState(s=>({...s,winPct:v}));
  return (
    <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:18}}>
      <div style={{textAlign:"center"}}>
        <h2 className="h2" style={{fontSize:20}}>Settings</h2>
        <p style={{margin:"6px 0 0",fontSize:13,color:"var(--muted-fg)"}}>Tune the ledger to your standards.</p>
      </div>
      <section className="card">
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span className="eyebrow">Win-day threshold</span>
          <span style={{fontSize:26,fontWeight:800,fontVariantNumeric:"tabular-nums"}}>{winPct}<span style={{fontSize:14,color:"var(--muted-fg)",fontWeight:600}}>%</span></span>
        </div>
        <p style={{textAlign:"center",margin:"12px 0 22px",fontSize:13,color:"var(--muted-fg)"}}>A day counts as a ◆ win when your daily % is above this line.</p>
        <ThresholdSlider value={winPct} onChange={setWin}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12,fontSize:11.5,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>
          <span>50%</span><span>lenient ← · → strict</span><span>100%</span>
        </div>
      </section>
      <section className="card" style={{textAlign:"center"}}>
        <div className="eyebrow">Notion Sync</div>
        <div style={{marginTop:14,fontSize:13.5,color:"var(--muted-fg)"}}>status · <strong style={{color:"var(--fg)",fontWeight:600}}>{sync.loading?"syncing…":sync.error?"error":"connected"}</strong></div>
        <div style={{marginTop:4,fontSize:12.5,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>last pull · {sync.lastPull?new Date(sync.lastPull).toLocaleString():"—"}</div>
        {sync.error && <div style={{color:"var(--fg)",marginTop:6,fontSize:12.5}}>{sync.error}</div>}
        <button className="btn primary" style={{marginTop:18}} onClick={onPull}>↓ Pull latest from Notion</button>
      </section>
    </div>
  );
}
function ThresholdSlider({value,onChange}){
  const pct=((value-50)/50)*100;
  return (
    <div className="range-wrap">
      <div className="range-track"/>
      <div className="range-fill" style={{width:pct+"%"}}/>
      <input type="range" min={50} max={100} value={value} onChange={e=>onChange(Number(e.target.value))} className="range-input" aria-label="Win-day threshold"/>
    </div>
  );
}

/* ===== shared ===== */
function Stat({label,value}){ return <div className="stat"><div className="statv">{value}</div><div className="eyebrow" style={{marginTop:8}}>{label}</div></div>; }
function Note({children}){ return <div className="note" style={{marginTop:16,marginBottom:0}}>⚠ {children}</div>; }
function DateNav({viewDate,setViewDate,today}){
  const d=parseISO(viewDate); const isToday=viewDate===today;
  return (<div style={{display:"flex",alignItems:"center",gap:14}}>
    <button className="icon-btn sm" onClick={()=>setViewDate(iso(addDays(d,-1)))}>‹</button>
    <div><div style={{fontSize:16,fontWeight:700}}>{isToday?"Today":d.toLocaleDateString(undefined,{weekday:"long"})}</div><div style={{fontSize:12.5,color:"var(--muted-fg)",fontVariantNumeric:"tabular-nums"}}>{viewDate}</div></div>
    <button className="icon-btn sm" onClick={()=>setViewDate(iso(addDays(d,1)))}>›</button>
    {!isToday && <button className="chip" onClick={()=>setViewDate(today)}>today</button>}
  </div>);
}
function fmtClock(h){ const t=Math.floor(h*3600); const p=n=>String(n).padStart(2,"0"); return p(Math.floor(t/3600))+":"+p(Math.floor(t%3600/60))+":"+p(t%60); }

const THEME = { "--sans":"'Geist','Inter',system-ui,sans-serif", "--mono":"'Geist Mono','IBM Plex Mono','SF Mono',Menlo,monospace" };
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap');
.dl[data-theme="dark"]{
  --bg:hsl(240 10% 3.9%); --card:hsl(240 8% 6.6%); --card-2:hsl(240 6% 10.5%);
  --border:hsl(240 4% 15.5%); --border-soft:hsl(240 4% 12%); --muted:hsl(240 4% 13.5%);
  --muted-fg:hsl(240 5% 62%); --fg:hsl(0 0% 98%); --primary:hsl(0 0% 98%); --primary-fg:hsl(240 6% 10%);
  --input:hsl(240 5% 11%); --ring:hsl(240 5% 34%); --destructive:hsl(0 72% 60%);
}
.dl[data-theme="light"]{
  --bg:hsl(240 6% 97%); --card:hsl(0 0% 100%); --card-2:hsl(240 5% 98%);
  --border:hsl(240 6% 90%); --border-soft:hsl(240 6% 93%); --muted:hsl(240 5% 95.5%);
  --muted-fg:hsl(240 4% 46%); --fg:hsl(240 10% 8%); --primary:hsl(240 6% 10%); --primary-fg:hsl(0 0% 98%);
  --input:hsl(0 0% 100%); --ring:hsl(240 5% 78%); --destructive:hsl(0 72% 51%);
}
* { box-sizing:border-box; }
.dl input, .dl button, .dl textarea { font-family:inherit; }
.dl button { cursor:pointer; color:inherit; }
.dl button:disabled { opacity:.5; cursor:default; }
.dl input::placeholder { color:var(--muted-fg); opacity:.65; }
.dl button:focus-visible, .dl input:focus-visible, .range-input:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.dl ::-webkit-scrollbar{ width:11px; height:11px; }
.dl ::-webkit-scrollbar-thumb{ background:var(--border); border-radius:8px; border:3px solid transparent; background-clip:padding-box; }
.dl ::-webkit-scrollbar-thumb:hover{ background:var(--muted-fg); background-clip:padding-box; }
.dl ::-webkit-scrollbar-track{ background:transparent; }
.morphword { animation-duration:.72s; animation-timing-function:ease-in-out; animation-fill-mode:both; will-change:filter,opacity; }
.morphword.in { animation-name:morphIn; } .morphword.out { animation-name:morphOut; }
@keyframes morphIn { 0%{filter:blur(18px);opacity:0;} 45%{filter:blur(6px);opacity:.4;} 100%{filter:blur(0);opacity:1;} }
@keyframes morphOut { 0%{filter:blur(0);opacity:1;} 55%{filter:blur(6px);opacity:.4;} 100%{filter:blur(18px);opacity:0;} }
@keyframes shimmer { 0%{background-position:-400px 0;} 100%{background-position:400px 0;} }
@media (prefers-reduced-motion:reduce){ .morphword{animation:none!important;} .morphword.out{opacity:0!important;} .morphword.in{opacity:1!important;filter:none!important;} .skel{animation:none!important;} }

.eyebrow { font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted-fg); font-weight:600; }
.h2 { margin:0; font-size:16px; font-weight:700; color:var(--fg); }

.hdr { position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap;
  padding:16px clamp(18px,3vw,44px) 0; background:color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter:blur(12px); border-bottom:1px solid var(--border-soft); }
.hdr-title { display:flex; flex-direction:column; gap:2px; padding-bottom:14px; }
.hdr-title h1 { margin:0; font-size:clamp(19px,2vw,23px); font-weight:700; letter-spacing:-.01em; color:var(--fg); }
.hdr-actions { display:flex; align-items:center; gap:8px; padding-bottom:14px; }
.tabs { order:3; width:100%; display:flex; gap:2px; }
.tab { appearance:none; border:none; background:transparent; padding:0 4px 12px; margin-right:22px; font-size:13.5px; font-weight:500; color:var(--muted-fg); border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s; }
.tab.on { color:var(--fg); font-weight:600; border-bottom-color:var(--fg); }

.main { padding:clamp(20px,2.4vw,34px) clamp(18px,3vw,44px) 56px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px clamp(18px,2vw,28px); }
.card.pad { padding:22px 24px 24px; }
.card-sub { margin:4px 0 18px; font-size:13px; color:var(--muted-fg); }
.lists-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; }
@media (max-width:720px){ .lists-grid{ grid-template-columns:1fr; } }

.btn { display:inline-flex; align-items:center; gap:7px; height:34px; padding:0 13px; border-radius:9px; border:1px solid var(--border); background:transparent; color:var(--fg); font-size:12.5px; font-weight:500; transition:background .15s,opacity .15s; }
.btn:hover:not(:disabled) { background:var(--muted); }
.btn.primary { border-color:var(--primary); background:var(--primary); color:var(--primary-fg); font-weight:600; }
.btn.primary:hover:not(:disabled) { background:var(--primary); opacity:.9; }
.btn.lg { height:42px; padding:0 20px; border-radius:11px; font-size:13.5px; }
.btn .count { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; padding:0 5px; border-radius:6px; background:color-mix(in srgb,var(--primary-fg) 16%,transparent); font-size:11px; font-weight:700; }
.icon-btn { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:9px; border:1px solid var(--border); background:transparent; color:var(--fg); font-size:15px; transition:background .15s; }
.icon-btn:hover:not(:disabled) { background:var(--muted); }
.icon-btn.sm { width:30px; height:30px; font-size:14px; }
.chip { padding:6px 14px; border-radius:8px; border:1px solid var(--border); background:var(--muted); font-size:12.5px; font-weight:500; color:var(--fg); }
.chip:hover { background:var(--card-2); }

.study { margin-top:22px; background:var(--card-2); border:1px solid var(--border-soft); border-radius:14px; padding:20px; }
.block { text-align:left; border:1px solid var(--border); background:var(--card); border-radius:12px; padding:15px 16px; color:var(--fg); transition:.15s; }
.block .block-sub { color:var(--muted-fg); } .block .block-note { color:var(--muted-fg); }
.block.on { background:var(--fg); color:var(--primary-fg); border-color:transparent; }
.block.on .block-sub { color:color-mix(in srgb,var(--primary-fg) 55%,transparent); }
.block.on .block-note { color:var(--primary-fg); }

.habit { display:inline-flex; align-items:center; gap:9px; height:40px; padding:0 16px 0 12px; border-radius:11px; border:1px solid var(--border); background:transparent; color:var(--fg); font-size:13px; font-weight:500; transition:all .15s; }
.habit.on { border-color:var(--fg); background:var(--muted); }
.dot { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; flex:none; font-size:11px; font-weight:700; border:1.5px solid var(--muted-fg); background:transparent; color:transparent; transition:.15s; }
.dot.on { border-color:var(--fg); background:var(--fg); color:var(--primary-fg); }
.dot.sm { width:16px; height:16px; font-size:10px; }

.day { text-align:center; border-radius:12px; padding:14px 6px; border:1px solid var(--border-soft); background:var(--card-2); transition:.15s; }
.day.sel { border-color:var(--fg); }

.signal-row { display:flex; align-items:center; gap:12px; }
.signal-n { width:16px; text-align:center; font-size:13px; color:var(--muted-fg); font-variant-numeric:tabular-nums; flex:none; }
.task-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; background:var(--card-2); border:1px solid var(--border-soft); }
.inp { height:42px; padding:0 14px; border-radius:10px; border:1px solid var(--border); background:var(--input); color:var(--fg); font-size:13.5px; outline:none; transition:border-color .15s; }
.inp:focus { border-color:var(--ring); }
.add-btn { width:42px; height:42px; flex:none; border-radius:10px; border:1px solid var(--border); background:var(--muted); color:var(--fg); font-size:18px; font-weight:500; transition:.15s; }
.add-btn:hover { background:var(--card-2); }
.x { border:none; background:none; color:var(--muted-fg); font-size:16px; line-height:1; padding:0 2px; transition:color .15s; }
.x:hover { color:var(--destructive); }
.linkbtn { border:none; background:none; color:var(--fg); text-decoration:underline; font-family:var(--mono); font-size:11.5px; padding:0; }

.seg { display:flex; gap:4px; padding:3px; border-radius:10px; background:var(--card-2); border:1px solid var(--border-soft); }
.seg-btn { appearance:none; border:none; padding:5px 12px; border-radius:8px; font-size:12px; font-weight:500; background:transparent; color:var(--muted-fg); transition:all .15s; }
.seg-btn.on { background:var(--primary); color:var(--primary-fg); font-weight:600; }

.stat { background:var(--card-2); border:1px solid var(--border-soft); border-radius:14px; padding:26px 20px; text-align:center; }
.statv { font-size:30px; font-weight:800; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.ledger { margin-top:16px; border:1px solid var(--border-soft); border-radius:14px; overflow:hidden; }
.lhead, .lrow { display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; }
.lhead { padding:12px 20px; background:var(--card-2); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted-fg); font-weight:600; }
.lrow { padding:15px 20px; border-top:1px solid var(--border-soft); font-size:13.5px; }
.lhead .c, .lrow .c { text-align:center; } .lhead .r, .lrow .r { text-align:right; }
.pill { display:inline-flex; align-items:center; padding:3px 10px; border-radius:7px; background:var(--muted); border:1px solid var(--border); font-size:12px; font-weight:600; color:var(--fg); }
.barwrap { height:8px; background:var(--muted); border-radius:99px; margin-top:10px; overflow:hidden; }
.bar { height:100%; background:var(--primary); transition:width .3s; }
.clear { margin-top:18px; border:1px solid var(--border-soft); background:var(--card-2); border-radius:14px; padding:14px; text-align:center; font-weight:600; }
.note { font-size:12.5px; color:var(--muted-fg); background:var(--card-2); border:1px solid var(--border-soft); border-radius:12px; padding:12px 18px; text-align:center; }
.sessrow { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border-soft); font-size:12.5px; }
.sessrow:last-child { border-bottom:none; }
.badge { margin-left:8px; font-size:10px; padding:1px 6px; border-radius:8px; background:var(--muted); color:var(--muted-fg); }
.mcell { aspect-ratio:1/1; border-radius:12px; font-size:12.5px; font-weight:600; font-variant-numeric:tabular-nums; display:flex; align-items:flex-end; justify-content:flex-end; padding:9px 11px; position:relative; transition:.12s; border:none; }

.skel { position:relative; overflow:hidden; background:var(--card-2); }
.skel::after { content:""; position:absolute; inset:0; background:linear-gradient(90deg,transparent,var(--border),transparent); background-size:800px 100%; animation:shimmer 1.3s infinite linear; }

.range-wrap { position:relative; height:22px; display:flex; align-items:center; }
.range-track { position:absolute; left:0; right:0; height:6px; border-radius:99px; background:var(--muted); }
.range-fill { position:absolute; left:0; height:6px; border-radius:99px; background:var(--primary); }
.range-input { position:absolute; left:0; right:0; width:100%; margin:0; -webkit-appearance:none; appearance:none; background:transparent; height:22px; cursor:pointer; }
.range-input::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; border-radius:50%; background:var(--fg); border:2px solid var(--bg); box-shadow:0 1px 4px rgba(0,0,0,.4); cursor:pointer; }
.range-input::-moz-range-thumb { width:18px; height:18px; border-radius:50%; background:var(--fg); border:2px solid var(--bg); cursor:pointer; }
.range-input::-webkit-slider-runnable-track { background:transparent; }
`;
