import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

/* ===== backend ===== */
const API_BASE = "https://habit-tracker-backend-sigma.vercel.app";

const STUDY_BLOCKS = [
  { key: "Study Block 1", hours: 3.5, window: "3:00–6:30 PM" },
  { key: "Study Block 2", hours: 2.5, window: "7:00–9:30 PM" },
  { key: "Study Block 3", hours: 0.5, window: "10:30–11:00 PM" },
];
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
function emptyState(){ return { days:{}, makeup:{}, signal:[], monthlyTasks:[], winPct:75, quests:[], activeQuestId:null }; }
const QUEST_TARGET = 20; // hours to competence

function missedForDay(dayISO,habits){ const d=parseISO(dayISO); if(!isDebtDay(d))return 0;
  return STUDY_BLOCKS.reduce((s,b)=>s+(habits[b.key]?0:b.hours),0); }
function weekSummary(state,ref){
  const start=weekStart(ref); const days=[];
  for(let i=0;i<5;i++){ const d=addDays(start,i); const k=iso(d); const e=state.days[k]; let missed=null;
    if(e){ if(e.frozen||isPastFreeze(d)) missed=missedForDay(k,e.habits); }
    else if(isPastFreeze(d)) missed=0; // no entry = excused (sick day you never touched), not a full miss
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
  // An older backend won't send quests at all — keep whatever is local rather
  // than letting an absent key wipe them.
  if(!Array.isArray(pull.quests)) return {...prev,days,signal,monthlyTasks,_pageIds:pageIds};
  const quests=pull.quests.map(q=>({
    id:q.pageId, pageId:q.pageId, name:q.name||"", hours:q.hours||0,
    done:!!q.done, created:q.created, sessions:[],
  }));
  const byId=Object.fromEntries(quests.map(q=>[q.id,q]));
  // Sessions arrive as a flat list; the relation says which quest each belongs to.
  (pull.questSessions||[]).forEach(s=>{
    (s.questIds||[]).forEach(qid=>{ const q=byId[qid]; if(!q) return;
      q.sessions.push({id:s.pageId,pageId:s.pageId,hours:s.hours||0,at:s.at,source:s.source||"manual",weekend:!!s.weekend}); });
  });
  quests.forEach(q=>q.sessions.sort((a,b)=>String(a.at).localeCompare(String(b.at))));
  const active=pull.quests.find(q=>q.active);
  return {...prev,days,signal,monthlyTasks,quests,activeQuestId:active?active.pageId:null,_pageIds:pageIds};
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
    <div onClick={onDone} style={{position:"fixed",inset:0,background:"var(--background)",display:"grid",placeItems:"center",zIndex:50,cursor:"pointer",opacity:fading?0:1,transition:"opacity 1.1s ease",pointerEvents:fading?"none":"auto"}}>
      <svg style={{position:"absolute",width:0,height:0}} aria-hidden="true"><defs><filter id="morph-goo"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 42 -14"/></filter></defs></svg>
      <div style={{textAlign:"center"}}>
        <div style={{position:"relative",filter:"url(#morph-goo)",minHeight:"1.2em",display:"grid",placeItems:"center"}}>
          <span key={"out"+wi} className="morphword out" style={MORPH_STYLE}>{prev}</span>
          <span key={"in"+wi} className="morphword in" style={MORPH_STYLE}>{INTRO_WORDS[wi]}</span>
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:11,letterSpacing:4,textTransform:"uppercase",color:"var(--muted-foreground)",marginTop:24}}>tap to skip</div>
      </div>
    </div>
  );
}
const MORPH_STYLE = { gridArea:"1/1", fontFamily:"var(--mono)", fontSize:"clamp(26px,6vw,58px)", fontWeight:600, letterSpacing:"0.18em", color:"var(--foreground)", textTransform:"uppercase" };

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

  useEffect(()=>{ try{localStorage.setItem(LS,JSON.stringify(state));}catch(e){} },[state]);

  // Lets the memoised write-through APIs read current state without re-creating
  // themselves (and losing in-flight closures) on every keystroke.
  const stateRef=useRef(state);
  useEffect(()=>{ stateRef.current=state; },[state]);

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

  /* ---- Skill Quests: same write-through, across two related Notion dbs ---- */
  // Quests hold the running total; each logged session is its own row related
  // back to the quest, so history and pace survive a browser clear.
  const questApi = useMemo(()=>{
    const flag = err => setSync(s=>({...s,error:err}));
    const questsOf = () => stateRef.current.quests||[];

    const add = async name => {
      name=(name||"").trim(); if(!name) return;
      const tempId="tmp-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
      const makeActive = !stateRef.current.activeQuestId;
      setState(s=>({...s,
        quests:[...(s.quests||[]),{id:tempId,pageId:null,name,hours:0,done:false,sessions:[],saving:true}],
        activeQuestId: makeActive ? tempId : s.activeQuestId}));
      try{
        const res=await apiPushOne({db:"quests",create:true,
          fields:{Quest:name,Hours:0,Done:false,Active:makeActive,Created:iso(new Date())}});
        setState(s=>({...s,
          quests:(s.quests||[]).map(q=>q.id===tempId?{...q,id:res.pageId,pageId:res.pageId,saving:false}:q),
          activeQuestId:s.activeQuestId===tempId?res.pageId:s.activeQuestId}));
      }catch(e){
        setState(s=>({...s,quests:(s.quests||[]).map(q=>q.id===tempId?{...q,saving:false,error:true}:q)}));
        flag(e.message);
      }
    };

    // Exactly one row carries Active in Notion, so promoting clears the old one.
    const promote = async id => {
      const prevId=stateRef.current.activeQuestId;
      if(prevId===id) return;
      setState(s=>({...s,activeQuestId:id}));
      try{
        const next=questsOf().find(q=>q.id===id);
        if(next&&next.pageId) await apiPushOne({db:"quests",pageId:next.pageId,fields:{Active:true}});
        const prevQ=questsOf().find(q=>q.id===prevId);
        if(prevQ&&prevQ.pageId) await apiPushOne({db:"quests",pageId:prevQ.pageId,fields:{Active:false}});
      }catch(e){ flag(e.message); }
    };

    const remove = async id => {
      const q=questsOf().find(x=>x.id===id);
      setState(s=>({...s,quests:(s.quests||[]).filter(x=>x.id!==id),
        activeQuestId:s.activeQuestId===id?null:s.activeQuestId}));
      if(!q||!q.pageId) return; // never persisted, nothing to archive
      try{ await apiPushOne({db:"quests",pageId:q.pageId,archive:true}); }
      catch(e){ flag(e.message); }
    };

    const logHours = async (id,hours,source) => {
      hours=Math.min(hours,CONFIG.SESSION_CAP_H); if(hours<=0) return;
      const q=questsOf().find(x=>x.id===id); if(!q) return;
      const h=Math.round(hours*100)/100;
      const at=new Date(); const weekend=isWeekend(at); const wk=weekKey(at);
      const total=Math.round((q.hours+h)*100)/100;
      const done=total>=QUEST_TARGET;
      const tempId="tmp-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);

      setState(s=>({...s,
        quests:(s.quests||[]).map(x=>x.id!==id?x:{...x,hours:total,done,
          sessions:[...(x.sessions||[]),{id:tempId,pageId:null,hours:h,at:at.toISOString(),source,weekend,saving:true}]}),
        // weekend hours also pay back this week's study debt
        makeup: weekend
          ? {...s.makeup,[wk]:[...(s.makeup[wk]||[]),{id:tempId,hours:h,source:"quest",at:at.toISOString()}]}
          : s.makeup}));

      if(!q.pageId){ flag("Quest is still saving to Notion — that session was kept locally only."); return; }
      try{
        const res=await apiPushOne({db:"questSessions",create:true,fields:{
          Session:`${q.name} · ${at.toLocaleDateString()}`,
          Hours:h, At:at.toISOString(), Source:source, Weekend:weekend, Quest:[q.pageId]}});
        setState(s=>({...s,quests:(s.quests||[]).map(x=>x.id!==id?x:{...x,
          sessions:(x.sessions||[]).map(ss=>ss.id===tempId?{...ss,id:res.pageId,pageId:res.pageId,saving:false}:ss)})}));
        await apiPushOne({db:"quests",pageId:q.pageId,fields:{Hours:total,Done:done}});
      }catch(e){
        setState(s=>({...s,quests:(s.quests||[]).map(x=>x.id!==id?x:{...x,
          sessions:(x.sessions||[]).map(ss=>ss.id===tempId?{...ss,saving:false,error:true}:ss)})}));
        flag(e.message);
      }
    };

    return { add, promote, remove, logHours };
  },[]);

  return (
    <div className={dark?"dark":"light"} style={THEME}>
      <style>{CSS}</style>
      {intro && <Intro onDone={()=>{setIntro(false);setTimeout(()=>setRevealed(true),60);}}/>}
      <div style={{minHeight:"100vh",background:"var(--background)",color:"var(--foreground)",fontFamily:"var(--sans)"}}>
        <div className="shell">

          <Reveal show={revealed} delay={0}>
            <header style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
              <div>
                <div className="eyebrow">Personal Ledger</div>
                <h1 style={{margin:"2px 0 0",fontSize:26,fontWeight:700,letterSpacing:-0.5}}>The Discipline Ledger</h1>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <SyncBadge sync={sync} dirtyCount={dirtyDates.length} onPull={doPull} onPush={doPush}/>
                <button className="ghost" onClick={()=>setDark(d=>!d)} title="toggle theme" style={{width:34,height:34,padding:0}}>{dark?"○":"●"}</button>
              </div>
            </header>
          </Reveal>

          <Reveal show={revealed} delay={80}>
            <nav className="tabs">
              {[["today","Today"],["quests","Quests"],["week","Reckoning"],["month","Record"],["settings","Settings"]].map(([id,l])=>(
                <button key={id} onClick={()=>setTab(id)} className={"tab"+(tab===id?" on":"")}>{l}</button>
              ))}
            </nav>
          </Reveal>

          {sync.error && <Reveal show={revealed} delay={120}><div className="note" style={{marginBottom:16}}>⚠ {sync.error} — <button className="linkbtn" onClick={doPull}>retry</button></div></Reveal>}

          {tab==="today" && <Today cur={cur} setHabit={setHabit} viewDate={viewDate} setViewDate={setViewDate} today={today} summary={summary} state={state} listApi={listApi} winPct={winPct} loading={sync.loading} revealed={revealed}/>}
          {tab==="week" && <Reveal show={revealed} delay={120}><Week summary={summary} state={state} setState={setState} viewDate={viewDate} setViewDate={setViewDate}/></Reveal>}
          {tab==="month" && <Reveal show={revealed} delay={120}><Month state={state} viewDate={viewDate} setViewDate={setViewDate} setTab={setTab} winPct={winPct}/></Reveal>}
          {tab==="quests" && <Reveal show={revealed} delay={120}><Quests state={state} api={questApi}/></Reveal>}
          {tab==="settings" && <Reveal show={revealed} delay={120}><Settings state={state} setState={setState} winPct={winPct} sync={sync} onPull={doPull}/></Reveal>}
        </div>
      </div>
    </div>
  );
}

