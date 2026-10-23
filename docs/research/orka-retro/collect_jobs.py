# Usage: python3 -I collect_jobs.py out.json  (reads ~/projects/*/.orca/jobs/*.json)
import json,glob,os,sys,collections,datetime as dt
def t(s):
    try: return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
    except: return None
rows=[]
for p in sorted(glob.glob(os.path.expanduser('~/projects/*/.orca/jobs/*.json'))):
    if p.endswith('.finish.json'): continue
    d=json.load(open(p)); proj=p.split('/')[4]
    fin=p[:-5]+'.finish.json'; f=json.load(open(fin)) if os.path.exists(fin) else {}
    v=d.get('verifier') or {}
    hist=v.get('history') or []
    a,b=t(d.get('started') or d.get('created') or ''),t(d.get('finished') or '')
    wall=(b-a).total_seconds()/60 if a and b else None
    att=f.get('attempts') or []
    rows.append(dict(proj=proj,id=d['id'],status=d['status'],stop=(d.get('stopReason') or '')[:80].replace('\n',' '),
      kind=d.get('kind'),model=d.get('model'),wmodel=d.get('workerModel'),layout=d.get('workerLayout'),
      workers=len(d.get('workers') or []),steers=len(d.get('steers') or []),
      vrounds=v.get('rounds'),verdict=v.get('verdict'),first=(hist[0]['verdict'] if hist else None),
      stall=bool(v.get('stall')),stale=v.get('stale'),strat=len(v.get('strategyChanges') or []),
      verify=(d.get('verify') or {}).get('status'),frounds=len(d.get('finishRounds') or []),
      followup=sum(1 for r in f.get('rounds',[]) if r.get('followUp')),
      wake=';'.join(f"{x.get('outcome')}:{x.get('http')}" for x in att),
      wall=round(wall,1) if wall else None,jobType=d.get('jobType'),playbook=d.get('playbook'),
      created=d.get('created','')[:10]))
json.dump(rows,open(sys.argv[1],'w'))
print(len(rows))
