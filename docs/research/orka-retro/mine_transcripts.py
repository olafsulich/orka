# Usage: python3 -I mine_transcripts.py out.jsonl  (streams ~/.claude/projects/*orca-worktrees*/*.jsonl)
import json,os,re,glob,sys,collections
root=os.path.expanduser('~/.claude/projects')
PAT={'cmd_not_found':re.compile(r'command not found|: not found\b|ENOENT.*(ffmpeg|node|npx)'),
 'enospc':re.compile(r'No space left|ENOSPC'),
 'killed':re.compile(r'\bKilled\b|signal 9|SIGKILL|out of memory|OOM',re.I),
 'http401':re.compile(r'\b401\b.{0,40}(Unauthorized|auth)|Unauthorized.{0,20}401',re.I),
 'rate':re.compile(r'rate.?limit|overloaded_error|529',re.I),
 'perm_denied':re.compile(r'Permission denied|EACCES'),
 'blocked_tool':re.compile(r"requires approval|was blocked|permission to (read|use)|outside (of )?the (allowed|working)",re.I),
 'timeout':re.compile(r'timed out|Command timed out',re.I)}
EDIT={'Edit','Write','MultiEdit','NotebookEdit'}
out=open(sys.argv[1],'w')
for d in sorted(os.listdir(root)):
    m=re.match(r'-home-olaf-projects-([a-z-]+?)--orca-worktrees-(\d{17})-(.*)',d)
    if not m: continue
    proj,jid=m.group(1),m.group(2)
    for f in glob.glob(os.path.join(root,d,'*.jsonl')):
        turns=0;tools=collections.Counter();hits=collections.Counter();first_edit=None;bash_before=0;errs=0;first_user='';model='';inp=out_t=cr=cw=0;seen=set()
        with open(f,errors='replace') as fh:
            for line in fh:
                try: e=json.loads(line)
                except: continue
                t=e.get('type')
                msg=e.get('message') or {}
                if t=='assistant':
                    mid=msg.get('id')
                    if mid not in seen:
                        seen.add(mid);turns+=1;u=msg.get('usage') or {}
                        inp+=u.get('input_tokens',0);out_t+=u.get('output_tokens',0);cr+=u.get('cache_read_input_tokens',0);cw+=u.get('cache_creation_input_tokens',0)
                        model=msg.get('model',model)
                    for c in msg.get('content') or []:
                        if isinstance(c,dict) and c.get('type')=='tool_use':
                            n=c.get('name');tools[n]+=1
                            if n in EDIT and first_edit is None: first_edit=turns
                            if n=='Bash' and first_edit is None: bash_before+=1
                elif t=='user':
                    cont=msg.get('content')
                    if isinstance(cont,str):
                        if not first_user: first_user=cont[:150]
                        continue
                    for c in cont or []:
                        if not isinstance(c,dict): continue
                        if c.get('type')=='text' and not first_user: first_user=c.get('text','')[:150]
                        if c.get('type')=='tool_result':
                            txt=c.get('content')
                            if isinstance(txt,list): txt=' '.join(x.get('text','') for x in txt if isinstance(x,dict))
                            txt=str(txt)[:4000]
                            if c.get('is_error'): errs+=1
                            for k,p in PAT.items():
                                if p.search(txt): hits[k]+=1
        role=re.search(r'You are (?:the |a |an )?([a-z-]+)',first_user,re.I)
        out.write(json.dumps(dict(proj=proj,job=jid,slug=m.group(3),f=os.path.basename(f),turns=turns,tools=dict(tools),hits=dict(hits),first_edit=first_edit,bash_before=bash_before,errs=errs,model=model,role=(role.group(1) if role else ''),first=first_user.replace('\n',' '),cr=cr,cw=cw,out=out_t,inp=inp))+'\n')