/* ===== sync badge ===== */
function SyncBadge({sync,dirtyCount,onPull,onPush}){
  return (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <button className="ghost sm" onClick={onPull} disabled={sync.loading} title="Pull from Notion">
        {sync.loading?"↻ syncing":"↓ pull"}
      </button>
      <button className={"ghost sm"+(dirtyCount>0?" hot":"")} onClick={onPush} disabled={sync.pushing||dirtyCount===0} title="Push changes to Notion">
        {sync.pushing?"↻ pushing":`↑ push${dirtyCount?" ("+dirtyCount+")":""}`}
      </button>
    </div>
  );
}

/* ===== skeleton ===== */
function Skel({h=16,w="100%",r=8,style}){ return <div className="skel" style={{height:h,width:w,borderRadius:r,...style}}/>; }
function CardSkeleton(){
  return (
    <div className="card">
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}><Skel w={140} h={20}/><Skel w={50} h={28}/></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>{[0,1,2].map(i=><Skel key={i} h={64} r={12}/>)}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>{Array.from({length:9}).map((_,i)=><Skel key={i} h={42} r={12}/>)}</div>
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
  const hasEntry=!!state.days[viewDate]; // a frozen day with no entry is excused, not owed
  return (
    <>
      <Reveal show={revealed} delay={120}>
        <div className="lists-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
          <SignalSpace items={state.signal} api={listApi.signal}/>
          <MonthTasks items={state.monthlyTasks} api={listApi.tasks}/>
        </div>
      </Reveal>

      <Reveal show={revealed} delay={200}>
        {loading ? <CardSkeleton/> : (
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
            <DateNav viewDate={viewDate} setViewDate={setViewDate} today={today}/>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"var(--mono)",fontSize:30,fontWeight:600,lineHeight:1}}>{pct}<span style={{fontSize:15,color:"var(--muted-foreground)"}}>%</span></div>
              <div className="eyebrow" style={{marginTop:3}}>{isWin?"◆ win day":"of the day"}</div>
            </div>
          </div>
          <div className="study">
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
              <span className="eyebrow">Study Ledger · {isDebtDay(d)?"weekday":"free day"}</span>
              <span style={{fontFamily:"var(--mono)",fontSize:13}}>{fmtH(studyDone)} <span style={{color:"var(--muted-foreground)"}}>/ 6.5h</span></span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {STUDY_BLOCKS.map(b=>{ const on=cur.habits[b.key];
                return (
                  <button key={b.key} onClick={()=>setHabit(b.key,!on)} className={"block"+(on?" on":"")}>
                    <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:600}}>{fmtH(b.hours)}</div>
                    <div style={{fontSize:11,marginTop:3,opacity:.7}}>{b.window}</div>
                    <div style={{fontSize:10.5,marginTop:8,fontWeight:600,letterSpacing:.5}}>{on?"✓ LOGGED":"tap to log"}</div>
                  </button>
                ); })}
            </div>
            {isDebtDay(d)&&studyMissed>0&&(hasEntry||!frozen) &&
              <div style={{marginTop:12,fontFamily:"var(--mono)",fontSize:12,display:"flex",justifyContent:"space-between",color:"var(--muted-foreground)"}}>
                <span>{frozen?"frozen · owed this week":"if unlogged by noon tomorrow"}</span>
                <span style={{fontWeight:600,color:"var(--foreground)"}}>+{fmtH(studyMissed)}</span>
              </div>}
          </div>
          <div className="eyebrow" style={{margin:"22px 0 10px"}}>Daily Habits</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
            {OTHER_HABITS.map(h=>{ const on=cur.habits[h];
              return (
                <button key={h} onClick={()=>setHabit(h,!on)} className={"habit"+(on?" on":"")}>
                  <span className={"box"+(on?" on":"")}>{on?"✓":""}</span>
                  <span style={{fontSize:13.5,fontWeight:on?600:500}}>{SHORT[h]}</span>
                </button>
              ); })}
          </div>
          <WeekStrip summary={summary} viewDate={viewDate} setViewDate={setViewDate}/>
        </Card>)}
      </Reveal>

      <Reveal show={revealed} delay={280}>
        {loading ? <div className="card"><Skel w={140} h={18} style={{marginBottom:16}}/><Skel h={230} r={12}/></div> : <TrendChart state={state} anchor={viewDate} winPct={winPct}/>}
      </Reveal>
    </>
  );
}

