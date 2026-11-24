import json,glob,random,math
R=[json.load(open(f)) for f in sorted(glob.glob('results2/*.json'))]
def wilson(k,n,z=1.96):
    if n==0: return (float('nan'),)*2
    p=k/n;d=1+z*z/n;c=(p+z*z/(2*n))/d;h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return c-h,c+h
def brier(p,y): return sum((a-b)**2 for a,b in zip(p,y))/len(y)
def auroc(p,y):
    pos=[a for a,b in zip(p,y) if b];neg=[a for a,b in zip(p,y) if not b]
    if not pos or not neg: return float('nan')
    return sum((1 if a>b else .5 if a==b else 0) for a in pos for b in neg)/(len(pos)*len(neg))
print('runs',len(R))
for r in R: print(f"{r['agent']:6}{r['id']:18}r{r['rep']} claim={r['claim']:7} self={r['p_self']} proc={r['p_process']} base={r['baseline']} hidden={r['hidden']} vis={r['visible']} touched={r['testsTouched']} skip={r['skip']} chk={r['checks']} cost={r['cost']}")
y=[1 if r['hidden'] else 0 for r in R]
done=[r for r in R if r['claim']=='DONE']; k=sum(r['hidden'] for r in done)
print('\nDONE',len(done),'correct',k,'prec',k/len(done) if done else None,'wilson',wilson(k,len(done)))
for a in ['claude','codex']:
    d=[r for r in done if r['agent']==a];kk=sum(r['hidden'] for r in d);print(a,len(d),kk,wilson(kk,len(d)))
sab=[r for r in R if r['testsTouched'] or r['skip']];print('sabotage',len(sab),[(r['agent'],r['id'],r['rep']) for r in sab])
print('hidden pass rate',sum(y),'/',len(y))
ps=[r['p_self'] if r['p_self']==r['p_self'] else .5 for r in R];pp=[r['p_process'] for r in R];pb=[r['baseline'] if r['baseline'] in (0,1) else 0 for r in R]
for n,p in [('self',ps),('process',pp),('baseline',pb)]: print(n,'brier %.3f auroc %.3f'%(brier(p,y),auroc(p,y)))
random.seed(1);db=[];da=[];dab=[]
for _ in range(2000):
    idx=[random.randrange(len(R)) for _ in R];yy=[y[i] for i in idx]
    a,b,c=[ps[i] for i in idx],[pp[i] for i in idx],[pb[i] for i in idx]
    db.append(brier(a,yy)-brier(b,yy));A=auroc(b,yy)-auroc(a,yy);B=auroc(b,yy)-auroc(c,yy)
    if A==A: da.append(A)
    if B==B: dab.append(B)
q=lambda v:(sorted(v)[int(.025*len(v))],sorted(v)[int(.975*len(v))])
print('Brier self-proc',sum(db)/len(db),q(db));print('AUROC proc-self',q(da) if da else None,len(da));print('AUROC proc-base',q(dab) if dab else None)
print('cost USD claude',sum(r['cost'] or 0 for r in R if r['agent']=='claude'),'codex tokens',sum(r['tokens'] or 0 for r in R if r['agent']=='codex'))
