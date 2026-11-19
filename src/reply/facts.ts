import { h } from '../ui/dom';
export const FACTS = 'xck:reply-facts';
export type FactKey = 'project' | 'role' | 'other';
export type Fact = { key: FactKey; question: string; answer: string; updated: string };
export type Question = { key: FactKey; question: string };
export function facts(value: unknown): Fact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,10).filter((f):f is Fact => f && ['project','role','other'].includes(f.key) && typeof f.question==='string' && f.question.length>0 && f.question.length<=240 && typeof f.answer==='string' && f.answer.trim().length>0 && f.answer.length<=500 && typeof f.updated==='string' && /^\d{4}-\d{2}-\d{2}$/.test(f.updated)).map(f=>({key:f.key,question:f.question,answer:f.answer,updated:f.updated}));
}
// Common personal questions are caught before any model call. Other fact gaps are
// returned by the model; semantic completeness still requires real-model evaluation.
export function personalQuestion(post: string): Question | null {
  if (/\bwhat (?:are you|r u) (?:building|working on)\b|\bwhat(?:'s| is) your (?:project|startup)\b/i.test(post)) return {key:'project',question:'What are you working on? A few words is enough.'};
  if (/\bwhat (?:do you do for (?:work|a living)|is your (?:job|role))\b/i.test(post)) return {key:'role',question:'What do you do for work?'};
  const numeric=post.match(/\bhow (?:much|many)\b[^?\n]{0,100}\b(?:you|your)\b|\b(?:your|u?r)\s+(?:mrr|revenue|income|salary)\b/i);
  if (numeric) return {key:'other',question:`What is your actual answer to “${post.slice(numeric.index).split(/[?\n]/)[0]!.slice(0,180)}”?`};
  const addressed = post.match(/\b(?:what|which|who|where|when|why|how|do|did|have|are|would|could|can)\b[^.!?\n]{0,180}\b(?:you|your)\b[^.!?\n]{0,80}\?/i)
    ?? post.match(/\b(?:tell|show|share)\b[^.!?\n]{0,80}\b(?:you|your)\b[^.!?\n]{0,120}/i);
  if (addressed) return { key: 'other', question: addressed[0].slice(0,240) };
  return null;
}
export function factStore(say:(s:string)=>void, changed:()=>void) {
  let saved:Fact[]=[];
  const list=h('div');
  const element=h('details',{class:'reply-facts'},h('summary',{},'About me'),h('p',{class:'reply-muted'},'Only answers you choose to remember. Confirm them before reuse.'),list);
  async function mutate(change:(latest:Fact[])=>Fact[]) {
    await navigator.locks.request(FACTS,async()=>{
      const latest=facts((await chrome.storage.local.get(FACTS))[FACTS]);
      const next=change(latest);await chrome.storage.local.set({[FACTS]:next});saved=next;render();
    });
  }
  function render() {
    list.replaceChildren(...saved.map(f=>{
      const remove=h('button',{type:'button','aria-label':`Forget ${f.question}`},'Forget');
      remove.addEventListener('click',()=>{ void mutate(latest=>latest.filter(x=>!(x.key===f.key && x.question===f.question && x.answer===f.answer))).then(()=>say('Remembered answer removed.'),()=>say('Could not forget this answer. Try again.')); });
      return h('div',{class:'reply-fact'},h('strong',{},f.question),h('p',{},f.answer),h('small',{},`Saved ${f.updated} UTC`),remove);
    }));
    if(!saved.length)list.append(h('p',{class:'reply-muted'},'Nothing remembered yet.'));
  }
  render();
  return {element,load(value:unknown){saved=facts(value);render();changed();},find(q:Question){return saved.find(f=>q.key==='other'? f.question===q.question:f.key===q.key);},async remember(q:Question,answer:string){
    const fact:Fact={...q,answer:answer.trim(),updated:new Date().toISOString().slice(0,10)};
    if(!facts([fact]).length)throw new Error('Answer is too long.');
    await mutate(latest=>[fact,...latest.filter(f=>q.key==='other'? f.question!==q.question:f.key!==q.key)].slice(0,10));
  }};
}