/* ===== Signal Space (3 independent slots, synced to Notion) ===== */
function SignalSpace({items,api}){
  return (
    <Card pad>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}><div className="eyebrow">Signal Space</div><div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>{items.length}/3</div></div>
      <div style={{fontSize:12,color:"var(--muted-foreground)",margin:"3px 0 12px"}}>Your top 3 priorities right now.</div>
      {[0,1,2].map(i=>{ const it=items[i];
        return (<div key={it?it.id:"empty-"+i} className="listrow">
          <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--muted-foreground)",width:16}}>{i+1}</span>
          {it ? <>
            <button className={"box sm"+(it.done?" on":"")} onClick={()=>api.update(it,{done:!it.done})} title="toggle done">{it.done?"✓":""}</button>
            <span style={{flex:1,fontSize:13.5,textDecoration:it.done?"line-through":"none",color:it.done?"var(--muted-foreground)":"var(--foreground)",opacity:it.saving?.55:1}}>{it.text}</span>
            {it.error && <span title="not saved" style={{color:"var(--destructive)",fontSize:12}}>!</span>}
            <button className="x" onClick={()=>api.remove(it)}>×</button>
          </> : <SignalInput onAdd={api.add}/>}
        </div>); })}
    </Card>
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
    <Card pad>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}><div className="eyebrow">This Month</div><div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>{done}/{items.length}</div></div>
      <div style={{fontSize:12,color:"var(--muted-foreground)",margin:"3px 0 12px"}}>Tasks to finish this month.</div>
      <div style={{maxHeight:150,overflowY:"auto",marginBottom:8}}>
        {items.map(it=>(<div key={it.id} className="listrow" style={{opacity:it.saving?.6:1}}>
          <button className={"box sm"+(it.done?" on":"")} onClick={()=>api.update(it,{done:!it.done})}>{it.done?"✓":""}</button>
          <span style={{flex:1,fontSize:13.5,textDecoration:it.done?"line-through":"none",color:it.done?"var(--muted-foreground)":"var(--foreground)"}}>{it.text}</span>
          {it.error && <span title="not saved" style={{color:"var(--destructive)",fontSize:12}}>!</span>}
          <button className="x" onClick={()=>api.remove(it)}>×</button>
        </div>))}
      </div>
      <div style={{display:"flex",gap:6}}>
        <input value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Add task…" className="inp" style={{flex:1}}/>
        <button className="ghost" onClick={add}>+</button>
      </div>
    </Card>
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
  const stroke1="var(--chart-5)", stroke2="var(--chart-2)";
  return (
    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div><div className="eyebrow">Consistency Trend</div><div style={{fontSize:12,color:"var(--muted-foreground)",marginTop:2}}>Habits vs study, last {range} days</div></div>
        <div style={{display:"flex",gap:4}}>
          {[7,30,90].map(r=><button key={r} className={"ghost sm"+(range===r?" hot":"")} onClick={()=>setRange(r)}>{r}d</button>)}
        </div>
      </div>
      <div style={{width:"100%",height:230,marginTop:8}}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{top:8,right:8,left:-18,bottom:0}}>
            <defs>
              <linearGradient id="fillHabits" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={stroke1} stopOpacity={0.5}/><stop offset="95%" stopColor={stroke1} stopOpacity={0.04}/></linearGradient>
              <linearGradient id="fillStudy" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={stroke2} stopOpacity={0.5}/><stop offset="95%" stopColor={stroke2} stopOpacity={0.04}/></linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)"/>
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28}
              tick={{fill:"var(--muted-foreground)",fontFamily:"var(--mono)",fontSize:10}}
              tickFormatter={v=>parseISO(v).toLocaleDateString("en-US",{month:"short",day:"numeric"})}/>
            <YAxis domain={[0,100]} tickLine={false} axisLine={false} width={34}
              tick={{fill:"var(--muted-foreground)",fontFamily:"var(--mono)",fontSize:10}}/>
            <Tooltip contentStyle={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,fontFamily:"var(--mono)",fontSize:12,color:"var(--foreground)"}}
              labelFormatter={v=>parseISO(v).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}
              formatter={(val,name)=>[val+"%", name==="habits"?"Habits":"Study"]}/>
            <Area dataKey="study" type="natural" stroke={stroke2} strokeWidth={2} fill="url(#fillStudy)" stackId="1"/>
            <Area dataKey="habits" type="natural" stroke={stroke1} strokeWidth={2} fill="url(#fillHabits)" stackId="1"/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{display:"flex",gap:18,marginTop:6,fontFamily:"var(--mono)",fontSize:10.5,color:"var(--muted-foreground)"}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}><span style={{width:14,height:2.5,background:stroke1}}/>habits %</span>
        <span style={{display:"flex",alignItems:"center",gap:6}}><span style={{width:14,height:2.5,background:stroke2}}/>study %</span>
        <span style={{marginLeft:"auto"}}>avg <b style={{color:"var(--foreground)"}}>{avg}%</b></span>
      </div>
    </Card>
  );
}

function WeekStrip({summary,viewDate,setViewDate}){
  return (
    <div style={{marginTop:22,paddingTop:18,borderTop:"1px solid var(--border)"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
        <span className="eyebrow">This Week</span>
        <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--muted-foreground)"}}>{summary.remaining>0?fmtH(summary.remaining)+" owed":summary.debt>0?"cleared ◆":"no debt"}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6}}>
        {Array.from({length:7}).map((_,i)=>{ const d=addDays(weekStart(parseISO(viewDate)),i); const k=iso(d);
          const row=summary.days.find(x=>x.date===k); const wknd=isWeekend(d); const sel=k===viewDate;
          let label=""; if(wknd)label="pay"; else if(row)label=row.missed===null?"·":row.missed===0?"✓":"+"+row.missed;
          return (<button key={k} onClick={()=>setViewDate(k)} className={"day"+(sel?" sel":"")+(wknd?" wknd":"")}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--muted-foreground)"}}>{d.toLocaleDateString(undefined,{weekday:"short"})[0]}</div>
            <div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:600,marginTop:3}}>{d.getDate()}</div>
            <div style={{fontFamily:"var(--mono)",fontSize:9,marginTop:3,color:"var(--muted-foreground)",minHeight:11}}>{label}</div>
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
    <>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <h2 style={{margin:0,fontSize:18,fontWeight:700}}>The Reckoning</h2>
          <div style={{display:"flex",gap:4}}>
            <button className="ghost sm" onClick={()=>setViewDate(iso(addDays(parseISO(viewDate),-7)))}>‹</button>
            <button className="ghost sm" onClick={()=>setViewDate(iso(new Date()))}>this week</button>
            <button className="ghost sm" onClick={()=>setViewDate(iso(addDays(parseISO(viewDate),7)))}>›</button>
          </div>
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)",marginBottom:18}}>{iso(weekStart(parseISO(viewDate)))} → {iso(addDays(weekStart(parseISO(viewDate)),6))} · debt Mon–Fri, paid Sat–Sun</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:18}}>
          <Stat label="Owed" value={fmtH(summary.debt)}/><Stat label="Paid back" value={fmtH(summary.madeUp)}/><Stat label={summary.cleared?"Status":"Remaining"} value={summary.cleared?"CLEAR ◆":fmtH(summary.remaining)}/>
        </div>
        {summary.raw>CONFIG.TOTAL_DEBT_CEILING && <Note>Raw {fmtH(summary.raw)} capped at {fmtH(CONFIG.TOTAL_DEBT_CEILING)} to stay payable.</Note>}
        {summary.pending.length>0 && <Note>{summary.pending.length} weekday(s) not yet frozen.</Note>}
        <Ledger rows={summary.days}/>
        {summary.remaining>0 &&
          <div style={{marginTop:18}}>
            <div style={{display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:12,color:"var(--muted-foreground)"}}><span>weekend target</span><span style={{color:"var(--foreground)",fontWeight:600}}>{fmtH(summary.weekendTarget)}</span></div>
            <div className="barwrap"><div className="bar" style={{width:(summary.debt>0?Math.min(100,summary.madeUp/summary.debt*100):0)+"%"}}/></div>
          </div>}
        {summary.cleared && <div className="clear">◆ Debt paid in full. The week is settled.</div>}
      </Card>
      <Card>
        <div className="eyebrow" style={{marginBottom:14}}>Make-up Time</div>
        <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:34,fontWeight:600,minWidth:130,color:running?"var(--foreground)":"var(--muted-foreground)"}}>{fmtClock(elapsed)}</div>
          {!running ? <button className="solid" onClick={()=>{setRunning(Date.now());setNow(Date.now());}}>▶ Start stopwatch</button>
            : <><button className="solid" onClick={()=>{addSession(elapsed,"stopwatch");setRunning(null);}}>■ Stop &amp; log</button><button className="ghost" onClick={()=>setRunning(null)}>discard</button></>}
          <div style={{display:"flex",gap:6,marginLeft:"auto"}}>
            <input value={manual} onChange={e=>setManual(e.target.value)} inputMode="decimal" placeholder="1.5" className="inp" style={{width:64}}/>
            <button className="ghost" onClick={()=>{const h=parseFloat(manual);if(h>0){addSession(h,"manual");setManual("");}}}>+ log</button>
          </div>
        </div>
        {running && <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)",marginTop:8}}>auto-caps at {CONFIG.SESSION_CAP_H}h</div>}
        {sessions.length>0 && <div style={{marginTop:14}}>{sessions.map(s=>(
          <div key={s.id} className="sessrow"><span style={{color:"var(--muted-foreground)"}}>{new Date(s.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}<span className="badge">{s.source}</span></span>
          <span style={{display:"flex",gap:12,alignItems:"center"}}><b>{fmtH(s.hours)}</b><button className="x" onClick={()=>rm(s.id)}>×</button></span></div>
        ))}</div>}
      </Card>
    </>
  );
}
function Ledger({rows}){
  return (<div className="ledger">
    <div className="lhead"><span>Weekday</span><span className="r">Missed</span><span className="r">Status</span></div>
    {rows.map((r,i)=>{ const d=parseISO(r.date);
      return (<div key={r.date} className="lrow" style={{background:i%2?"var(--secondary)":"transparent"}}>
        <span>{d.toLocaleDateString(undefined,{weekday:"short"})} <span style={{color:"var(--muted-foreground)"}}>{r.date.slice(5)}</span></span>
        <span className="r">{r.missed===null?"—":r.missed===0?"0":"+"+fmtH(r.missed)}</span>
        <span className="r" style={{color:"var(--muted-foreground)"}}>{r.missed===null?"pending":r.missed===0?"✓ full":"owed"}</span>
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
  const shade=p=> p==null?"transparent": p===0?"var(--secondary)": "oklch("+(0.97-(p/100)*0.75)+" 0 0)";
  const txt=p=> p!=null&&p>55?"var(--background)":"var(--foreground)";
  return (
    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <h2 style={{margin:0,fontSize:18,fontWeight:700}}>The Record</h2>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <button className="ghost sm" onClick={()=>setCur(new Date(y,m-1,1))}>‹</button>
          <span style={{fontFamily:"var(--mono)",fontSize:13,minWidth:120,textAlign:"center"}}>{cur.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</span>
          <button className="ghost sm" onClick={()=>setCur(new Date(y,m+1,1))}>›</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:18}}>
        <Stat label="Monthly average" value={avg+"%"}/><Stat label="Win days ◆" value={String(wins)}/><Stat label="Days logged" value={String(pcts.length)}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:5}}>
        {["M","T","W","T","F","S","S"].map((d,i)=><div key={i} style={{textAlign:"center",fontFamily:"var(--mono)",fontSize:10,color:"var(--muted-foreground)",paddingBottom:4}}>{d}</div>)}
        {cells.map((d,i)=>{ if(d==null)return <div key={i}/>;
          const k=iso(new Date(y,m,d)); const e=state.days[k]; const p=e?dayPct(e.habits):null; const sel=k===viewDate;
          return (<button key={i} onClick={()=>{setViewDate(k);setTab("today");}} title={p!=null?p+"%":"no entry"} className="mcell" style={{background:shade(p),color:txt(p),border:sel?"2px solid var(--ring)":"1px solid var(--border)"}}>
            {d}{p!=null&&p>winPct && <span style={{position:"absolute",top:2,right:4,fontSize:8}}>◆</span>}</button>); })}
      </div>
      <div style={{display:"flex",gap:14,marginTop:14,fontFamily:"var(--mono)",fontSize:10.5,color:"var(--muted-foreground)",alignItems:"center"}}>
        <span>less</span>{[0.95,0.75,0.55,0.35,0.22].map((l,i)=><span key={i} style={{width:14,height:14,borderRadius:8,background:"oklch("+l+" 0 0)",border:"1px solid var(--border)"}}/>)}<span>more</span>
      </div>
    </Card>
  );
}

/* ===== QUESTS (20-hour skill system) =====
   Rule (deliberately simple):
     weekday  -> logged hours fill the quest bar only
     weekend  -> logged hours fill the quest bar AND add to that week's payback
   Study blocks are never auto-ticked; you tick those yourself.
   One quest is Active at a time; the rest sit in the queue. Detours count to the active quest. */
function Quests({state,api}){
  const quests=state.quests||[];
  const activeId=state.activeQuestId;
  const active=quests.find(q=>q.id===activeId)||null;
  const queue=quests.filter(q=>q.id!==activeId && !q.done);
  const doneList=quests.filter(q=>q.done && q.id!==activeId);
  const [name,setName]=useState("");
  const [manual,setManual]=useState("");
  const [running,setRunning]=useState(null);
  const [now,setNow]=useState(Date.now());
  const tick=useRef();
  useEffect(()=>{ if(running){ tick.current=setInterval(()=>setNow(Date.now()),200); return ()=>clearInterval(tick.current);} },[running]);

  const todayD=new Date();
  const weekend=isWeekend(todayD);
  const elapsed=running?(now-running)/3600000:0;

  const addQuest=()=>{ if(!name.trim())return; api.add(name); setName(""); };
  const logHours=(hours,source)=>{ if(active) api.logHours(active.id,hours,source); };

  return (
    <>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
          <h2 style={{margin:0,fontSize:18,fontWeight:700}}>Skill Quests</h2>
          <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>{QUEST_TARGET}h to competent</span>
        </div>
        <div style={{fontSize:12,color:"var(--muted-foreground)",marginBottom:18}}>
          One active quest. Everything you learn in service of it — detours included — counts toward its {QUEST_TARGET} hours.
        </div>

        {!active ? (
          <div className="note" style={{marginBottom:0}}>No active quest. Add a skill below and it becomes your quest.</div>
        ) : (
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <div style={{fontSize:20,fontWeight:700}}>{active.name}</div>
              <div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:600}}>
                {active.hours.toFixed(1)}<span style={{color:"var(--muted-foreground)",fontSize:14}}>/{QUEST_TARGET}h</span>
              </div>
            </div>
            <div className="barwrap" style={{height:10,marginTop:10}}>
              <div className="bar" style={{width:Math.min(100,(active.hours/QUEST_TARGET)*100)+"%"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)",marginTop:8}}>
              <span>{active.hours>=QUEST_TARGET ? "◆ competent · still logging" : fmtH(Math.round((QUEST_TARGET-active.hours)*10)/10)+" to competent"}</span>
              <span>{projectDays(active)}</span>
            </div>
          </>
        )}
      </Card>

      {active && (
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:12}}>
          <div className="eyebrow">Session Timer</div>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>
            {weekend ? "weekend · also pays debt" : "weekday · logs to quest only"}
          </div>
        </div>
        <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:34,fontWeight:600,minWidth:130,color:running?"var(--foreground)":"var(--muted-foreground)"}}>{fmtClock(elapsed)}</div>
          {!running
            ? <button className="solid" onClick={()=>{setRunning(Date.now());setNow(Date.now());}}>▶ Start session</button>
            : <><button className="solid" onClick={()=>{logHours(elapsed,"timer");setRunning(null);}}>■ Stop &amp; log</button>
                <button className="ghost" onClick={()=>setRunning(null)}>discard</button></>}
          <div style={{display:"flex",gap:6,marginLeft:"auto"}}>
            <input value={manual} onChange={e=>setManual(e.target.value)} inputMode="decimal" placeholder="1.5" className="inp" style={{width:64}}/>
            <button className="ghost" onClick={()=>{const h=parseFloat(manual); if(h>0){logHours(h,"manual"); setManual("");}}}>+ log</button>
          </div>
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)",marginTop:10,lineHeight:1.6}}>
          {weekend
            ? "Saturday/Sunday hours fill the quest bar and add to this week's payback."
            : "Weekday hours fill the quest bar only. Tick your study blocks yourself on Today."}
          {running && <> · auto-caps at {CONFIG.SESSION_CAP_H}h</>}
        </div>
        {(active.sessions||[]).length>0 && (
          <div style={{marginTop:14,maxHeight:180,overflowY:"auto"}}>
            {[...active.sessions].reverse().map(s=>(
              <div key={s.id} className="sessrow">
                <span style={{color:"var(--muted-foreground)"}}>
                  {new Date(s.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}
                  <span className="badge">{s.source}</span>{s.weekend && <span className="badge">payback</span>}
                </span>
                <b>{fmtH(s.hours)}</b>
              </div>
            ))}
          </div>
        )}
      </Card>)}

      <Card>
        <div className="eyebrow" style={{marginBottom:4}}>Queue</div>
        <div style={{fontSize:12,color:"var(--muted-foreground)",marginBottom:12}}>Skills waiting their turn. Add as many as you like — only one runs at a time.</div>
        {queue.length===0 && <div style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--muted-foreground)",padding:"6px 0"}}>— empty —</div>}
        {queue.map(q=>(
          <div key={q.id} className="listrow" style={{opacity:q.saving?.6:1}}>
            <span style={{flex:1,fontSize:13.5}}>{q.name}</span>
            {q.error && <span title="not saved to Notion" style={{color:"var(--destructive)",fontSize:12}}>!</span>}
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>{q.hours.toFixed(1)}h</span>
            <button className="ghost sm" onClick={()=>api.promote(q.id)}>make active</button>
            <button className="x" onClick={()=>api.remove(q.id)}>×</button>
          </div>
        ))}
        <div style={{display:"flex",gap:6,marginTop:12}}>
          <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addQuest()} placeholder="Add a skill — e.g. Laravel" className="inp" style={{flex:1}}/>
          <button className="ghost" onClick={addQuest}>+ add</button>
        </div>
      </Card>

      {doneList.length>0 && (
        <Card>
          <div className="eyebrow" style={{marginBottom:12}}>Competent ◆</div>
          {doneList.map(q=>(
            <div key={q.id} className="listrow">
              <span style={{flex:1,fontSize:13.5}}>{q.name}</span>
              <span style={{fontFamily:"var(--mono)",fontSize:12}}>{q.hours.toFixed(1)}/{QUEST_TARGET}h</span>
              <button className="ghost sm" onClick={()=>api.promote(q.id)}>resume</button>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
/* honest projection: how long 20h takes at your recent pace */
function projectDays(quest){
  const s=quest.sessions||[];
  if(s.length<2) return "pace: not enough data";
  const days=new Set(s.map(x=>x.at.slice(0,10))).size;
  const perDay=quest.hours/Math.max(1,days);
  const left=Math.max(0,QUEST_TARGET-quest.hours);
  if(perDay<=0) return "";
  return "≈ "+Math.ceil(left/perDay)+" more days at "+perDay.toFixed(1)+"h/day";
}

/* ===== SETTINGS (with slider) ===== */
function Settings({state,setState,winPct,sync,onPull}){
  const setWin=v=>setState(s=>({...s,winPct:v}));
  return (
    <>
      <Card>
        <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:700}}>Settings</h2>
        <div style={{fontSize:12,color:"var(--muted-foreground)",marginBottom:22}}>Tune the ledger to your standards.</div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
          <div className="eyebrow">Win-day threshold</div>
          <div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:600}}>{winPct}<span style={{fontSize:13,color:"var(--muted-foreground)"}}>%</span></div>
        </div>
        <div style={{fontSize:12,color:"var(--muted-foreground)",marginBottom:14}}>A day counts as a ◆ win when your daily % is above this line.</div>
        <Slider value={winPct} min={50} max={100} step={1} onChange={setWin}/>
        <div style={{display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:10.5,color:"var(--muted-foreground)",marginTop:8}}>
          <span>50%</span><span>lenient ← · → strict</span><span>100%</span>
        </div>
      </Card>
      <Card>
        <div className="eyebrow" style={{marginBottom:10}}>Notion Sync</div>
        <div style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--muted-foreground)",lineHeight:1.6}}>
          <div>status · <b style={{color:"var(--foreground)"}}>{sync.loading?"syncing…":sync.error?"error":"connected"}</b></div>
          <div>last pull · {sync.lastPull?new Date(sync.lastPull).toLocaleString():"—"}</div>
          {sync.error && <div style={{color:"var(--foreground)",marginTop:6}}>{sync.error}</div>}
        </div>
        <button className="ghost" style={{marginTop:14}} onClick={onPull}>↓ Pull latest from Notion</button>
      </Card>
    </>
  );
}
/* shadcn-style slider */
function Slider({value,min=0,max=100,step=1,onChange}){
  const ref=useRef(); const [drag,setDrag]=useState(false);
  const pct=((value-min)/(max-min))*100;
  const setFromClientX=cx=>{ const el=ref.current; if(!el)return; const r=el.getBoundingClientRect();
    let f=(cx-r.left)/r.width; f=Math.max(0,Math.min(1,f)); const raw=min+f*(max-min); const stepped=Math.round(raw/step)*step; onChange(Math.max(min,Math.min(max,stepped))); };
  useEffect(()=>{ if(!drag)return; const mv=e=>setFromClientX((e.touches?e.touches[0]:e).clientX); const up=()=>setDrag(false);
    window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up); window.addEventListener("touchmove",mv); window.addEventListener("touchend",up);
    return ()=>{ window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up); window.removeEventListener("touchmove",mv); window.removeEventListener("touchend",up); }; },[drag]);
  return (
    <div ref={ref} className="slider" onMouseDown={e=>{setDrag(true);setFromClientX(e.clientX);}} onTouchStart={e=>{setDrag(true);setFromClientX(e.touches[0].clientX);}}
      role="slider" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onKeyDown={e=>{ if(e.key==="ArrowLeft")onChange(Math.max(min,value-step)); if(e.key==="ArrowRight")onChange(Math.min(max,value+step)); }}>
      <div className="slider-track"><div className="slider-range" style={{width:pct+"%"}}/></div>
      <div className="slider-thumb" style={{left:pct+"%"}}/>
    </div>
  );
}

/* ===== shared ===== */
function Card({children,pad}){ return <section className="card" style={pad?{padding:16}:undefined}>{children}</section>; }
function Stat({label,value}){ return <div className="stat"><div className="statv">{value}</div><div className="eyebrow" style={{marginTop:3}}>{label}</div></div>; }
function Note({children}){ return <div className="note">⚠ {children}</div>; }
function DateNav({viewDate,setViewDate,today}){
  const d=parseISO(viewDate); const isToday=viewDate===today;
  return (<div style={{display:"flex",alignItems:"center",gap:8}}>
    <button className="ghost sm" onClick={()=>setViewDate(iso(addDays(d,-1)))}>‹</button>
    <div><div style={{fontSize:15,fontWeight:700}}>{isToday?"Today":d.toLocaleDateString(undefined,{weekday:"long"})}</div><div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted-foreground)"}}>{viewDate}</div></div>
    <button className="ghost sm" onClick={()=>setViewDate(iso(addDays(d,1)))}>›</button>
    {!isToday && <button className="ghost sm" onClick={()=>setViewDate(today)}>today</button>}
  </div>);
}
function fmtClock(h){ const t=Math.floor(h*3600); const p=n=>String(n).padStart(2,"0"); return p(Math.floor(t/3600))+":"+p(Math.floor(t%3600/60))+":"+p(t%60); }

const THEME = { "--sans":"'Inter',system-ui,sans-serif", "--mono":"'IBM Plex Mono','SF Mono',Menlo,monospace" };
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
.light { --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --card: oklch(1 0 0); --primary: oklch(0.205 0 0); --primary-foreground: oklch(0.985 0 0); --secondary: oklch(0.97 0 0); --muted-foreground: oklch(0.556 0 0); --border: oklch(0.922 0 0); --input: oklch(0.922 0 0); --ring: oklch(0.708 0 0); --chart-2: oklch(0.556 0 0); --chart-5: oklch(0.269 0 0); --radius: 1rem; --destructive: oklch(0.577 0.245 27.325); }
.dark { --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); --card: oklch(0.205 0 0); --primary: oklch(0.922 0 0); --primary-foreground: oklch(0.205 0 0); --secondary: oklch(0.269 0 0); --muted-foreground: oklch(0.708 0 0); --border: oklch(1 0 0 / 10%); --input: oklch(1 0 0 / 15%); --ring: oklch(0.556 0 0); --chart-2: oklch(0.556 0 0); --chart-5: oklch(0.87 0 0); --radius: 1rem; --destructive: oklch(0.704 0.191 22.216); }
* { box-sizing:border-box; }
.morphword { animation-duration:.72s; animation-timing-function:ease-in-out; animation-fill-mode:both; will-change:filter,opacity; }
.morphword.in { animation-name:morphIn; } .morphword.out { animation-name:morphOut; }
@keyframes morphIn { 0%{filter:blur(18px);opacity:0;} 45%{filter:blur(6px);opacity:.4;} 100%{filter:blur(0);opacity:1;} }
@keyframes morphOut { 0%{filter:blur(0);opacity:1;} 55%{filter:blur(6px);opacity:.4;} 100%{filter:blur(18px);opacity:0;} }
@keyframes shimmer { 0%{background-position:-400px 0;} 100%{background-position:400px 0;} }
@media (prefers-reduced-motion:reduce){ .morphword{animation:none!important;} .morphword.out{opacity:0!important;} .morphword.in{opacity:1!important;filter:none!important;} .skel{animation:none!important;} }
button { font-family:inherit; cursor:pointer; color:inherit; }
button:disabled { opacity:.5; cursor:default; }
button:focus-visible, input:focus-visible, .slider:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
/* Fills the viewport instead of a narrow centred column — the 960px cap made a
   laptop screen look like a phone mock-up with dead margins either side. */
.shell { width:100%; padding:26px clamp(18px,2.6vw,44px) 72px; }
.eyebrow { font-family:var(--mono); font-size:10.5px; letter-spacing:2px; text-transform:uppercase; color:var(--muted-foreground); }
.card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:22px; margin-bottom:16px; }
@media (max-width:640px){ .lists-grid{ grid-template-columns:1fr!important; } }
.tabs { display:flex; gap:2px; border-bottom:1px solid var(--border); margin-bottom:20px; }
.tab { background:none; border:none; padding:9px 16px; font-size:13.5px; font-weight:600; color:var(--muted-foreground); border-bottom:2px solid transparent; margin-bottom:-1px; }
.tab.on { color:var(--foreground); border-bottom-color:var(--foreground); }
.study { background:var(--secondary); border-radius:var(--radius); padding:16px; }
.block { text-align:left; border:1px solid var(--border); background:var(--card); border-radius:12px; padding:11px; color:var(--muted-foreground); transition:.12s; }
.block.on { background:var(--primary); color:var(--primary-foreground); border-color:var(--primary); }
.habit { display:flex; align-items:center; gap:10px; border:1px solid var(--border); background:var(--card); border-radius:12px; padding:11px 12px; text-align:left; transition:.12s; }
.habit.on { border-color:var(--foreground); }
.box { width:18px; height:18px; border-radius:8px; flex-shrink:0; border:1.5px solid var(--muted-foreground); display:grid; place-items:center; font-size:12px; color:transparent; }
.box.on { background:var(--foreground); border-color:var(--foreground); color:var(--background); }
.box.sm { width:16px; height:16px; border-radius:8px; font-size:10px; }
.listrow { display:flex; align-items:center; gap:9px; padding:7px 0; border-bottom:1px solid var(--border); }
.listrow:last-child { border-bottom:none; }
.inp { background:var(--background); border:1px solid var(--input); border-radius:12px; padding:7px 9px; font-size:13px; color:var(--foreground); font-family:var(--sans); outline:none; }
.inp:focus { border-color:var(--ring); }
.x { border:none; background:none; color:var(--destructive); font-size:16px; line-height:1; padding:0 2px; }
.linkbtn { border:none; background:none; color:var(--foreground); text-decoration:underline; font-family:var(--mono); font-size:11.5px; padding:0; }
.day { border:1px solid var(--border); background:var(--card); border-radius:12px; padding:8px 4px; text-align:center; transition:.12s; }
.day.sel { border:2px solid var(--ring); } .day.wknd { background:var(--secondary); }
.stat { background:var(--secondary); border-radius:12px; padding:12px 14px; }
.statv { font-family:var(--mono); font-size:22px; font-weight:600; }
.ledger { border:1px solid var(--border); border-radius:12px; overflow:hidden; }
.lhead, .lrow { display:grid; grid-template-columns:1.4fr 1fr 1fr; font-family:var(--mono); font-size:13px; }
.lhead { background:var(--secondary); font-size:10.5px; letter-spacing:1px; text-transform:uppercase; color:var(--muted-foreground); }
.lhead span, .lrow span { padding:9px 14px; } .lrow span { border-top:1px solid var(--border); } .r { text-align:right; }
.barwrap { height:8px; background:var(--secondary); border-radius:8px; margin-top:10px; overflow:hidden; }
.bar { height:100%; background:var(--foreground); transition:width .3s; }
.clear { margin-top:18px; border:1px solid var(--border); background:var(--secondary); border-radius:12px; padding:14px; text-align:center; font-weight:600; }
.note { font-family:var(--mono); font-size:11.5px; color:var(--muted-foreground); background:var(--secondary); border-radius:12px; padding:8px 12px; margin-bottom:12px; }
.solid { border:1px solid var(--primary); background:var(--primary); color:var(--primary-foreground); border-radius:12px; padding:9px 16px; font-size:13.5px; font-weight:600; font-family:var(--mono); }
.ghost { border:1px solid var(--border); background:var(--card); border-radius:12px; padding:8px 12px; font-size:12.5px; font-weight:600; font-family:var(--mono); }
.ghost.sm { padding:5px 10px; font-size:12px; }
.ghost.hot { border-color:var(--foreground); color:var(--foreground); }
.sessrow { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12.5px; }
.badge { margin-left:8px; font-size:10px; padding:1px 6px; border-radius:8px; background:var(--secondary); color:var(--muted-foreground); }
.mcell { aspect-ratio:1; border-radius:12px; font-family:var(--mono); font-size:12px; font-weight:600; display:grid; place-items:center; position:relative; transition:.12s; }
.skel { position:relative; overflow:hidden; background:var(--secondary); }
.skel::after { content:""; position:absolute; inset:0; background:linear-gradient(90deg,transparent,var(--border),transparent); background-size:800px 100%; animation:shimmer 1.3s infinite linear; }
.slider { position:relative; height:22px; display:flex; align-items:center; cursor:pointer; touch-action:none; }
.slider-track { width:100%; height:6px; background:var(--secondary); border-radius:999px; overflow:hidden; }
.slider-range { height:100%; background:var(--foreground); }
.slider-thumb { position:absolute; width:18px; height:18px; border-radius:999px; background:var(--background); border:2px solid var(--foreground); transform:translateX(-50%); top:2px; }
`;
